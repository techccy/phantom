"""Challenge 创建：贝塞尔路径生成 + 参数加密下发。

路径参数（控制点、噪点 seed、画布尺寸、时长）用会话密钥 AES-256-GCM 加密
后下发；前端用同一会话密钥解密。手册要求"零前端信任"——前端代码被抄走也
无法伪造或预判题目。
"""
from __future__ import annotations

import json
import secrets
import uuid

from . import config, crypto

# 目标方块尺寸（画布相对）
TARGET_HALF = 22


def _random_point_in_canvas(w: int, h: int, margin: int = 40) -> tuple[float, float]:
    return (
        float(secrets.randbelow(w - 2 * margin) + margin),
        float(secrets.randbelow(h - 2 * margin) + margin),
    )


def generate_bezier_path(
    w: int, h: int
) -> list[tuple[float, float]]:
    """生成 4 控制点三次贝塞尔，保证起点→终点跨度足够、曲率有界。

    起点与终点距离至少占画布对角线 35%，避免过短轨迹无法评分。
    """
    diag = (w**2 + h**2) ** 0.5
    for _ in range(50):
        p0 = _random_point_in_canvas(w, h)
        p3 = _random_point_in_canvas(w, h)
        if ((p3[0] - p0[0]) ** 2 + (p3[1] - p0[1]) ** 2) ** 0.5 >= 0.35 * diag:
            break
    # 控制点偏向画布内侧，避免路径冲出边界
    p1 = _random_point_in_canvas(w, h, margin=70)
    p2 = _random_point_in_canvas(w, h, margin=70)
    return [p0, p1, p2, p3]


def create_challenge(
    client_public_jwk: dict,
    canvas_w: int = config.CANVAS_WIDTH,
    canvas_h: int = config.CANVAS_HEIGHT,
    duration: float = config.CHALLENGE_DURATION_SECONDS,
) -> tuple[str, dict, dict]:
    """创建一个 challenge。

    返回:
      challenge_id,
      redis_value (存入 Redis 的 dict，含 session_key + path + meta，由 store 序列化),
      response_payload (返回前端的 dict：后端公钥 JWK + salt + 加密参数)
    """
    sess = crypto.ServerSession()
    session_key = sess.derive_with_client_public(client_public_jwk)

    challenge_id = str(uuid.uuid4())
    control_points = generate_bezier_path(canvas_w, canvas_h)
    noise_seed = secrets.token_bytes(16).hex()
    fps = 60

    params = {
        "canvas": {"w": canvas_w, "h": canvas_h},
        "duration": duration,
        "fps": fps,
        "controlPoints": control_points,
        "targetHalf": TARGET_HALF,
        "noiseSeed": noise_seed,
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
