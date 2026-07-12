"""Pydantic 请求/响应 schema。"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


# ---- /challenge ----
class ChallengeRequest(BaseModel):
    clientPublicJwk: dict[str, str] = Field(
        ..., description="前端 ECDH P-256 临时公钥 JWK"
    )


class ChallengeResponse(BaseModel):
    challengeId: str
    serverPublicJwk: dict[str, str]
    salt: str
    encryptedParams: dict[str, str]


# ---- /verify ----
class VerifyRequest(BaseModel):
    challengeId: str
    iv: str
    ciphertext: str
    # 明文结构：{ points: [[x,y,t_ms],...], lastPointT_ms: int }


class VerifyResponse(BaseModel):
    passed: bool
    score: float
    token: Optional[str] = None
    detail: dict[str, Any]


# ---- /consume-token ----
class ConsumeTokenRequest(BaseModel):
    token: str


class ConsumeTokenResponse(BaseModel):
    valid: bool
