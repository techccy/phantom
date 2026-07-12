"""crypto 测试：ECDH 会话密钥一致性、AES-GCM 往返、token 签发/校验。"""
from __future__ import annotations

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app import crypto


def _client_jwk() -> tuple[dict, ec.EllipticCurvePrivateKey]:
    """生成"前端" ECDH 密钥对，返回公钥 JWK + 私钥（用于模拟前端派生）。"""
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_numbers()
    size = 32
    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": crypto.b64u_encode(pub.x.to_bytes(size, "big")),
        "y": crypto.b64u_encode(pub.y.to_bytes(size, "big")),
    }
    return jwk, priv


def _client_derive(client_priv: ec.EllipticCurvePrivateKey, server_pub_jwk: dict, salt: bytes) -> bytes:
    """模拟前端用后端公钥派生同一会话密钥。"""
    x = int.from_bytes(crypto.b64u_decode(server_pub_jwk["x"]), "big")
    y = int.from_bytes(crypto.b64u_decode(server_pub_jwk["y"]), "big")
    server_pub = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    shared = client_priv.exchange(ec.ECDH(), server_pub)
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=salt, info=crypto.INFO
    ).derive(shared)


def test_ecdh_session_key_matches_client():
    """服务端与前端应派生出完全相同的会话密钥。"""
    client_jwk, client_priv = _client_jwk()
    sess = crypto.ServerSession()
    server_key = sess.derive_with_client_public(client_jwk)
    client_key = _client_derive(client_priv, sess.public_jwk, crypto.b64u_decode(sess.salt_b64u))
    assert server_key == client_key


def test_aes_gcm_roundtrip():
    """加解密往返；篡改密文应失败。"""
    key = b"\x00" * 32
    enc = crypto.encrypt_payload(key, b"phantom-secret")
    assert crypto.decrypt_payload(key, enc["iv"], enc["ciphertext"]) == b"phantom-secret"

    # 错误密钥 → 失败
    bad = b"\x01" * 32
    try:
        crypto.decrypt_payload(bad, enc["iv"], enc["ciphertext"])
        assert False, "应抛异常"
    except Exception:
        pass


def test_token_issue_and_verify():
    tok = crypto.issue_token()
    assert crypto.verify_token_sig(tok)
    assert not crypto.verify_token_sig("tampered.aaaa")
    assert not crypto.verify_token_sig("noseparator")


def test_server_session_requires_derive():
    sess = crypto.ServerSession()
    try:
        _ = sess.session_key
        assert False, "未派生应抛错"
    except RuntimeError:
        pass
