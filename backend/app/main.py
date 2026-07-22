"""FastAPI 应用：/challenge /verify /consume-token。

安全约束（手册 §四）：
  - 零前端信任：每次 ECDH 临时会话密钥
  - 一题一答：verify 用 GETDEL 弹出 challenge，第二次必失败
  - 一票一用：consume-token 用 GETDEL 弹出 token
  - 严防时间差：last_point_t 与 server now 差 > MAX_DRIFT_SECONDS 直接拦截
"""
from __future__ import annotations

import json
import logging
import time

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from . import challenge, config, crypto, models, scoring, store

app = FastAPI(title="Phantom", version="0.1.0")

# 调试日志：开启后（PHANTOM_DEBUG=1）打印每次 /verify 的采集轨迹与原分属明细。
logger = logging.getLogger("phantom")
if config.DEBUG:
    logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    logger.setLevel(logging.DEBUG)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    # OPTIONS 必须放开以处理浏览器跨域预检（CORS preflight）
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


def _now_ms() -> int:
    return int(time.time() * 1000)


@app.post("/challenge", response_model=models.ChallengeResponse)
async def create_challenge(req: models.ChallengeRequest):
    """下发一道题：协商会话密钥 + 加密路径参数。"""
    if not {"kty", "crv", "x", "y"}.issubset(req.clientPublicJwk):
        raise HTTPException(400, "invalid client public jwk")
    if req.clientPublicJwk.get("crv") != "P-256":
        raise HTTPException(400, "unsupported curve")

    challenge_id, redis_value, payload = challenge.create_challenge(
        req.clientPublicJwk
    )
    await store.save_challenge(challenge_id, redis_value)
    return models.ChallengeResponse(**payload)


@app.post("/verify", response_model=models.VerifyResponse)
async def verify(req: models.VerifyRequest):
    """一次性校验：GETDEL challenge → 解密轨迹 → 时效校验 → 评分 → 签发 token。"""
    # 1) 一题一答：原子弹出
    record = await store.pop_challenge(req.challengeId)
    if record is None:
        raise HTTPException(410, "challenge expired or already used")

    session_key = crypto.b64u_decode(record["session_key"])

    # 2) 解密轨迹
    try:
        plaintext = crypto.decrypt_payload(session_key, req.iv, req.ciphertext)
        data = json.loads(plaintext)
    except Exception:
        raise HTTPException(400, "decryption failed")

    points = data.get("points") or []
    last_point_t = int(data.get("lastPointT_ms", 0))
    if len(points) < 2:
        return _failed("no_trajectory")

    # 3) 时效校验（防离线慢算）
    drift_s = (_now_ms() - last_point_t) / 1000.0 - config.CLOCK_SKEW_MS / 1000.0
    if drift_s > config.MAX_DRIFT_SECONDS:
        return _failed("timeout_drift", drift_s=round(drift_s, 3))

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    ts = [p[2] for p in points]

    # [DEBUG] 采集到的数据：完整轨迹、时效、题面参数
    if config.DEBUG:
        logger.debug(
            "[verify] 采集数据 challenge_id=%s n_points=%d last_point_t_ms=%d drift_s=%.3f "
            "canvas=%sx%s control_points=%s",
            req.challengeId,
            len(points),
            last_point_t,
            drift_s,
            record.get("canvas_w"),
            record.get("canvas_h"),
            record.get("control_points"),
        )
        logger.debug(
            "[verify] 轨迹明细 challenge_id=%s points=%s",
            req.challengeId,
            points,
        )

    # 4) 评分
    breakdown = scoring.engine.score_trajectory(
        xs,
        ys,
        ts,
        record["control_points"],
        record["canvas_w"],
        record["canvas_h"],
    )
    detail = scoring.engine.breakdown_to_dict(breakdown)

    # [DEBUG] 原分属：综合分 + DTW/Bio 子分 + 各生理特征与子项
    if config.DEBUG:
        logger.debug(
            "[verify] 原分属 challenge_id=%s passed=%s composite=%.4f s_dtw=%.4f s_bio=%.4f "
            "smoothness_veto=%s residual_energy=%.5f jerk_variance=%.5f "
            "accel_zerocrossings=%d tremor_amplitude_px=%.5f psd_8_12_ratio=%.5f "
            "energy_score=%.4f zc_score=%.4f tremor_score=%.4f extras=%s",
            req.challengeId,
            breakdown.passed,
            breakdown.composite,
            breakdown.s_dtw,
            breakdown.s_bio,
            breakdown.smoothness_veto,
            breakdown.residual_energy,
            breakdown.jerk_variance,
            breakdown.accel_zerocrossings,
            breakdown.tremor_amplitude_px,
            breakdown.psd_8_12_ratio,
            breakdown.energy_score,
            breakdown.zc_score,
            breakdown.tremor_score,
            breakdown.extras,
        )

    # 5) 通过则签发一次性 token
    token = None
    if breakdown.passed:
        token = crypto.issue_token()
        await store.save_token(token)

    return models.VerifyResponse(
        passed=breakdown.passed,
        score=breakdown.composite,
        token=token,
        detail=detail,
    )


def _failed(reason: str, **extra) -> models.VerifyResponse:
    return models.VerifyResponse(
        passed=False,
        score=0.0,
        token=None,
        detail={"reason": reason, **extra},
    )


@app.post("/consume-token", response_model=models.ConsumeTokenResponse)
async def consume_token(req: models.ConsumeTokenRequest):
    """业务端核销：一票一用，GETDEL 弹出。"""
    if not crypto.verify_token_sig(req.token):
        return models.ConsumeTokenResponse(valid=False)
    ok = await store.pop_token(req.token)
    return models.ConsumeTokenResponse(valid=ok)
