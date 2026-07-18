"""动态时间规整（DTW）方向拟合度（手册 §四.1）。

计算用户轨迹与后端下发的贝塞尔标准路径之间的 2D DTW 距离，归一化到画布
对角线长度，再用指数饱和映射成 S_DTW ∈ [0,1]。
"""
from __future__ import annotations

import numpy as np

from .. import config


def dtw_distance_2d(a: np.ndarray, b: np.ndarray) -> float:
    """2D 点序列 DTW 距离（欧氏局部代价）。

    a, b: shape (N, 2) / (M, 2)。经典 O(N*M) 动态规划实现。
    """
    n, m = a.shape[0], b.shape[0]
    if n == 0 or m == 0:
        return float("inf")
    INF = float("inf")
    dp = np.full((n + 1, m + 1), INF)
    dp[0, 0] = 0.0
    for i in range(1, n + 1):
        ai = a[i - 1]
        for j in range(1, m + 1):
            cost = float(np.hypot(ai[0] - b[j - 1, 0], ai[1] - b[j - 1, 1]))
            dp[i, j] = cost + min(dp[i - 1, j], dp[i, j - 1], dp[i - 1, j - 1])
    return float(dp[n, m]) / max(n, m)  # 按平均路径长度归一化


def sample_bezier(
    control_points: list[tuple[float, float]], num: int = 256
) -> np.ndarray:
    """三次贝塞尔（4 控制点）等参数采样为 (num, 2) 点列。

    兼容 2 点(线性)/3 点(二次)。返回密集标准路径。
    """
    cp = np.asarray(control_points, dtype=np.float64)
    degree = cp.shape[0] - 1
    t = np.linspace(0.0, 1.0, num)
    if degree == 3:
        pts = (
            (1 - t)[:, None] ** 3 * cp[0]
            + 3 * (1 - t)[:, None] ** 2 * t[:, None] * cp[1]
            + 3 * (1 - t)[:, None] * t[:, None] ** 2 * cp[2]
            + t[:, None] ** 3 * cp[3]
        )
    elif degree == 2:
        pts = (
            (1 - t)[:, None] ** 2 * cp[0]
            + 2 * (1 - t)[:, None] * t[:, None] * cp[1]
            + t[:, None] ** 2 * cp[2]
        )
    else:  # 线性或退化
        pts = (1 - t)[:, None] * cp[0] + t[:, None] * cp[-1]
    return pts


def score_dtw(
    user_xy: np.ndarray,
    bezier_points: np.ndarray,
    canvas_w: float,
    canvas_h: float,
    d_ref_ratio: float = config.DTW_D_REF_RATIO,
) -> float:
    """S_DTW：DTW 平均距离 / 对角线，指数饱和映射到 [0,1]。

    d_ref_ratio 控制衰减尺度——平均每点偏差占对角线 d_ref_ratio 时 S≈0.37。
    """
    diag = float(np.hypot(canvas_w, canvas_h))
    if diag <= 0:
        return 0.0
    raw = dtw_distance_2d(user_xy, bezier_points)
    if not np.isfinite(raw):
        return 0.0
    norm = raw / diag
    d_ref = max(diag * d_ref_ratio, 1e-6)
    s = float(np.exp(-(raw / d_ref)))
    return max(0.0, min(1.0, s))
