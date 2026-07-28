"""Challenge 创建：高熵 path_seed 下发 + 确定性路径派生（issue #7）。

安全模型（v0.2.0）：
  - 不再把贝塞尔控制点 `controlPoints` 下发。控制点是评分的"标准答案"，
    直接下发即等于把答案明文交给前端——攻击者 hook 一次 `crypto.subtle.decrypt`
    就能在点击前拿到完整轨迹（见 issue #7 / docs/fuck.js）。
  - 现在只下发一段高熵 `pathSeed`（16 字节随机）。前后端【各自】用同一段确定性
    PCG32 派生（app/prng.py ↔ frontend/src/prng.ts）从种子推出 4 个控制点：
      · 前端用它驱动渲染；
      · 后端用它驱动 DTW 评分。
    网络上只有不可解读的种子在跑；hook decrypt 只能看到种子，无 SDK 派生逻辑
    （被 SDK 混淆 + 内联）就拿不到任何 [x,y] 几何点。

其余不变：会话密钥 AES-256-GCM、一题一答 GETDEL、时效校验。
"""
from __future__ import annotations

import json
import secrets
import uuid

from . import config, crypto, prng


def _resolve_device_params(device: str | None) -> tuple[int, int, int]:
    """按端类型解析 (canvas_w, canvas_h, target_half)（docs/issue3.md §2/§4）。

    device 为 None 或非 "mobile" 时一律走 PC 默认（向后兼容旧 SDK）。
    """
    if device == "mobile":
        return config.CANVAS_WIDTH_MOBILE, config.CANVAS_HEIGHT_MOBILE, config.TARGET_HALF_MOBILE
    return config.CANVAS_WIDTH_PC, config.CANVAS_HEIGHT_PC, config.TARGET_HALF_PC


def create_challenge(
    client_public_jwk: dict,
    canvas_w: int | None = None,
    canvas_h: int | None = None,
    duration: float = config.CHALLENGE_DURATION_SECONDS,
    device: str | None = None,
) -> tuple[str, dict, dict]:
    """创建一个 challenge。

    device ("pc"|"mobile"|None) 决定画布尺寸与目标方块半长（docs/issue3.md §2/§4）：
    前端在 /challenge 请求里按视口传入；后端据此选 PHANTOM_CANVAS_*_PC/MOBILE 与
    PHANTOM_TARGET_HALF_PC/MOBILE。canvas_w/canvas_h 显式入参（如非空）优先级最高，
    便于单测覆盖。device=None 时走 PC 默认，保持对旧 SDK 的向后兼容。

    返回:
      challenge_id,
      redis_value (存入 Redis 的 dict，含 session_key + control_points（评分用）+ meta),
      response_payload (返回前端的 dict：后端公钥 JWK + salt + 加密参数,
                        加密参数里【只有 pathSeed，不含控制点】)
    """
    sess = crypto.ServerSession()
    session_key = sess.derive_with_client_public(client_public_jwk)

    # 按端解析默认 canvas/target；显式入参优先（单测/调试用）
    dw, dh, dth = _resolve_device_params(device)
    if canvas_w is None:
        canvas_w = dw
    if canvas_h is None:
        canvas_h = dh
    target_half = dth

    challenge_id = str(uuid.uuid4())
    # 高熵 path_seed：16 字节 CSPRNG。控制点由前后端各自确定性派生，绝不外发。
    path_seed = secrets.token_bytes(16)
    control_points = prng.derive_bezier_path(path_seed, canvas_w, canvas_h)
    fps = config.FPS

    params = {
        "canvas": {"w": canvas_w, "h": canvas_h},
        "duration": duration,
        "fps": fps,
        "targetHalf": target_half,
        "pathSeed": prng.path_seed_bytes_to_hex(path_seed),
    }
    plaintext = json.dumps(params, separators=(",", ":")).encode()
    enc = crypto.encrypt_payload(session_key, plaintext)

    redis_value = {
        "session_key": crypto.b64u_encode(session_key),
        "control_points": control_points,
        "canvas_w": canvas_w,
        "canvas_h": canvas_h,
        "duration": duration,
        "created_at_ms": _now_ms(),
    }

    response_payload = {
        "challengeId": challenge_id,
        "serverPublicJwk": sess.public_jwk,
        "salt": sess.salt_b64u,
        "encryptedParams": enc,  # {iv, ciphertext}
    }
    return challenge_id, redis_value, response_payload


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)
