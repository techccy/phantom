"""API 集成测试：全链路、一题一答(GETDEL)、3s 时效、一票一用。

用 fakeredis + TestClient；轨迹加解密用真实 crypto 链路（前端侧由本测试模拟）。
"""
from __future__ import annotations

import json
import time

import numpy as np
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi.testclient import TestClient

from app import challenge, config, crypto, main, models
from tests.test_scoring import _human_trajectory, CP, W, H  # 复用合成轨迹


def _client_keypair():
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_numbers()
    jwk = {
        "kty": "EC", "crv": "P-256",
        "x": crypto.b64u_encode(pub.x.to_bytes(32, "big")),
        "y": crypto.b64u_encode(pub.y.to_bytes(32, "big")),
    }
    return jwk, priv


def _derive_client_session(client_priv, server_pub_jwk, salt):
    x = int.from_bytes(crypto.b64u_decode(server_pub_jwk["x"]), "big")
    y = int.from_bytes(crypto.b64u_decode(server_pub_jwk["y"]), "big")
    server_pub = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    shared = client_priv.exchange(ec.ECDH(), server_pub)
    return HKDF(algorithm=hashes.SHA256(), length=32,
                salt=salt, info=crypto.INFO).derive(shared)


@pytest.fixture
def client(fake_redis):
    return TestClient(main.app)


def _do_challenge(client):
    jwk, priv = _client_keypair()
    r = client.post("/challenge", json={"clientPublicJwk": jwk})
    assert r.status_code == 200
    payload = r.json()
    salt = crypto.b64u_decode(payload["salt"])
    session_key = _derive_client_session(priv, payload["serverPublicJwk"], salt)
    return payload, session_key


def _decrypt_params(session_key, payload):
    pt = crypto.decrypt_payload(
        session_key,
        payload["encryptedParams"]["iv"],
        payload["encryptedParams"]["ciphertext"],
    )
    return json.loads(pt)


def test_full_flow_human_passes(client):
    payload, session_key = _do_challenge(client)
    params = _decrypt_params(session_key, payload)
    assert "controlPoints" in params

    # 合成人类轨迹（基于题目真实控制点，确保 DTW 高分）
    cp = [(p[0], p[1]) for p in params["controlPoints"]]
    xs, ys, ts = _human_like_trajectory(cp, params["duration"])

    body = {"points": [[float(x), float(y), float(t)] for x, y, t in zip(xs, ys, ts)],
            "lastPointT_ms": int(time.time() * 1000)}
    enc = crypto.encrypt_payload(session_key, json.dumps(body).encode())

    r = client.post("/verify", json={
        "challengeId": payload["challengeId"],
        "iv": enc["iv"], "ciphertext": enc["ciphertext"],
    })
    assert r.status_code == 200
    res = r.json()
    assert res["passed"], res
    assert res["token"]

    # token 可一次性核销
    r2 = client.post("/consume-token", json={"token": res["token"]})
    assert r2.json()["valid"] is True
    # 二次核销失败（一票一用）
    r3 = client.post("/consume-token", json={"token": res["token"]})
    assert r3.json()["valid"] is False


def test_one_challenge_one_use(client, monkeypatch):
    """一题一答：第二次 verify 应被 GETDEL 拒绝（410）。"""
    payload, session_key = _do_challenge(client)
    params = _decrypt_params(session_key, payload)
    cp = [(p[0], p[1]) for p in params["controlPoints"]]
    xs, ys, ts = _human_like_trajectory(cp, params["duration"])

    def submit():
        body = {"points": [[float(x), float(y), float(t)] for x, y, t in zip(xs, ys, ts)],
                "lastPointT_ms": int(time.time() * 1000)}
        enc = crypto.encrypt_payload(session_key, json.dumps(body).encode())
        return client.post("/verify", json={
            "challengeId": payload["challengeId"], "iv": enc["iv"], "ciphertext": enc["ciphertext"],
        })

    r1 = submit()
    r2 = submit()
    assert r1.status_code == 200
    assert r2.status_code == 410  # 已被 GETDEL 销毁


def test_timeout_drift_rejected(client, monkeypatch):
    """时效校验：last_point_t 距 server now 超过 MAX_DRIFT_SECONDS → 拦截。"""
    payload, session_key = _do_challenge(client)
    params = _decrypt_params(session_key, payload)
    cp = [(p[0], p[1]) for p in params["controlPoints"]]
    xs, ys, ts = _human_like_trajectory(cp, params["duration"])

    # 伪造 10 秒前的 last_point_t
    stale_t = int(time.time() * 1000) - 10_000
    body = {"points": [[float(x), float(y), float(t)] for x, y, t in zip(xs, ys, ts)],
            "lastPointT_ms": stale_t}
    enc = crypto.encrypt_payload(session_key, json.dumps(body).encode())
    r = client.post("/verify", json={
        "challengeId": payload["challengeId"], "iv": enc["iv"], "ciphertext": enc["ciphertext"],
    })
    assert r.status_code == 200
    res = r.json()
    assert res["passed"] is False
    assert res["detail"]["reason"] == "timeout_drift"


def test_invalid_curve_rejected(client):
    jwk = {"kty": "EC", "crv": "P-384", "x": "a", "y": "b"}
    r = client.post("/challenge", json={"clientPublicJwk": jwk})
    assert r.status_code == 400


def test_device_selects_mobile_canvas(client):
    """device=mobile 时后端应按 Mobile 画布/目标方块尺寸下发（docs/issue3.md §2/§4）。"""
    jwk, priv = _client_keypair()
    r = client.post("/challenge", json={"clientPublicJwk": jwk, "device": "mobile"})
    assert r.status_code == 200
    payload = r.json()
    salt = crypto.b64u_decode(payload["salt"])
    session_key = _derive_client_session(priv, payload["serverPublicJwk"], salt)
    params = _decrypt_params(session_key, payload)
    assert params["canvas"]["w"] == config.CANVAS_WIDTH_MOBILE
    assert params["canvas"]["h"] == config.CANVAS_HEIGHT_MOBILE
    assert params["targetHalf"] == config.TARGET_HALF_MOBILE


def test_device_defaults_to_pc(client):
    """device 缺省时走 PC 默认（向后兼容旧 SDK）。"""
    jwk, priv = _client_keypair()
    r = client.post("/challenge", json={"clientPublicJwk": jwk})
    assert r.status_code == 200
    payload = r.json()
    salt = crypto.b64u_decode(payload["salt"])
    session_key = _derive_client_session(priv, payload["serverPublicJwk"], salt)
    params = _decrypt_params(session_key, payload)
    assert params["canvas"]["w"] == config.CANVAS_WIDTH_PC
    assert params["canvas"]["h"] == config.CANVAS_HEIGHT_PC
    assert params["targetHalf"] == config.TARGET_HALF_PC


# ---- helpers ----
def _human_like_trajectory(control_points, duration, n=300):
    """合成贴合给定贝塞尔路径的人类轨迹。"""
    cp = np.array(control_points, float)
    rng = np.random.default_rng(123)
    t = np.linspace(0, duration, n)
    u = 1 - t / duration
    v = t / duration
    px = u**3 * cp[0, 0] + 3*u**2*v*cp[1, 0] + 3*u*v**2*cp[2, 0] + v**3*cp[3, 0]
    py = u**3 * cp[0, 1] + 3*u**2*v*cp[1, 1] + 3*u*v**2*cp[2, 1] + v**3*cp[3, 1]
    # 反馈纠偏 + 8-12Hz 震颤 + 微抖
    xs = px + 2.0*np.sin(2*np.pi*1.4*t) + 1.2*np.sin(2*np.pi*10*t) + rng.normal(0, 0.9, n)
    ys = py + 1.6*np.sin(2*np.pi*2.0*t) + 0.8*np.sin(2*np.pi*9.3*t) + rng.normal(0, 0.9, n)
    ts = np.cumsum(rng.uniform(0.005, 0.04, n)) * 1000
    ts = ts - ts[0]
    return xs, ys, ts
