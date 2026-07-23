"""动态时间规整（DTW）方向拟合度（手册 §四.1；docs/issue4.md §2）。

计算用户轨迹与后端下发的贝塞尔标准路径之间的 2D DTW 距离。两侧均先按画布
宽/高归一化到 [0,1]² 单位正方形再算 DTW，使 S_DTW 与画布尺寸彻底解耦——
即便前端采集画布与后端参考画布尺寸不一致（iOS DPR / stale 镜像等场景），
也不会因坐标系错位导致 S_DTW 崩塌。最后用指数饱和映射成 S_DTW ∈ [0,1]。
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
    """S_DTW：两侧归一化到 [0,1]² 后的 DTW 平均距离，指数饱和映射到 [0,1]。

    归一化方式：user_xy / (canvas_w, canvas_h)、bezier_points / (canvas_w, canvas_h)。
    这一步把"画布像素坐标系"统一到单位正方形，S_DTW 不再依赖具体画布尺寸——
    即便前端因 DPR / stale 镜像在 360×360 采集而后端在 300×300 算贝塞尔
    （docs/issue4.md §2 的 iOS S_DTW 崩塌根因），归一化后形状一致 → S_DTW 自洽。

    d_ref_ratio 控制衰减尺度——归一化空间下每点偏差占单位正方形对角线（√2）
    d_ref_ratio 时 S≈0.37；越大越宽松。
    """
    if canvas_w <= 0 or canvas_h <= 0:
        return 0.0
    scale = np.array([canvas_w, canvas_h], dtype=np.float64)
    user_n = np.asarray(user_xy, dtype=np.float64) / scale
    bez_n = np.asarray(bezier_points, dtype=np.float64) / scale
    raw = dtw_distance_2d(user_n, bez_n)
    if not np.isfinite(raw):
        return 0.0
    # 单位正方形对角线 = √2；d_ref_ratio·√2 即"每点偏差占单位对角线此比例"
    d_ref = max(d_ref_ratio * float(np.sqrt(2.0)), 1e-6)
    s = float(np.exp(-(raw / d_ref)))
    return max(0.0, min(1.0, s))
