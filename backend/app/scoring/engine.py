"""综合评分引擎（手册 §四.1 黄金判定规则）。

判定哲学：S_Bio 衡量"残差里有没有生理特征"。完美机器残差≈0 → 平滑否决；
粗糙机器残差是宽带白噪（无 8-12Hz 结构、零交叉异常）→ 子分低。

Composite = 0.6·S_DTW + 0.4·S_Bio
S_Bio     = 0.35·energy + 0.30·zc + 0.35·tremor(amp+psd)
阈值 0.8；残差能量≈0 → 平滑否决（S_Bio=0.05, Composite 封顶 0.20）。

issue #7 后端风控（docs/issue7.md §三）追加两道一票否决：
  - 周期性伪噪点否决：Math.sin() 注入的 8-12Hz「伪震颤」自相关不衰减、频谱单峰；
  - 等差时间戳否决：按 fps 公式步进的时间戳 Δt 变异系数≈0。
两者触发即与平滑否决同级封顶 composite。
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
    # issue #7 后端风控否决标志与特征
    periodic_veto: bool = False
    arithmetic_ts_veto: bool = False
    acf_envelope_decay: float = 0.0
    spectral_flatness_8_12: float = 0.0
    dt_cv: float = 0.0
    # issue #10 后端风控否决标志与特征（docs/debug10.md）
    # - 轴向非对称震颤否决：脚本式 X/Y 同幅度对称加噪（pastebin / phantom-solver）
    axial_asymmetry_veto: bool = False
    axial_tremor_ratio: float = 0.0
    axial_tremor_amp_x: float = 0.0
    axial_tremor_amp_y: float = 0.0
    # - 子像素尾数退化否决：Math.round()/整数公式导致的尾数坍缩
    subpixel_veto: bool = False
    subpixel_entropy_x: float = 0.0
    subpixel_entropy_y: float = 0.0
    # - 最小人类响应时长下限否决：离线高速合成
    min_duration_veto: bool = False
    duration_ms: float = 0.0
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
        periodic_veto=False, arithmetic_ts_veto=False,
        acf_envelope_decay=0.0, spectral_flatness_8_12=0.0, dt_cv=0.0,
        axial_asymmetry_veto=False, axial_tremor_ratio=0.0,
        axial_tremor_amp_x=0.0, axial_tremor_amp_y=0.0,
        subpixel_veto=False, subpixel_entropy_x=0.0, subpixel_entropy_y=0.0,
        min_duration_veto=False, duration_ms=0.0,
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

    # 4) issue #7 后端风控否决（docs/issue7.md §三）
    #    a) 周期性伪噪点：残差自相关不衰减 + 8-12Hz 频谱单峰
    #    b) 等差时间戳：原始采集 Δt 变异系数≈0
    rx, ry = ux - fx, uy - fy
    resid_pick = rx if np.var(rx) >= np.var(ry) else ry
    acf_decay = dsp.acf_envelope_decay(resid_pick, config.DSP_SAMPLE_HZ)
    sfm = dsp.spectral_flatness_band(
        resid_pick, config.DSP_SAMPLE_HZ, config.TREMOR_LO_HZ, config.TREMOR_HI_HZ
    )
    dt_cv = dsp.timestamp_dispersity(ts_ms)
    periodic_veto = (
        config.PERIODIC_VETO_ENABLED
        and not smoothness_veto
        and acf_decay >= config.PERIODIC_ACF_DECAY_MIN
        and sfm <= config.PERIODIC_SFM_MAX
    )
    arithmetic_ts_veto = (
        config.ARITHMETIC_TS_VETO_ENABLED and dt_cv < config.ARITHMETIC_TS_CV_MIN
    )

    # 5) issue #10 后端风控否决（docs/debug10.md §二）
    #    a) 轴向非对称震颤：脚本式 X/Y 同幅度对称加噪（pastebin / phantom-solver）。
    #       两轴 8-12Hz 带通振幅比≈1.0 → 全向均匀加噪 → 一票否决。仅在两轴都达到
    #       最小震颤幅度时才校验（避免对接近平滑、已被 smoothness_veto 兜底的轨迹误判）。
    axial_ratio, axial_amp_x, axial_amp_y = dsp.axial_tremor_ratio(rx, ry, config.DSP_SAMPLE_HZ)
    axial_asymmetry_veto = (
        config.AXIAL_ASYMMETRY_VETO_ENABLED
        and not smoothness_veto
        and axial_amp_x >= config.AXIAL_TREMOR_AMP_MIN
        and axial_amp_y >= config.AXIAL_TREMOR_AMP_MIN
        and axial_ratio <= config.AXIAL_TREMOR_RATIO_MIN
    )
    #    b) 子像素尾数退化：Math.round()/整数公式生成的坐标尾数坍缩到极少桶。
    #       在【原始采集】坐标上算（非上采样网格），样本足够时才校验。
    sub_entropy_x = dsp.subpixel_tail_entropy(xs, config.SUBPIXEL_BINS)
    sub_entropy_y = dsp.subpixel_tail_entropy(ys, config.SUBPIXEL_BINS)
    subpixel_veto = (
        config.SUBPIXEL_VETO_ENABLED
        and xs.size >= config.SUBPIXEL_MIN_POINTS
        and (sub_entropy_x < config.SUBPIXEL_ENTROPY_MIN
             or sub_entropy_y < config.SUBPIXEL_ENTROPY_MIN)
    )
    #    c) 最小人类响应时长下限：整体耗时 < MIN_HUMAN_DURATION_MS → 离线高速合成。
    duration_ms = float(ts_ms[-1] - ts_ms[0]) if ts_ms.size >= 2 else 0.0
    min_duration_veto = duration_ms < config.MIN_HUMAN_DURATION_MS

    composite = config.W_DTW * s_dtw + config.W_BIO * s_bio
    # 任意一道一票否决触发 → composite 封顶到 SMOOTHNESS_CAP，阻断脚本。
    if (
        smoothness_veto
        or arithmetic_ts_veto
        or periodic_veto
        or axial_asymmetry_veto
        or subpixel_veto
        or min_duration_veto
    ):
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
        periodic_veto=periodic_veto,
        arithmetic_ts_veto=arithmetic_ts_veto,
        acf_envelope_decay=round(float(acf_decay), 4),
        spectral_flatness_8_12=round(float(sfm), 4),
        dt_cv=round(float(dt_cv), 4),
        axial_asymmetry_veto=axial_asymmetry_veto,
        axial_tremor_ratio=round(float(axial_ratio), 4),
        axial_tremor_amp_x=round(float(axial_amp_x), 4),
        axial_tremor_amp_y=round(float(axial_amp_y), 4),
        subpixel_veto=subpixel_veto,
        subpixel_entropy_x=round(float(sub_entropy_x), 4),
        subpixel_entropy_y=round(float(sub_entropy_y), 4),
        min_duration_veto=min_duration_veto,
        duration_ms=round(duration_ms, 3),
        extras={},
    )


def breakdown_to_dict(b: ScoreBreakdown) -> dict:
    d = asdict(b)
    return d
