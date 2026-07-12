"""Redis 访问层（async）。

提供：
  - save_challenge / pop_challenge  （pop 使用 GETDEL 原子弹出 → 一题一答）
  - save_token / pop_token          （GETDEL → 一票一用）

测试时可注入 fakeredis.aioredis.FakeRedis。
"""
from __future__ import annotations

import json
from typing import Any, Optional

import redis.asyncio as aioredis

from . import config

_pool: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    """惰性创建连接池（单例）。"""
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(
            config.REDIS_URL, decode_responses=False
        )
    return _pool


def set_redis(client: aioredis.Redis) -> None:
    """注入自定义客户端（测试用 fakeredis）。"""
    global _pool
    _pool = client


# ---- Challenge ----
_CHALLENGE_PREFIX = "phantom:challenge:"


async def save_challenge(challenge_id: str, value: dict[str, Any]) -> None:
    r = await get_redis()
    await r.set(
        _CHALLENGE_PREFIX + challenge_id,
        json.dumps(value),
        ex=config.CHALLENGE_TTL_SECONDS,
    )


async def pop_challenge(challenge_id: str) -> Optional[dict[str, Any]]:
    """GETDEL 原子弹出。无论后续判定成败，challenge 已被销毁（一题一答）。"""
    r = await get_redis()
    raw = await r.getdel(_CHALLENGE_PREFIX + challenge_id)
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode()
    return json.loads(raw)


# ---- Token ----
_TOKEN_PREFIX = "phantom:token:"


async def save_token(token: str) -> None:
    r = await get_redis()
    await r.set(_TOKEN_PREFIX + token, b"1", ex=config.TOKEN_TTL_SECONDS)


async def pop_token(token: str) -> bool:
    """GETDEL：一次性消费。返回是否成功消费。"""
    r = await get_redis()
    raw = await r.getdel(_TOKEN_PREFIX + token)
    return raw is not None
