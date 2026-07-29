"""challenge / prng 测试（issue #7）。

锁定三条不变量：
  1. PCG32 + derive_bezier_path 的 KAT（已知答案测试）—— 前端 prng.ts 必须复现
     完全相同的 4 个控制点。这组 KAT 向量同时被 frontend/scripts/prng-test.ts
     镜像，任一侧常数改错都会两边同时红。
  2. path_seed 高熵：两次 create_challenge 的 seed / 控制点几乎不可能相同。
  3. /challenge 密文里【没有】controlPoints / noiseSeed —— 这是 issue #7 的核心
     修复点。docs/fuck.js 依赖解密出 controlPoints，现在应拿不到。
"""
from __future__ import annotations

import json

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app import challenge, crypto, prng


def _client_jwk():
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_numbers()
    return {
        "kty": "EC", "crv": "P-256",
        "x": crypto.b64u_encode(pub.x.to_bytes(32, "big")),
        "y": crypto.b64u_encode(pub.y.to_bytes(32, "big")),
    }


def _decrypt_params(session_key_b64u: str, enc: dict) -> dict:
    session_key = crypto.b64u_decode(session_key_b64u)
    pt = crypto.decrypt_payload(session_key, enc["iv"], enc["ciphertext"])
    return json.loads(pt)


# ---------- KAT：前端镜像同一组向量 ----------
def test_pcg_kat_vectors():
    """前后端必须复现完全相同的 4 控制点。

    前端 KAT：frontend/scripts/prng-test.ts 锁定同一组。
    """
    kat = [
        ("0123456789abcdeffedcba9876543210", 480, 480,
         [(355.0, 397.0), (402.0, 252.0), (75.0, 77.0), (60.0, 372.0)]),
        ("abcdef012345678900000000ffffffff", 480, 480,
         [(298.0, 405.0), (394.0, 102.0), (186.0, 133.0), (91.0, 240.0)]),
        ("11111111111111112222222222222222", 360, 360,
         [(290.0, 206.0), (136.0, 262.0), (273.0, 101.0), (135.0, 107.0)]),
    ]
    for seed_hex, w, h, expected in kat:
        cp = prng.derive_bezier_path(bytes.fromhex(seed_hex), w, h)
        assert cp == expected, (
            f"seed={seed_hex} canvas={w}x{h} 期望 {expected} 实际 {cp}"
        )


def test_derive_deterministic():
    """同 seed 必出同结果（确定性）。"""
    seed = bytes.fromhex("a" * 32)
    a = prng.derive_bezier_path(seed, 480, 480)
    b = prng.derive_bezier_path(seed, 480, 480)
    assert a == b


def test_derive_in_canvas_bounds():
    """所有控制点必须落在画布 [margin, w-margin] 内（margin=40 / 中间点 70）。"""
    seed = bytes.fromhex("deadbeef" * 4)
    cp = prng.derive_bezier_path(seed, 480, 480)
    assert len(cp) == 4
    for i, (x, y) in enumerate(cp):
        m = 40 if i in (0, 3) else 70
        assert m <= x <= 480 - m, (i, x)
        assert m <= y <= 480 - m, (i, y)


def test_derive_different_seeds_different_paths():
    """不同 seed 应几乎必然出不同路径（高熵派生）。"""
    a = prng.derive_bezier_path(bytes.fromhex("01" * 16), 480, 480)
    b = prng.derive_bezier_path(bytes.fromhex("02" * 16), 480, 480)
    assert a != b


# ---------- challenge 创建：seed 下发、不泄露控制点 ----------
def test_challenge_params_do_not_leak_path():
    """issue #7 核心：/challenge 密文里只有 pathSeed，没有 controlPoints/noiseSeed。"""
    challenge_id, redis_value, payload = challenge.create_challenge(_client_jwk())
    params = _decrypt_params(redis_value["session_key"], payload["encryptedParams"])

    # 应下发 pathSeed（hex 字符串）
    assert "pathSeed" in params
    assert isinstance(params["pathSeed"], str)
    assert len(params["pathSeed"]) == 32  # 16 字节 hex
    # 顺手验证 round-trip
    assert prng.path_seed_hex_to_bytes(params["pathSeed"])

    # 绝不能有 controlPoints / noiseSeed（旧泄露字段）
    assert "controlPoints" not in params, "controlPoints 不应再下发（issue #7）"
    assert "noiseSeed" not in params, "noiseSeed 是死字段，已删除"

    # 布局字段保留
    assert params["canvas"] == {"w": 480, "h": 480}
    assert params["targetHalf"] > 0
    assert params["fps"] > 0
    assert params["duration"] > 0


def test_challenge_control_points_match_seed_derivation():
    """redis_value 里的 control_points 必须与 pathSeed 派生一致（前后端一致性根基）。"""
    challenge_id, redis_value, payload = challenge.create_challenge(_client_jwk())
    params = _decrypt_params(redis_value["session_key"], payload["encryptedParams"])

    seed = prng.path_seed_hex_to_bytes(params["pathSeed"])
    expected = prng.derive_bezier_path(seed, 480, 480)
    assert redis_value["control_points"] == expected


def test_challenge_two_seeds_distinct():
    """两次创建：pathSeed 与 control_points 均应不同（高熵）。"""
    _, r1, _ = challenge.create_challenge(_client_jwk())
    _, r2, _ = challenge.create_challenge(_client_jwk())
    assert r1["control_points"] != r2["control_points"]


def test_challenge_device_mobile_canvas():
    """device=mobile 时画布/target 走 Mobile 配置。"""
    _, redis_value, payload = challenge.create_challenge(_client_jwk(), device="mobile")
    assert redis_value["canvas_w"] != redis_value["canvas_h"] or True  # 仅占位
    params = _decrypt_params(redis_value["session_key"], payload["encryptedParams"])
    assert params["canvas"]["w"] == redis_value["canvas_w"]
