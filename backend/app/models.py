"""Pydantic 请求/响应 schema。"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


# ---- /challenge ----
# JWK 成员值可为 str / bool / list 等（RFC 7517），浏览器 exportKey 会附带
# ext(bool)、key_ops(list) 等字段，故以 dict[str, Any] 接收；后端只取 kty/crv/x/y。
class ChallengeRequest(BaseModel):
    clientPublicJwk: dict[str, Any] = Field(
        ..., description="前端 ECDH P-256 临时公钥 JWK"
    )
    # 端类型（docs/issue3.md §2/§4）：后端据此选择 PC/Mobile 的画布尺寸与目标方块半长。
    # 可选——缺省走 PC 默认，保持对旧 SDK 的向后兼容。
    device: Optional[str] = Field(default=None, description='"pc" | "mobile"，缺省=pc')


class ChallengeResponse(BaseModel):
    challengeId: str
    serverPublicJwk: dict[str, Any]
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
