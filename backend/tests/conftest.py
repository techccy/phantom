"""共享测试夹具：fakeredis 注入到 store。"""
import pytest_asyncio
from fakeredis import aioredis as fake_aioredis

from app import store


@pytest_asyncio.fixture
async def fake_redis():
    client = fake_aioredis.FakeRedis(decode_responses=False)
    store.set_redis(client)
    yield client
    await client.flushall()
    await client.aclose()
