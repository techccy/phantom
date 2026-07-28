"""DSP 预处理与生理动力学特征提取（手册 §三）。

判定哲学（关键）：人类与机器的差异体现在【高频残差】是否存在与是否"生理"。
  - 7Hz 低通保留的是"自愿运动"（两者都有）→ 用于 DTW 方向拟合。
  - 原始信号 - 低通 = "高频残差"：
      人类 → 含 8-12Hz 生理震颤 + 0.3~8px 微抖，能量结构化；
      完美机器 → 残差≈0（过度平滑）；粗糙机器 → 残差是 >20px 白噪（无 8-12Hz 结构）。
  因此 jerk 方差 / 零交叉 / PSD 均在【残差】上计算，而非低通后信号。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.interpolate import interp1d
from scipy.signal import butter, filtfilt, welch

from .. import config


def resample_uniform(
    xs: np.ndarray, ys: np.ndarray, ts_ms: np.ndarray, fs: int = config.DSP_SAMPLE_HZ
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """将非均匀采样的轨迹线性插值到 fs Hz 均匀时间网格。

    手册要求"剥离无意识震颤并保留自愿运动轨迹"必须基于均匀采样；前端采集
    的事件序列时间间隔不规则（pointermove 节流 + 浏览器调度），故先上采样。
    """
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    ts_ms = np.asarray(ts_ms, dtype=np.float64)

    keep = np.concatenate([[True], np.diff(ts_ms) > 0])
    ts_ms = ts_ms[keep]
    xs = xs[keep]
    ys = ys[keep]
    if ts_ms.size < 2:
        raise ValueError("轨迹时间戳不足，无法上采样")

    t0 = ts_ms[0]
    t_rel = (ts_ms - t0) / 1000.0
    duration = t_rel[-1]
    n = max(int(round(duration * fs)), 2)
    t_grid = np.linspace(0.0, duration, n)

    fx = interp1d(t_rel, xs, kind="linear", bounds_error=False, fill_value=(xs[0], xs[-1]))
    fy = interp1d(t_rel, ys, kind="linear", bounds_error=False, fill_value=(ys[0], ys[-1]))
    return fx(t_grid), fy(t_grid), t_grid


def butterworth_lowpass(
    signal: np.ndarray, fs: int = config.DSP_SAMPLE_HZ
) -> np.ndarray:
    """4 阶双向（零相位）巴特沃斯低通，截止 7Hz（手册 §三.2）。

    filtfilt 正反向各滤波一次消除相位延迟——这是"双向"要求。
    """
    nyq = fs / 2.0
    wn = min(config.BUTTER_CUTOFF_HZ / nyq, 0.99)
    padlen = min(3 * config.BUTTER_ORDER, signal.size - 1)
    b, a = butter(config.BUTTER_ORDER, wn, btype="low", analog=False)
    if padlen < 1:
        return signal.astype(np.float64)
    return filtfilt(b, a, signal.astype(np.float64), padlen=padlen)


def bandpass(signal: np.ndarray, lo_hz: float, hi_hz: float, fs: int) -> np.ndarray:
    nyq = fs / 2.0
    lo = max(lo_hz / nyq, 1e-3)
    hi = min(hi_hz / nyq, 0.999)
    if signal.size <= 3 * config.BUTTER_ORDER:
        return signal.astype(np.float64)
    b, a = butter(config.BUTTER_ORDER, [lo, hi], btype="band", analog=False)
    padlen = min(3 * config.BUTTER_ORDER, signal.size - 1)
    return filtfilt(b, a, signal.astype(np.float64), padlen=padlen)


@dataclass
class BioFeatures:
    """生理动力学特征向量（手册 §三.3 对照表），均在残差上度量。"""

    residual_energy: float        # 残差 RMS（px）—— 区分"过度平滑(jerk≈0)"
    jerk_variance: float          # 残差 jerk 方差
    accel_zerocrossings: int      # 残差加速度零交叉次数
    tremor_amplitude_px: float    # 8-12Hz 带通残差 RMS (px)
    psd_8_12_ratio: float         # 8-12Hz 功率占比


def finite_diff_2nd(s: np.ndarray, fs: int) -> np.ndarray:
    if s.size < 3:
        return np.zeros(0)
    return np.diff(s, 2) * (fs**2)


def finite_diff_3rd(s: np.ndarray, fs: int) -> np.ndarray:
    if s.size < 4:
        return np.zeros(0)
    return np.diff(s, 3) * (fs**3)


def zerocrossings(sig: np.ndarray, frac: float = 0.15) -> int:
    """符号翻转计数。去抖：幅值低于 95 分位 frac 倍的样本忽略，避免数值虚高。

    手册 §三.3：3 秒拖拽 ≥5 次（人类"主弹道推进→反馈纠偏"循环）。
    """
    if sig.size < 2:
        return 0
    thr = frac * (np.percentile(np.abs(sig), 95) + 1e-9)
    s = np.sign(sig)
    s[np.abs(sig) < thr] = 0
    nz = s[s != 0]
    if nz.size < 2:
        return 0
    return int(np.count_nonzero(np.diff(nz)))


def band_power_ratio(sig: np.ndarray, fs: int, lo: float, hi: float) -> float:
    if sig.size < 16:
        return 0.0
    nperseg = min(sig.size, 128)
    freqs, pxx = welch(sig, fs=fs, nperseg=nperseg)
    total = np.trapezoid(pxx, freqs) + 1e-12
    mask = (freqs >= lo) & (freqs <= hi)
    return float(np.trapezoid(pxx[mask], freqs[mask]) / total)


def acf_envelope_decay(
    sig: np.ndarray, fs: int, max_lag_s: float = config.PERIODIC_ACF_MAX_LAG_S
) -> float:
    """残差自相关包络衰减比（手册 §三.3 / docs/issue7.md）。

    定义：长 lag 窗 |ACF(τ)| 积分 / 短 lag 窗 |ACF(τ)| 积分。
      - 纯周期信号（Math.sin 伪震颤）：ACF 不随 lag 衰减，长/短窗能量相当 → 比≈1；
      - 非周期随机过程（真人肌肉微震）：ACF 指数衰减，长窗能量远小于短窗 → 比→0。

    返回值越大越「周期」。sig 经均值去势后用未归一自相关计算，最后除以方差归一化。
    """
    sig = np.asarray(sig, dtype=np.float64)
    if sig.size < 16:
        return 0.0
    r = sig - sig.mean()
    var = float(np.dot(r, r))
    if var <= 0.0:
        return 0.0
    max_lag = min(int(max_lag_s * fs), sig.size - 1)
    if max_lag < 8:
        return 0.0
    acf = np.empty(max_lag, dtype=np.float64)
    for lag in range(1, max_lag + 1):
        acf[lag - 1] = float(np.dot(r[: sig.size - lag], r[lag:]) / var)
    envelope = np.abs(acf)
    mid = envelope.size // 2
    if mid < 1:
        return 0.0
    short_energy = float(envelope[:mid].sum()) + 1e-12
    long_energy = float(envelope[mid:].sum()) + 1e-12
    return long_energy / short_energy


def spectral_flatness_band(
    sig: np.ndarray, fs: int, lo: float, hi: float
) -> float:
    """指定频段的谱平坦度（几何均值 / 算术均值）。

    8-12Hz 段单峰（Math.sin 伪震颤）→ 接近 0；宽带（真人非周期微震）→ 接近 1。
    与 acf_envelope_decay 互为印证：两者都判周期时才否决，避免误伤窄带真人残差。
    """
    if sig.size < 16:
        return 0.0
    nperseg = min(sig.size, 128)
    freqs, pxx = welch(sig, fs=fs, nperseg=nperseg)
    mask = (freqs >= lo) & (freqs <= hi)
    band = pxx[mask]
    if band.size < 2 or band.sum() <= 0.0:
        return 0.0
    band = band + 1e-12
    geo = float(np.exp(np.mean(np.log(band))))
    arith = float(np.mean(band))
    if arith <= 0.0:
        return 0.0
    return max(0.0, min(1.0, geo / arith))


def timestamp_dispersity(ts_ms: np.ndarray) -> float:
    """硬件中断熵（手册 §三.3 / docs/issue7.md）：相邻样本 Δt 的变异系数 std/mean。

      - 等差时间戳（按 fps 公式步进的攻击者）：Δt 恒定 → cv ≈ 0；
      - 真人采样（pointermove 节流 + CPU 调度 + 硬件中断）：Δt 无序抖动 → cv 显著 >0。

    返回 cv，越小越「等差」。ts_ms 必须是原始采集时间戳（未上采样）。
    """
    ts_ms = np.asarray(ts_ms, dtype=np.float64)
    dt = np.diff(ts_ms)
    dt = dt[dt > 0]
    if dt.size < 4:
        return 0.0
    mean = float(dt.mean())
    if mean <= 0.0:
        return 0.0
    return float(dt.std() / mean)


def extract_bio_features(
    xs: np.ndarray, ys: np.ndarray, fs: int = config.DSP_SAMPLE_HZ
) -> tuple[BioFeatures, np.ndarray, np.ndarray]:
    """对 x/y 两轴：低通得自愿运动；残差上提取生理特征。"""
    fx = butterworth_lowpass(xs, fs)
    fy = butterworth_lowpass(ys, fs)
    rx = xs - fx
    ry = ys - fy

    rmag = np.sqrt(rx**2 + ry**2)
    residual_energy = float(np.sqrt(np.mean(rmag**2)))

    jx = finite_diff_3rd(rx, fs)
    jy = finite_diff_3rd(ry, fs)
    jerk = np.concatenate([jx, jy]) if jx.size else jy
    jerk_var = float(np.var(jerk)) if jerk.size else 0.0

    ax = finite_diff_2nd(rx, fs)
    ay = finite_diff_2nd(ry, fs)
    accel_pick = ax if np.var(ax) >= np.var(ay) else ay
    zc = zerocrossings(accel_pick)

    bx = bandpass(rx, config.TREMOR_LO_HZ, config.TREMOR_HI_HZ, fs)
    by = bandpass(ry, config.TREMOR_LO_HZ, config.TREMOR_HI_HZ, fs)
    tremor_amp = max(
        float(np.sqrt(np.mean(bx**2))) if bx.size else 0.0,
        float(np.sqrt(np.mean(by**2))) if by.size else 0.0,
    )
    psd_ratio = max(band_power_ratio(rx, fs, config.TREMOR_LO_HZ, config.TREMOR_HI_HZ),
                    band_power_ratio(ry, fs, config.TREMOR_LO_HZ, config.TREMOR_HI_HZ))

    return BioFeatures(
        residual_energy=residual_energy,
        jerk_variance=jerk_var,
        accel_zerocrossings=zc,
        tremor_amplitude_px=tremor_amp,
        psd_8_12_ratio=psd_ratio,
    ), fx, fy
