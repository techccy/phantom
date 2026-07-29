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
    assert not b.periodic_veto, "不应触发周期性否决"
    assert not b.arithmetic_ts_veto, "不应触发等差时间戳否决"
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
    assert not b.periodic_veto, "低残差真人轨迹不应触发周期性否决"
    assert not b.arithmetic_ts_veto, "触屏真人时间戳不应被判为等差"
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


# ============================================================
# issue #7 后端风控（docs/issue7.md §三）：周期性伪震颤 + 等差时间戳
# ============================================================
# 即便黑产逆向拿到目标路径 $P(t)$，后端风控引擎仍要在数学层面击穿脚本伪造的
# 轨迹。两类典型攻击（issue #7 明确点名）：
#   1) Math.sin() 注入 8-12Hz「伪震颤」——自相关不衰减、8-12Hz 频谱单峰；
#   2) 按 fps 严格步进生成等差时间戳——Δt 变异系数≈0。
# 后端各用一道一票否决阻断（见 app/scoring/engine.py 末段）。

def _attacker_sinusoidal_tremor(n: int = 300, fps: int = 60):
    """issue #7 攻击者：精确贝塞尔 + Math.sin 伪震颤 + 高斯噪声 + 等差 1/fps 时间戳。

    模拟黑产 hook crypto.subtle.decrypt 拿到控制点后，沿 P(t) 插值并注入
    「1~3Hz 低频正弦 + 8~12Hz 生理震颤 + 高斯噪声」伪造生物特征、按 fps
    等步进生成时间戳的合成轨迹。其残差自相关本应不衰减，但高斯噪声把残差
    宽带化——此时靠【等差时间戳】否决兜底。
    """
    rng = np.random.default_rng(7)
    base = _bezier_samples(n)
    t = np.linspace(0, DURATION, n)
    correct = 1.8 * np.sin(2 * np.pi * 1.5 * t) + 1.2 * np.sin(2 * np.pi * 2.8 * t + 0.3)
    tremor = 1.0 * np.sin(2 * np.pi * 10 * t) + 0.6 * np.sin(2 * np.pi * 10.5 * t + 1.1)
    noise = rng.normal(0, 0.6, n)
    xs = base[:, 0] + correct + tremor + noise
    ys = base[:, 1] + 0.8 * correct + 0.5 * tremor + rng.normal(0, 0.6, n)
    ts = np.arange(n) * (1000.0 / fps)  # 严格等差时间戳
    return xs, ys, ts


def _attacker_pure_sinusoidal(n: int = 300, fps: int = 60):
    """issue #7 攻击者（偷懒版）：纯 Math.sin 伪震颤、无噪声掩蔽。

    残差是纯正弦——自相关不衰减 + 8-12Hz 频谱单峰，周期性否决直接命中。
    时间戳也是等差。两个否决都会触发；测试只断言其一即可。
    """
    base = _bezier_samples(n)
    t = np.linspace(0, DURATION, n)
    correct = 1.8 * np.sin(2 * np.pi * 1.5 * t) + 1.2 * np.sin(2 * np.pi * 2.8 * t + 0.3)
    tremor = 1.2 * np.sin(2 * np.pi * 10 * t) + 0.6 * np.sin(2 * np.pi * 10.5 * t + 1.1)
    xs = base[:, 0] + correct + tremor
    ys = base[:, 1] + 0.8 * correct + 0.5 * tremor
    ts = np.arange(n) * (1000.0 / fps)
    return xs, ys, ts


def _human_with_compromised_timestamps():
    """攻击者复用真实人类形状但伪造等差时间戳：形状合法但时间熵缺失。

    取真人轨迹的 (x,y)，把时间戳换成等差序列——验证等差时间戳否决独立于
    轨迹形状生效（黑产「复制人类曲线 + 公式化重放」场景）。
    """
    xs, ys, _ = _human_trajectory()
    n = xs.size
    ts = np.arange(n) * (1000.0 / 60)
    return xs, ys, ts


def test_arithmetic_timestamps_vetoed():
    """issue #7：按 fps 等步进的时间戳应被等差否决拦截（Δt_cv≈0）。"""
    xs, ys, ts = _attacker_sinusoidal_tremor(fps=60)
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.arithmetic_ts_veto, f"等差时间戳应触发否决: dt_cv={b.dt_cv} detail={engine.breakdown_to_dict(b)}"
    assert not b.passed, f"等差时间戳攻击者不应通过: composite={b.composite}"
    assert b.composite <= config.SMOOTHNESS_CAP + 1e-6, "等差否决应封顶 composite"


def test_arithmetic_timestamps_vetoed_high_fps():
    """issue #7：120fps 等步进时间戳同样应被否决（不限于 60fps）。"""
    xs, ys, ts = _attacker_sinusoidal_tremor(fps=120)
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.arithmetic_ts_veto
    assert not b.passed


def test_pure_sinusoidal_tremor_vetoed():
    """issue #7：纯 Math.sin 伪震颤（残差自相关不衰减+频谱单峰）应被周期性否决。"""
    xs, ys, ts = _attacker_pure_sinusoidal()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.periodic_veto, (
        f"纯正弦伪震颤应触发周期性否决: acf={b.acf_envelope_decay} "
        f"flatness={b.spectral_flatness_8_12} detail={engine.breakdown_to_dict(b)}"
    )
    assert not b.passed, f"纯正弦攻击者不应通过: composite={b.composite}"
    assert b.composite <= config.SMOOTHNESS_CAP + 1e-6


def test_human_shape_compromised_timestamps_vetoed():
    """issue #7：复用人类曲线形状但伪造等差时间戳——等差否决独立于形状生效。"""
    xs, ys, ts = _human_with_compromised_timestamps()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.arithmetic_ts_veto, f"等差时间戳应触发否决（即便形状像人类）: dt_cv={b.dt_cv}"
    assert not b.passed, f"等差时间戳攻击者不应通过: composite={b.composite}"


def test_vetoes_dont_fire_on_legit_human():
    """回归：真实人类轨迹（非均匀时间戳 + 非周期残差）绝不应触发两类新否决。"""
    xs, ys, ts = _human_trajectory()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert not b.periodic_veto, (
        f"人类不应触发周期性否决: acf={b.acf_envelope_decay} flatness={b.spectral_flatness_8_12}"
    )
    assert not b.arithmetic_ts_veto, f"人类不应触发等差否决: dt_cv={b.dt_cv}"
    # 合法人类的两项否决特征量应有充裕余量
    assert b.dt_cv > config.ARITHMETIC_TS_CV_MIN
    assert b.passed


def test_vetoes_disabled_via_config(monkeypatch):
    """回归：关闭否决开关后，攻击者轨迹在旧逻辑下应「通过否决」但仍按 composite 判定。

    这锁定否决是【叠加】在既有评分之上的——关闭后仅靠 S_DTW/S_Bio 可能放行 issue #7
    攻击者（这正是 docs/issue7.md 警示的「知道路径即可伪造」场景），印证后端风控的必要性。
    """
    monkeypatch.setattr(config, "PERIODIC_VETO_ENABLED", False)
    monkeypatch.setattr(config, "ARITHMETIC_TS_VETO_ENABLED", False)
    xs, ys, ts = _attacker_pure_sinusoidal()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert not b.periodic_veto and not b.arithmetic_ts_veto
    # 关闭否决后纯正弦攻击者可能因 composite 过线而通过——这正是后端风控要堵的口子
    # 这里只断言否决标志为 False（不固化 composite 是否过线，留作实现的回归基线）


# ============================================================
# issue #10 后端风控（docs/debug10.md §二/§三）
# ============================================================
# 两条破解路径（issue #10 给出的 pastebin Node 脚本 / phantom-solver）：
#   A)「纯算」派生：逆 PCG32 从 pathSeed 推出贝塞尔控制点 → 沿路径插值 →
#      注入【X/Y 同频率同幅度】的 sin/cos 伪震颤 → Math.round 取整坐标 →
#      等差/带抖动时间戳。高阶版还会叠加带通(8-12Hz)噪声欺骗 DTW/Jerk/PSD。
#   B)「快进合成」：在 <250ms 内一口气离线生成完整轨迹。
# 后端用三道一票否决击穿：
#   1) 子像素尾数退化否决（Math.round → 尾数熵≈0）—— A 的致命破绽；
#   2) 轴向非对称震颤否决（X/Y 同幅度 → 比值→1.0）—— 击穿高阶各向同性加噪；
#   3) 最小人类响应时长下限否决（<250ms → 离线高速合成）—— 击穿 B。


def _bezier_at(t, cp):
    u = 1 - t
    x = u**3 * cp[0][0] + 3*u**2*t*cp[1][0] + 3*u*t**2*cp[2][0] + t**3*cp[3][0]
    y = u**3 * cp[0][1] + 3*u**2*t*cp[1][1] + 3*u*t**2*cp[2][1] + t**3*cp[3][1]
    return x, y


def _attacker_pastebin_node(n: int = 180, fps: int = 60, seed: int = 12345):
    """issue #10 pastebin Node 脚本复刻（docs/debug10.md 攻击路径 A）。

    精确复刻 https://pastebin.com/eWNYh2f5 的 genTrajectory：
      - 沿贝塞尔插值；
      - 【同频率同幅度】的 Math.sin(tremorX) / Math.cos(tremorY) 伪震颤；
      - (rng-0.5)*1.5 微抖；
      - Math.round 取整坐标（整数像素）；
      - t·duration·1000 基线 + (rng-0.5)*4 抖动时间戳。
    """
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 1, n)
    bx, by = _bezier_at(t, CP)
    duration = DURATION
    tremor_freq = 8 + rng.random(n) * 4
    tremor_amp = 0.5 + rng.random(n) * 2.0
    phase = rng.random(n) * 2 * np.pi
    tremor_x = np.sin(t * duration * tremor_freq * 2 * np.pi + phase) * tremor_amp
    tremor_y = np.cos(t * duration * tremor_freq * 2 * np.pi + phase) * tremor_amp
    micro_x = (rng.random(n) - 0.5) * 1.5
    micro_y = (rng.random(n) - 0.5) * 1.5
    # ⚠️ Math.round → 整数坐标（子像素尾数退化的根因）
    xs = np.round(bx + tremor_x + micro_x)
    ys = np.round(by + tremor_y + micro_y)
    xs = np.clip(xs, 0, W - 1)
    ys = np.clip(ys, 0, H - 1)
    base_ts = t * duration * 1000
    jitter = (rng.random(n) - 0.5) * 4
    ts = np.maximum(0, np.round(base_ts + jitter))
    return xs, ys, ts


def _attacker_hardened_isotropic(n: int = 300, seed: int = 7):
    """issue #10 硬化版各向同性攻击者（docs/debug10.md §二）。

    规避 Math.round（取整）与等差时间戳——但仍保留 X/Y 同频同幅度的对称加噪：
      - 沿贝塞尔 + 【复制同一份 8-12Hz 伪震颤到 X 与 Y】→ 两轴震幅相等（比值≈1）；
      - 保留浮点子像素尾数（规避子像素否决）；
      - 非均匀抖动时间戳（规避等差否决）。
    这是纯靠【轴向非对称否决】兜底的攻击者。
    """
    rng = np.random.default_rng(seed)
    t = np.linspace(0, DURATION, n)
    bx, by = _bezier_at(t / DURATION, CP)
    # 共享 8-12Hz 窄带伪震颤 → 复制到两轴 = 各向同性（攻击者的核心破绽）
    shared = 1.4 * np.sin(2 * np.pi * 10 * t) + 0.8 * np.sin(2 * np.pi * 9.3 * t + 0.5)
    # 少量独立宽带微抖（模拟公式化噪声），浮点保留子像素尾数
    xs = bx + shared + rng.normal(0, 0.3, n)
    ys = by + shared + rng.normal(0, 0.3, n)
    # 非均匀时间戳（规避等差否决）
    ts = np.cumsum(rng.uniform(0.008, 0.022, n)) * 1000
    ts = ts - ts[0]
    return xs, ys, ts


def _attacker_fast_offline(n: int = 300, seed: int = 99):
    """issue #10 离线高速合成（docs/debug10.md §三攻击路径 B）。

    形状/噪声都接近人类（带轴向不对称震颤 + 浮点尾数 + 非均匀时间戳），唯独整体
    耗时被压缩到 <250ms（黑产离线一口气合成）。靠【最小响应时长否决】兜底。
    """
    rng = np.random.default_rng(seed)
    # 把一条 3 秒的人类式轨迹压进 150ms 内
    short_duration = 0.150
    t = np.linspace(0, short_duration, n)
    # 轨迹形状仍走贝塞尔（t 归一化）
    bx, by = _bezier_at(t / short_duration, CP)
    correct = 2.0 * np.sin(2 * np.pi * 1.3 * t) + 1.5 * np.sin(2 * np.pi * 2.1 * t)
    tremor = 1.2 * np.sin(2 * np.pi * 10 * t) + 0.8 * np.sin(2 * np.pi * 9.3 * t + 0.5)
    jitter = rng.normal(0, 0.9, n)
    xs = bx + correct + tremor + jitter + rng.normal(0, 0.5, n) * 0.1
    ys = by + 0.7 * correct + 0.6 * tremor + rng.normal(0, 0.9, n)
    ts = np.cumsum(rng.uniform(0.0002, 0.0008, n)) * 1000
    ts = ts - ts[0]
    return xs, ys, ts


def test_pastebin_node_attack_blocked():
    """issue #10：pastebin Node 脚本（Math.round 取整）应被子像素尾数否决拦截。"""
    xs, ys, ts = _attacker_pastebin_node()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.subpixel_veto, (
        f"Math.round 取整攻击者应触发子像素否决: ent_x={b.subpixel_entropy_x} "
        f"ent_y={b.subpixel_entropy_y} detail={engine.breakdown_to_dict(b)}"
    )
    assert not b.passed
    assert b.composite <= config.SMOOTHNESS_CAP + 1e-6


def test_hardened_isotropic_attack_blocked():
    """issue #10：硬化版各向同性攻击者（规避取整/等差）应被轴向非对称否决拦截。"""
    xs, ys, ts = _attacker_hardened_isotropic()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.axial_asymmetry_veto, (
        f"各向同性对称加噪攻击者应触发轴向否决: ratio={b.axial_tremor_ratio} "
        f"amp_x={b.axial_tremor_amp_x} amp_y={b.axial_tremor_amp_y} "
        f"detail={engine.breakdown_to_dict(b)}"
    )
    assert not b.passed
    assert b.composite <= config.SMOOTHNESS_CAP + 1e-6


def test_fast_offline_attack_blocked():
    """issue #10：离线高速合成（<250ms）应被最小响应时长否决拦截。"""
    xs, ys, ts = _attacker_fast_offline()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert b.min_duration_veto, (
        f"高速合成轨迹应触发时长否决: duration_ms={b.duration_ms} "
        f"detail={engine.breakdown_to_dict(b)}"
    )
    assert b.duration_ms < config.MIN_HUMAN_DURATION_MS
    assert not b.passed
    assert b.composite <= config.SMOOTHNESS_CAP + 1e-6


def test_issue10_vetoes_dont_fire_on_legit_human():
    """回归：真实人类轨迹（浮点子像素 + 轴向不对称震颤 + 3s 耗时）绝不应触发 issue #10 否决。"""
    xs, ys, ts = _human_trajectory()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert not b.subpixel_veto, (
        f"人类不应触发子像素否决: ent_x={b.subpixel_entropy_x} ent_y={b.subpixel_entropy_y}"
    )
    assert not b.axial_asymmetry_veto, (
        f"人类不应触发轴向否决: ratio={b.axial_tremor_ratio}"
    )
    assert not b.min_duration_veto, (
        f"人类不应触发生长否决: duration_ms={b.duration_ms}"
    )
    # 合法人类特征量应有充裕余量
    assert b.subpixel_entropy_x > config.SUBPIXEL_ENTROPY_MIN
    assert b.subpixel_entropy_y > config.SUBPIXEL_ENTROPY_MIN
    assert b.duration_ms > config.MIN_HUMAN_DURATION_MS
    assert b.passed


def test_issue10_vetoes_dont_fire_on_touch_human():
    """回归：移动端触屏降采样真人轨迹（低残差但仍浮点 + 轴向不对称）不应触发 issue #10 否决。"""
    xs, ys, ts = _touch_human_trajectory()
    b = engine.score_trajectory(xs, ys, ts, CP, W, H)
    assert not b.subpixel_veto
    assert not b.min_duration_veto
    assert b.passed
