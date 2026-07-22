"""评分引擎测试：合成"人类"与"机器"轨迹，验证判定边界。

人类轨迹：跟随贝塞尔 + 0.3~8px 随机抖动 + 8-12Hz 微震颤 + 多次加速度过零
         + 末端制动纠偏 → Composite 应 > 0.8 通过。
机器轨迹：精确贝塞尔（过度平滑，jerk≈0）→ 触发平滑否决，Composite ≤ 0.20。
噪声机器：贝塞尔 + Math.random 式大噪声（>20px）→ psd/jerk 子分低，不通过。
"""
from __future__ import annotations

import numpy as np
import pytest

from app import config
from app.scoring import engine

W, H = 480, 480
CP = [(60, 60), (180, 380), (320, 100), (420, 420)]
DURATION = 3.0
FS = 100


def _bezier_samples(n: int = 300) -> np.ndarray:
    cp = np.array(CP, dtype=float)
    t = np.linspace(0, 1, n)
    u = 1 - t
    x = (
        u**3 * cp[0, 0]
        + 3 * u**2 * t * cp[1, 0]
        + 3 * u * t**2 * cp[2, 0]
        + t**3 * cp[3, 0]
    )
    y = (
        u**3 * cp[0, 1]
        + 3 * u**2 * t * cp[1, 1]
        + 3 * u * t**2 * cp[2, 1]
        + t**3 * cp[3, 1]
    )
    return np.column_stack([x, y])


def _human_trajectory(n: int = 300):
    """合成人类：贝塞尔跟随 + 生理震颤 + 末端纠偏。"""
    rng = np.random.default_rng(42)
    base = _bezier_samples(n)
    t = np.linspace(0, DURATION, n)

    # 主延迟滞后（人类神经传导 ~150ms）：整体相位偏移 + 小量跟随误差
    lag = 0.15
    phase = np.clip((t - lag) / DURATION, 0, 1)
    cp = np.array(CP, dtype=float)
    u = 1 - phase
    px = u**3 * cp[0, 0] + 3 * u**2 * phase * cp[1, 0] + 3 * u * phase**2 * cp[2, 0] + phase**3 * cp[3, 0]
    py = u**3 * cp[0, 1] + 3 * u**2 * phase * cp[1, 1] + 3 * u * phase**2 * cp[2, 1] + phase**3 * cp[3, 1]

    # 低频纠偏（多次方向修正 → 加速度多次过零）
    correct = 2.0 * np.sin(2 * np.pi * 1.3 * t) + 1.5 * np.sin(2 * np.pi * 2.1 * t)

    # 8-12Hz 生理震颤
    tremor = 1.2 * np.sin(2 * np.pi * 10 * t) + 0.8 * np.sin(2 * np.pi * 9.3 * t + 0.5)

    # 0.3~8px 高频微抖
    jitter = rng.normal(0, 0.9, n)

    xs = px + correct + tremor + jitter
    ys = py + 0.7 * correct + 0.6 * tremor + rng.normal(0, 0.9, n)

    # 非均匀采样时间戳（pointermove 不规则）
    ts = np.cumsum(rng.uniform(0.005, 0.04, n)) * 1000  # ms
    ts = ts - ts[0]
    return xs, ys, ts


def _bot_trajectory_perfect(n: int = 300):
    """机器：精确贝塞尔，过度平滑 → jerk≈0。"""
    base = _bezier_samples(n)
    t = np.linspace(0, DURATION * 1000, n)
    return base[:, 0].copy(), base[:, 1].copy(), t


def _bot_trajectory_noisy(n: int = 300):
    """机器：贝塞尔 + Math.random 式粗糙大噪声（>20px）。"""
    rng = np.random.default_rng(7)
    base = _bezier_samples(n)
    # 粗糙人工噪声：大振幅白噪，无生理结构
    xs = base[:, 0] + rng.uniform(-25, 25, n)
    ys = base[:, 1] + rng.uniform(-25, 25, n)
    t = np.linspace(0, DURATION * 1000, n)
    return xs, ys, t


def test_human_trajectory_passes():
    xs, ys, ts = _human_trajectory()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.accel_zerocrossings >= 4, f"过零偏少: {b.accel_zerocrossings}"
    assert not b.smoothness_veto, "不应触发平滑否决"
    assert b.passed, f"人类轨迹应通过: composite={b.composite} detail={engine.breakdown_to_dict(b)}"


def test_perfect_bot_vetoed():
    xs, ys, ts = _bot_trajectory_perfect()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.smoothness_veto, "完美机器轨迹应触发平滑否决"
    assert b.composite <= config.SMOOTHNESS_CAP + 1e-6, f"封顶失效: {b.composite}"
    assert not b.passed


def test_noisy_bot_fails():
    xs, ys, ts = _bot_trajectory_noisy()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    # 粗糙噪声偏离路径 → S_DTW 低，整体不通过
    assert not b.passed, f"粗糙噪声机器不应通过: {b.composite}"


def test_insufficient_points():
    xs = [10, 20]
    ys = [10, 20]
    ts = [0, 16]
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert not b.passed
    assert b.extras["reason"] == "insufficient_points"


def _touch_human_trajectory(n: int = 160):
    """模拟移动端触屏降采样后的真人轨迹：采样点稀疏 + 低幅微抖。

    回归 docs/log7 的真实场景——iOS Safari 把 pointermove 合并降采样，
    残差能量偏低（实测 ~0.15px）但仍含生理结构（jerk 非零、加速度过零）。
    放宽后的 ENERGY_LOW 应让这类真实人类轨迹通过，而非误判为过度平滑机器。
    """
    rng = np.random.default_rng(123)
    t = np.linspace(0, DURATION, n)
    lag = 0.15
    phase = np.clip((t - lag) / DURATION, 0, 1)
    cp = np.array(CP, dtype=float)
    u = 1 - phase
    px = u**3 * cp[0, 0] + 3 * u**2 * phase * cp[1, 0] + 3 * u * phase**2 * cp[2, 0] + phase**3 * cp[3, 0]
    py = u**3 * cp[0, 1] + 3 * u**2 * phase * cp[1, 1] + 3 * u * phase**2 * cp[2, 1] + phase**3 * cp[3, 1]
    # 低幅纠偏（仍有方向修正 → 加速度多次过零）
    correct = 0.5 * np.sin(2 * np.pi * 1.3 * t) + 0.4 * np.sin(2 * np.pi * 2.1 * t)
    # 小幅生理震颤
    tremor = 0.2 * np.sin(2 * np.pi * 10 * t) + 0.15 * np.sin(2 * np.pi * 9.3 * t + 0.5)
    # 触屏降采样后高频微抖被压缩
    jitter = rng.normal(0, 0.12, n)
    xs = px + correct + tremor + jitter
    ys = py + 0.7 * correct + 0.6 * tremor + rng.normal(0, 0.12, n)
    # 移动端合并事件后采样间隔偏大且较均匀
    ts = np.cumsum(rng.uniform(0.012, 0.022, n)) * 1000  # ms
    ts = ts - ts[0]
    return xs, ys, ts


def test_touch_human_passes():
    """回归 docs/log7：iOS 触屏降采样后残差偏低但含生理结构的真人轨迹应通过。"""
    xs, ys, ts = _touch_human_trajectory()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert not b.smoothness_veto, "低残差真人轨迹不应触发平滑否决"
    assert b.residual_energy > config.SMOOTHNESS_JERK_EPS, f"残差应高于否决线: {b.residual_energy}"
    assert b.residual_energy < 0.5, f"残差应偏低(模拟触屏降采样): {b.residual_energy}"
    assert b.passed, f"触屏真人轨迹应通过: composite={b.composite} detail={engine.breakdown_to_dict(b)}"


def test_dtw_normalization_decouples_canvas_size():
    """回归 docs/issue4.md §2 / docs/log5：DTW 必须归一化到 [0,1]² 解耦画布尺寸。

    iOS 场景前端可能在 360×360 采集而后端在另一尺寸算贝塞尔。归一化前这种
    坐标系错位会让越界/缩放点与贝塞尔参考路径每点拉开 DTW 代价 → S_DTW 崩塌。
    归一化后即便两侧 canvas_w/h 标的尺寸不同，只要形状一致 S_DTW 应自洽且接近 1。
    """
    from app.scoring import dtw as dtw_mod

    base = _bezier_samples(256)
    # 用生成轨迹时的画布尺寸算 S_DTW（基准）
    s_ref = dtw_mod.score_dtw(base, base[:, :].copy() * 1.0, W, H)
    # 故意用"错误的"画布尺寸（与生成尺寸不一致）算 S_DTW —— 归一化后应仍接近 1，
    # 因为轨迹与贝塞尔形状完全一致（只是被归一化到单位正方形）。
    s_mismatch = dtw_mod.score_dtw(base, base[:, :].copy() * 1.0, 360, 360)
    assert s_ref >= 0.99, f"同尺寸基准 S_DTW 应≈1: {s_ref}"
    assert s_mismatch >= 0.9, (
        f"画布尺寸错位时归一化 S_DTW 不应崩塌: s_mismatch={s_mismatch} "
        "(docs/log5 的 iOS S_DTW 崩塌回归)"
    )
