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

# ---- issue #10 后端风控：轴向非对称震颤否决（docs/debug10.md §二）----
# 攻击者（pastebin Node 脚本 / phantom-solver）在 X/Y 两轴注入【同频率、同幅度】
# 的 8-12Hz sin/cos 伪震颤——把整个残差当成各向同性（isotropic）的二维向量场。
# 解剖学限制（docs/debug10.md §二表格）：人类手部生理震颤在主运动方向（AP 轴）与
# 垂直方向（ML/VT 轴）频谱结构显著不同——脚本式对称加噪做不到。对全向均匀加噪
# 的轨迹一票否决。
AXIAL_ASYMMETRY_VETO_ENABLED: bool = _env_bool("PHANTOM_AXIAL_VETO", True)
# 残差带通(8-12Hz)能量在 X/Y 两轴的比值（大/小）。真人主运动方向与垂直方向的
# 生理震颤频谱/幅度显著不同 → 比值偏高；攻击者 X/Y 同幅度对称加噪 → 比值→1.0。
# ≤此阈值判为轴向对称（机器）。
# 实测：合成真人轨迹 1.21~1.26（解剖学上垂直轴震颤更强），硬化各向同性攻击者 1.05~1.11。
AXIAL_TREMOR_RATIO_MIN: float = _env_float("PHANTOM_AXIAL_RATIO_MIN", 1.15)
# 两轴 8-12Hz 带通 RMS 都需有足够幅度（px），否则两轴都接近 0（如过度平滑轨迹，
# 已被 smoothness_veto 兜底）比值无意义，不触发本否决。
AXIAL_TREMOR_AMP_MIN: float = _env_float("PHANTOM_AXIAL_AMP_MIN", 0.15)

# ---- issue #10 后端风控：子像素尾数退化否决（docs/debug10.md §二）----
# 攻击者用 Math.round()/整数公式生成坐标 → 所有样本落在整数像素格点上，子像素
# 小数尾数分布坍缩（仅 0 出现）。真实硬件（鼠标/触屏经 DPR 缩放 + 浮点映射）采集
# 的坐标尾数均匀分布于 [0,1)。对尾数分布熵异常（信息熵过低，尾数坍缩到极少桶）的
# 轨迹一票否决。
SUBPIXEL_VETO_ENABLED: bool = _env_bool("PHANTOM_SUBPIXEL_VETO", True)
# 子像素尾数直方图信息熵（以 log2(量化桶数) 为上限归一化到 [0,1]）。
# 真人尾数均匀分布 → 熵接近 1.0；Math.round 全整数 → 熵≈0。≤此阈值判为尾数退化。
# 实测真人 ≥0.85，纯整数攻击者 = 0.0。
SUBPIXEL_ENTROPY_MIN: float = _env_float("PHANTOM_SUBPIXEL_ENTROPY_MIN", 0.6)
# 尾数量化桶数（每像素切成多少段统计尾数分布）。越大越精细，但样本少时需要足够点。
SUBPIXEL_BINS: int = _env_int("PHANTOM_SUBPIXEL_BINS", 16)
# 触发尾数否决所需的最小样本数——不足时尾数分布统计无意义，跳过否决。
SUBPIXEL_MIN_POINTS: int = _env_int("PHANTOM_SUBPIXEL_MIN_POINTS", 40)

# ---- issue #10 后端风控：最小人类响应时长下限（docs/debug10.md §三）----
# 人类从眼球识别轮廓→大脑发出运动指令→完成拖拽，最小物理响应时间约 300~500ms。
# 攻击者离线合成轨迹可在远低于此的时长内生成完整路径。整体耗时（首尾时间戳之差）
# 低于此下限直接判为自动化脚本。
MIN_HUMAN_DURATION_MS: float = _env_float("PHANTOM_MIN_HUMAN_DURATION_MS", 250.0)

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
