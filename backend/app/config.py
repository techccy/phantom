"""集中配置：阈值、时效、TTL、密钥文件。

所有可调参数在此声明，避免散落各处。安全敏感值（TOKEN_HMAC_SECRET）优先
读取环境变量；若未设置则启动时生成进程级随机密钥（仅适用于单进程部署，
生产应通过环境变量注入稳定密钥）。
"""
from __future__ import annotations

import os
import secrets


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw is not None else default
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        return float(raw) if raw is not None else default
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ---- 基础设施 ----
# 调试模式：开启后在后端日志打印每次 /verify 的全部采集轨迹与原分属明细。
# 仅用于排查问题，生产请保持关闭（会泄露用户轨迹与评分细节）。
DEBUG: bool = _env_bool("PHANTOM_DEBUG", False)
REDIS_URL: str = os.environ.get("PHANTOM_REDIS_URL", "redis://localhost:6379/0")
CORS_ORIGINS: list[str] = [
    o.strip()
    for o in os.environ.get(
        "PHANTOM_CORS_ORIGINS",
        # 默认放开本地开发的几个常用源：前端 dev server、官方 demo、接入 demo
        "http://localhost:5173,http://localhost:8088,http://localhost",
    ).split(",")
    if o.strip()
]

# ---- Challenge / Token 生命周期 ----
CHALLENGE_TTL_SECONDS: int = _env_int("PHANTOM_CHALLENGE_TTL", 120)
TOKEN_TTL_SECONDS: int = _env_int("PHANTOM_TOKEN_TTL", 300)

# 画布（与前端约定，仅作为路径生成与归一化参考，可被 challenge 覆盖）
# PC / 移动端分别配置（docs/issue3.md §2/§4）：
#   - PC 默认 480×480（鼠标 1px 精准）
#   - Mobile 默认 360×360（窄屏 + 大拇指接触面更友好）
# 旧字段 CANVAS_WIDTH/HEIGHT 保留为 PC 兜底默认，向后兼容已部署配置。
CANVAS_WIDTH: int = _env_int("PHANTOM_CANVAS_W", 480)
CANVAS_HEIGHT: int = _env_int("PHANTOM_CANVAS_H", 480)
CANVAS_WIDTH_PC: int = _env_int("PHANTOM_CANVAS_W_PC", CANVAS_WIDTH)
CANVAS_HEIGHT_PC: int = _env_int("PHANTOM_CANVAS_H_PC", CANVAS_HEIGHT)
CANVAS_WIDTH_MOBILE: int = _env_int("PHANTOM_CANVAS_W_MOBILE", 360)
CANVAS_HEIGHT_MOBILE: int = _env_int("PHANTOM_CANVAS_H_MOBILE", 360)
CHALLENGE_DURATION_SECONDS: float = _env_float("PHANTOM_CHALLENGE_DURATION", 6.0)

# ---- 时效（手册 §四.2：防止离线慢算）----
MAX_DRIFT_SECONDS: float = _env_float("PHANTOM_MAX_DRIFT_SECONDS", 3.0)
# 允许的前后端时钟漂移容差（毫秒），用于客户端 last_point_t 与 server now 比较
CLOCK_SKEW_MS: int = _env_int("PHANTOM_CLOCK_SKEW_MS", 1500)

# ---- DSP / 评分（手册 §三、§四）----
DSP_SAMPLE_HZ: int = _env_int("PHANTOM_DSP_FS", 100)        # 上采样目标频率
BUTTER_ORDER: int = _env_int("PHANTOM_BUTTER_ORDER", 4)     # 4 阶
BUTTER_CUTOFF_HZ: float = _env_float("PHANTOM_BUTTER_CUTOFF", 7.0)  # 7 Hz 截止

# 评分阈值（手册 §四.1）
PASS_THRESHOLD: float = _env_float("PHANTOM_PASS_THRESHOLD", 0.8)
# 一票否决封顶：平滑否决 / 等差时间戳否决 触发时 composite 的统一上限。
SMOOTHNESS_CAP: float = _env_float("PHANTOM_SMOOTHNESS_CAP", 0.20)
# 平滑否决线：残差能量(px)低于此值视为过度平滑(jerk≈0)。手册 §三.3 完美机器<0.05px。
SMOOTHNESS_JERK_EPS: float = _env_float("PHANTOM_SMOOTHNESS_EPS", 0.08)
SMOOTHNESS_BIO: float = _env_float("PHANTOM_SMOOTHNESS_BIO", 0.05)

# S_Bio 权重（手册 §四.1：残差里有没有生理特征）
W_JERK: float = _env_float("PHANTOM_W_JERK", 0.4)
W_ZC: float = _env_float("PHANTOM_W_ZC", 0.3)
W_PSD: float = _env_float("PHANTOM_W_PSD", 0.3)

# Composite 权重：Composite = W_DTW·S_DTW + W_BIO·S_Bio
W_DTW: float = _env_float("PHANTOM_W_DTW", 0.6)
W_BIO: float = _env_float("PHANTOM_W_BIO", 0.4)

# ---- 震颤频段（生理性 8-12Hz）----
TREMOR_LO_HZ: float = _env_float("PHANTOM_TREMOR_LO_HZ", 8.0)
TREMOR_HI_HZ: float = _env_float("PHANTOM_TREMOR_HI_HZ", 12.0)

# ---- issue #7 后端风控：周期性伪噪点否决（手册 §三.3 / docs/issue7.md）----
# 攻击者用 Math.sin() 注入 8-12Hz「伪震颤」——残差自相关不随 lag 衰减、8-12Hz
# 频段呈单峰。真人肌肉微震是非周期随机过程，自相关指数衰减、频谱宽带。
# 周期性 = (acf 衰减比高) AND (频谱平坦度低)，双条件同时满足才否决，避免误伤
# 残差本身偏窄的真实人类。
PERIODIC_VETO_ENABLED: bool = _env_bool("PHANTOM_PERIODIC_VETO", True)
# 自相关包络衰减比 = 长 lag 窗 |ACF| 积分 / 短 lag 窗 |ACF| 积分。≥此值视为不衰减（周期）。
# 实测：真人 0.24~0.44，纯 sin 攻击者 0.68~0.92。
PERIODIC_ACF_DECAY_MIN: float = _env_float("PHANTOM_PERIODIC_ACF_MIN", 0.6)
# 8-12Hz 频段谱平坦度（几何/算术均值，0=单峰 1=宽带）。≤此值视为窄带单峰（周期）。
# 实测：真人 ≥0.89，纯 sin 攻击者 0.02~0.55。
PERIODIC_SFM_MAX: float = _env_float("PHANTOM_PERIODIC_SFM_MAX", 0.6)
# 计算自相关的最长 lag（秒）。
PERIODIC_ACF_MAX_LAG_S: float = _env_float("PHANTOM_PERIODIC_ACF_LAG", 0.4)

# ---- issue #7 后端风控：硬件中断熵否决（手册 §三.3 / docs/issue7.md）----
# 攻击者按 fps 严格步进生成等差时间戳（performance.now() 公式化）。真人受 CPU
# 微任务调度 + 硬件中断影响，Δt 无序抖动。校验 Δt 的变异系数（std/mean）切断等差时间戳。
# 实测：真人 Δt_cv 0.16~0.47，等差 1/fps 攻击者 = 0.0。
ARITHMETIC_TS_VETO_ENABLED: bool = _env_bool("PHANTOM_ARITH_TS_VETO", True)
# Δt 变异系数低于此值判为等差时间戳。留出余量，真机最均匀触屏采样也 >0.1。
ARITHMETIC_TS_CV_MIN: float = _env_float("PHANTOM_ARITH_TS_CV_MIN", 0.05)
# 否决封顶（与平滑否决同级一票否决语义）。
ARITHMETIC_TS_CAP: float = _env_float("PHANTOM_ARITH_TS_CAP", 0.20)

# ---- _energy_score 边界（残差能量 px；手册 §三.3）----
# <ENERGY_MIN≈过度平滑→0；ENERGY_LOW~HIGH 为生理区间→1；>ENERGY_MAX≈粗糙白噪→0
# 注：移动端浏览器 pointermove 被合并降采样，真人触屏残差天然偏小（实测 ~0.15px），
# 下沿 ENERGY_MIN/LOW 较手册桌面值放宽，避免真实人类被误判为过度平滑机器；
# 低残差真机器仍由 SMOOTHNESS_JERK_EPS 否决线兜底。
ENERGY_MIN: float = _env_float("PHANTOM_ENERGY_MIN", 0.08)
ENERGY_LOW: float = _env_float("PHANTOM_ENERGY_LOW", 0.15)
ENERGY_HIGH: float = _env_float("PHANTOM_ENERGY_HIGH", 8.0)
ENERGY_MAX: float = _env_float("PHANTOM_ENERGY_MAX", 20.0)

# ---- _zc_score 边界（加速度零交叉率，次/秒；手册 §三.3）----
# 人类反馈纠偏区间 ≈ [ZC_RISE, ZC_PLATEAU] 满分；过低(平滑)/过高(白噪翻转)降权
ZC_FLOOR: float = _env_float("PHANTOM_ZC_FLOOR", 1.0)
ZC_RISE: float = _env_float("PHANTOM_ZC_RISE", 1.67)
ZC_PLATEAU: float = _env_float("PHANTOM_ZC_PLATEAU", 15.0)
ZC_DROP: float = _env_float("PHANTOM_ZC_DROP", 40.0)

# ---- _tremor_score 振幅段边界（px）----
TREMOR_AMP_MIN: float = _env_float("PHANTOM_TREMOR_AMP_MIN", 0.05)
TREMOR_AMP_LOW: float = _env_float("PHANTOM_TREMOR_AMP_LOW", 0.3)
TREMOR_AMP_HIGH: float = _env_float("PHANTOM_TREMOR_AMP_HIGH", 8.0)
TREMOR_AMP_MAX: float = _env_float("PHANTOM_TREMOR_AMP_MAX", 20.0)

# ---- _tremor_score PSD 占比段（8-12Hz 功率占比）----
# ≤TREMOR_PSD_MIN 无结构；TREMOR_PSD_LOW 上限；TREMOR_PSD_MID 上升尺度
TREMOR_PSD_MIN: float = _env_float("PHANTOM_TREMOR_PSD_MIN", 0.02)
TREMOR_PSD_LOW: float = _env_float("PHANTOM_TREMOR_PSD_LOW", 0.4)
TREMOR_PSD_MID: float = _env_float("PHANTOM_TREMOR_PSD_MID", 0.13)

# tremor 子分内部权重：tremor_score = W_TREMOR_AMP·amp_s + W_TREMOR_PSD·ratio_s
W_TREMOR_AMP: float = _env_float("PHANTOM_W_TREMOR_AMP", 0.5)
W_TREMOR_PSD: float = _env_float("PHANTOM_W_TREMOR_PSD", 0.5)

# ---- DTW 方向拟合衰减尺度（手册 §四.1；docs/issue4.md §2）----
# 用户轨迹与贝塞尔均先归一化到 [0,1]² 再算 DTW，每点偏差占单位正方形对角线（√2）
# 此比例时 S_DTW≈0.37；越大越宽松。归一化后 S_DTW 与画布尺寸解耦，
# 杜绝前后端画布不一致导致的 S_DTW 崩塌。
DTW_D_REF_RATIO: float = _env_float("PHANTOM_DTW_D_REF_RATIO", 0.15)

# ---- Challenge 视觉参数（下发前端）----
# 目标方块半边长（画布相对）。PC / 移动端分别配置（docs/issue3.md §4）：
#   - PC 鼠标精准，22px 半长（44px 方块）足够
#   - Mobile 大拇指接触面 10–15mm，半长放宽到 30px（60px 方块）以减少脱靶
# 旧字段 TARGET_HALF 保留为 PC 兜底默认。
TARGET_HALF: int = _env_int("PHANTOM_TARGET_HALF", 22)
TARGET_HALF_PC: int = _env_int("PHANTOM_TARGET_HALF_PC", TARGET_HALF)
TARGET_HALF_MOBILE: int = _env_int("PHANTOM_TARGET_HALF_MOBILE", 30)
FPS: int = _env_int("PHANTOM_FPS", 60)                   # 帧率（仅作约定下发给前端）

# ---- 轨迹有效性下限 ----
MIN_POINTS: int = _env_int("PHANTOM_MIN_POINTS", 30)

# ---- 安全密钥 ----
# token HMAC 密钥：生产必须通过环境变量注入
TOKEN_HMAC_SECRET: bytes = os.environ.get("PHANTOM_TOKEN_SECRET", "").encode() or secrets.token_bytes(
    32
)
