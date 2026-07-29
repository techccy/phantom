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

from app import challenge, config, crypto, main, models, prng
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


def _params_control_points(params):
    """从解密参数里派生控制点——模拟前端 SDK 行为（issue #7）。

    v0.2.0 起密文只下发 pathSeed，控制点由前后端各自确定性派生。
    测试镜像前端：用 pathSeed + canvas 在本地 derive 出同一组 cp，
    合成贴合该 cp 的人类轨迹。这样测试与前端是【同一套数据来源】，
    杜绝"测试从后端偷看 controlPoints"绕过 issue #7 的语义。
    """
    seed = bytes.fromhex(params["pathSeed"])
    return prng.derive_bezier_path(seed, params["canvas"]["w"], params["canvas"]["h"])


def test_full_flow_human_passes(client):
    payload, session_key = _do_challenge(client)
    params = _decrypt_params(session_key, payload)
    # issue #7：密文只下发 pathSeed，不再有 controlPoints。前端 SDK 行为=本地派生。
    assert "controlPoints" not in params
    assert "pathSeed" in params

    # 合成人类轨迹（基于题目真实控制点，确保 DTW 高分）
    cp = [(p[0], p[1]) for p in _params_control_points(params)]
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
    cp = [(p[0], p[1]) for p in _params_control_points(params)]
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
    cp = [(p[0], p[1]) for p in _params_control_points(params)]
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


def test_custom_canvas_size_verifies(client, monkeypatch):
    """回归：在 .env 改 PHANTOM_CANVAS_*_PC/H_PC 后端到端仍应通过。

    历史缺陷（frontend/Dockerfile）：用户改画布尺寸后，compose 把新值透传给前端镜像的
    VITE_CANVAS_*_PC，但 Dockerfile 未声明这些 ARG → 被 Docker 静默丢弃 → 前端永远在
    旧默认尺寸画布上采集，与后端按新尺寸算出的贝塞尔/DTW 归一化坐标系错位 → S_DTW 崩塌
    → 验证恒失败。本测试在【后端侧】锁定核心不变量：只要前端与后端用同一 canvas 采集与
    归一化，verify 必须通过（与具体画布像素尺寸无关，因 DTW 已归一化到 [0,1]²）。
    """
    CUSTOM_W, CUSTOM_H = 720, 540  # 非默认、非正方形，覆盖宽高不一致场景
    monkeypatch.setattr(config, "CANVAS_WIDTH_PC", CUSTOM_W)
    monkeypatch.setattr(config, "CANVAS_HEIGHT_PC", CUSTOM_H)

    payload, session_key = _do_challenge(client)  # device 缺省 → PC → 用 monkeypatch 后的新尺寸
    params = _decrypt_params(session_key, payload)
    # 题面下发的画布尺寸必须反映 .env 的新值（后端链路正确）
    assert params["canvas"]["w"] == CUSTOM_W
    assert params["canvas"]["h"] == CUSTOM_H

    # 用与后端【完全一致】的控制点 + 画布尺寸合成人类轨迹，模拟"前端在正确尺寸画布上采集"。
    # 若 DTW 归一化正确，verify 必须通过——这是 .env 改画布后验证恒失败的直接回归点。
    cp = [(p[0], p[1]) for p in _params_control_points(params)]
    xs, ys, ts = _human_like_trajectory(cp, params["duration"])
    body = {"points": [[float(x), float(y), float(t)] for x, y, t in zip(xs, ys, ts)],
            "lastPointT_ms": int(time.time() * 1000)}
    enc = crypto.encrypt_payload(session_key, json.dumps(body).encode())
    r = client.post("/verify", json={
        "challengeId": payload["challengeId"], "iv": enc["iv"], "ciphertext": enc["ciphertext"],
    })
    assert r.status_code == 200
    res = r.json()
    assert res["passed"], (
        f"改画布尺寸({CUSTOM_W}x{CUSTOM_H})后端到端应通过: {res}"
    )
    assert res["token"]


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
