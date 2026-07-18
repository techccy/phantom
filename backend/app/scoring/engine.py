"""综合评分引擎（手册 §四.1 黄金判定规则）。

判定哲学：S_Bio 衡量"残差里有没有生理特征"。完美机器残差≈0 → 平滑否决；
粗糙机器残差是宽带白噪（无 8-12Hz 结构、零交叉异常）→ 子分低。

Composite = 0.6·S_DTW + 0.4·S_Bio
S_Bio     = 0.35·energy + 0.30·zc + 0.35·tremor(amp+psd)
阈值 0.8；残差能量≈0 → 平滑否决（S_Bio=0.05, Composite 封顶 0.20）。
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

from .. import config
from . import dsp, dtw


@dataclass
class ScoreBreakdown:
    composite: float
    s_dtw: float
    s_bio: float
    residual_energy: float
    jerk_variance: float
    accel_zerocrossings: int
    tremor_amplitude_px: float
    psd_8_12_ratio: float
    energy_score: float
    zc_score: float
    tremor_score: float
    smoothness_veto: bool
    passed: bool
    extras: dict = field(default_factory=dict)


def _energy_score(residual_energy: float) -> float:
    """残差能量映射。过小(<ENERGY_MIN)≈过度平滑→0；落入 ENERGY_LOW~HIGH 生理区间→高；
    过大(>ENERGY_MAX)≈粗糙人工噪声→急剧归零。

    手册 §三.3：人类高频微抖 0.3~8px；完美机器 <0.05px；粗糙机器 >20px。
    """
    if residual_energy < config.ENERGY_MIN:
        return 0.0
    if residual_energy < config.ENERGY_LOW:
        return (residual_energy - config.ENERGY_MIN) / (config.ENERGY_LOW - config.ENERGY_MIN)  # 0→1 缓升
    if residual_energy <= config.ENERGY_HIGH:
        return 1.0
    if residual_energy <= config.ENERGY_MAX:
        return 1.0 - (residual_energy - config.ENERGY_HIGH) / (config.ENERGY_MAX - config.ENERGY_HIGH)  # 1→0 线性衰减
    return 0.0


def _zc_score(zc: int, duration_s: float) -> float:
    """加速度零交叉（手册 §三.3）。

    人类：3 秒拖拽 ≥5 次（反馈纠偏循环），但不会上百次。
    机器：≤1 次（过度平滑），或异常高（宽带白噪符号随机翻转，≈fs 级）。
    → 钟形映射：[ZC_RISE, ZC_PLATEAU] 次区间满分，过低/过高都降权。
    """
    rate = zc / max(duration_s, 1e-3)  # 次/秒
    if rate < config.ZC_FLOOR:
        return 0.0
    if rate < config.ZC_RISE:
        return (rate - config.ZC_FLOOR) / (config.ZC_RISE - config.ZC_FLOOR) * 0.5
    if rate <= config.ZC_PLATEAU:  # 人类反馈纠偏区间
        return 1.0
    if rate <= config.ZC_DROP:  # 缓降
        return 1.0 - (rate - config.ZC_PLATEAU) / (config.ZC_DROP - config.ZC_PLATEAU) * 0.5
    return 0.0  # >ZC_DROP：白噪式翻转，判机器


def _tremor_score(amp: float, ratio: float) -> float:
    """生理频段震颤综合：振幅(生理区间) + 频谱占比。"""
    # 振幅子分
    if amp < config.TREMOR_AMP_MIN:
        amp_s = 0.0
    elif amp <= config.TREMOR_AMP_LOW:
        amp_s = 0.3 * (amp / config.TREMOR_AMP_LOW)
    elif amp <= config.TREMOR_AMP_HIGH:
        amp_s = 1.0
    elif amp <= config.TREMOR_AMP_MAX:
        amp_s = 1.0 - (amp - config.TREMOR_AMP_HIGH) / (config.TREMOR_AMP_MAX - config.TREMOR_AMP_HIGH) * 0.7
    else:
        amp_s = 0.3
    # 功率占比子分：占比 TREMOR_PSD_MIN~TREMOR_PSD_LOW 为健康；过低(无结构)/过高(人工窄带)降权
    if ratio <= config.TREMOR_PSD_MIN:
        ratio_s = ratio / config.TREMOR_PSD_MIN * 0.5
    elif ratio <= config.TREMOR_PSD_LOW:
        ratio_s = min(1.0, 0.5 + (ratio - config.TREMOR_PSD_MIN) / config.TREMOR_PSD_MID * 0.5)
    else:
        ratio_s = max(0.0, 0.8 - (ratio - config.TREMOR_PSD_LOW))
    return config.W_TREMOR_AMP * amp_s + config.W_TREMOR_PSD * ratio_s


def score_trajectory(
    xs,
    ys,
    ts_ms,
    bezier_control_points: list[tuple[float, float]],
    canvas_w: float,
    canvas_h: float,
) -> ScoreBreakdown:
    """完整评分入口。返回带明细的 ScoreBreakdown。"""
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    ts_ms = np.asarray(ts_ms, dtype=np.float64)

    veto_extras = dict(
        composite=0.0, s_dtw=0.0, s_bio=0.0,
        residual_energy=0.0, jerk_variance=0.0, accel_zerocrossings=0,
        tremor_amplitude_px=0.0, psd_8_12_ratio=0.0,
        energy_score=0.0, zc_score=0.0, tremor_score=0.0,
        smoothness_veto=False, passed=False,
    )

    if xs.size < config.MIN_POINTS:
        d = dict(veto_extras)
        d["extras"] = {"reason": "insufficient_points", "n_points": int(xs.size)}
        d["passed"] = False
        return ScoreBreakdown(**d)

    # 1) 预处理：均匀上采样 + 滤波 + 残差特征
    ux, uy, t_grid = dsp.resample_uniform(xs, ys, ts_ms, fs=config.DSP_SAMPLE_HZ)
    bio, fx, fy = dsp.extract_bio_features(ux, uy, fs=config.DSP_SAMPLE_HZ)
    duration_s = float(t_grid[-1]) if t_grid.size else 1.0

    e_score = _energy_score(bio.residual_energy)
    zc_score = _zc_score(bio.accel_zerocrossings, duration_s)
    t_score = _tremor_score(bio.tremor_amplitude_px, bio.psd_8_12_ratio)

    # 2) 平滑否决（手册 §四.1：σ²_jerk≈0 即残差能量≈0）
    smoothness_veto = bio.residual_energy < config.SMOOTHNESS_JERK_EPS
    if smoothness_veto:
        s_bio = config.SMOOTHNESS_BIO
    else:
        s_bio = (
            config.W_JERK * e_score
            + config.W_ZC * zc_score
            + config.W_PSD * t_score
        )
        s_bio = max(0.0, min(1.0, s_bio))

    # 3) DTW 方向拟合（在低通自愿运动上）
    user_xy = np.column_stack([fx, fy])
    bezier_pts = dtw.sample_bezier(bezier_control_points, num=256)
    s_dtw = dtw.score_dtw(user_xy, bezier_pts, canvas_w, canvas_h, d_ref_ratio=config.DTW_D_REF_RATIO)

    composite = config.W_DTW * s_dtw + config.W_BIO * s_bio
    if smoothness_veto:
        composite = min(composite, config.SMOOTHNESS_CAP)

    return ScoreBreakdown(
        composite=round(composite, 4),
        s_dtw=round(s_dtw, 4),
        s_bio=round(s_bio, 4),
        residual_energy=float(bio.residual_energy),
        jerk_variance=float(bio.jerk_variance),
        accel_zerocrossings=int(bio.accel_zerocrossings),
        tremor_amplitude_px=float(bio.tremor_amplitude_px),
        psd_8_12_ratio=float(bio.psd_8_12_ratio),
        energy_score=round(e_score, 4),
        zc_score=round(zc_score, 4),
        tremor_score=round(t_score, 4),
        smoothness_veto=smoothness_veto,
        passed=composite >= config.PASS_THRESHOLD,
        extras={},
    )


def breakdown_to_dict(b: ScoreBreakdown) -> dict:
    d = asdict(b)
    return d
