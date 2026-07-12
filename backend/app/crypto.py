"""密码学：临时会话密钥协商（ECDH P-256）+ AES-256-GCM + Token HMAC。

"零前端信任"——服务端不持有任何全局对称密钥用于轨迹加密；每次验证使用
前端临时公钥与服务端临时私钥协商出的会话密钥。会话密钥仅在 Redis 中存活
一个 challenge 周期，GETDEL 后即销毁。

JWK 互通约定（与浏览器 Web Crypto 兼容）：
  ECDH P-256 公钥 JWK: {"kty":"EC","crv":"P-256","x":<b64u>,"y":<b64u>}
  派生: ECDH → SHA256 → HKDF(salt=random32, info=b"phantom-v1", 32 bytes) → AES-256 key
"""
from __future__ import annotations

import base64
import hmac as _hmac
import hashlib
import secrets

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import config

INFO = b"phantom-v1"


# ---------- base64url ----------
def b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


# ---------- ECDH 会话密钥 ----------
class ServerSession:
    """一次 challenge 的服务端 ECDH 临时密钥对 + 派生出的会话密钥。"""

    def __init__(self) -> None:
        self._priv = ec.generate_private_key(ec.SECP256R1())
        self._salt = secrets.token_bytes(32)
        self._session_key: bytes | None = None

    @property
    def public_jwk(self) -> dict:
        """导出后端临时公钥（JWK, P-256），供前端派生同一密钥。"""
        pub = self._priv.public_key().public_numbers()
        size = (ec.SECP256R1().key_size + 7) // 8  # 32
        return {
            "kty": "EC",
            "crv": "P-256",
            "x": b64u_encode(pub.x.to_bytes(size, "big")),
            "y": b64u_encode(pub.y.to_bytes(size, "big")),
        }

    @property
    def salt_b64u(self) -> str:
        return b64u_encode(self._salt)

    def derive_with_client_public(self, client_jwk: dict) -> bytes:
        """用前端 ECDH 公钥 + 本端私钥派生 32 字节会话密钥。"""
        x = int.from_bytes(b64u_decode(client_jwk["x"]), "big")
        y = int.from_bytes(b64u_decode(client_jwk["y"]), "big")
        pub_numbers = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1())
        client_pub = pub_numbers.public_key()
        shared = self._priv.exchange(ec.ECDH(), client_pub)
        self._session_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=self._salt,
            info=INFO,
        ).derive(shared)
        return self._session_key

    @property
    def session_key(self) -> bytes:
        if self._session_key is None:
            raise RuntimeError("会话密钥尚未派生")
        return self._session_key


def derive_session_key_from_jwks(
    server_priv_pem_or_obj, client_jwk: dict, salt: bytes
) -> bytes:
    """从已落盘的服务端私钥 + 前端公钥派生（verify 阶段 Redis 取回时用）。

    本工程选择把派生好的 session_key 直接存 Redis（更简洁、私钥不落盘），
    此函数保留以备需要私钥重建场景。
    """
    raise NotImplementedError("本实现直接存 session_key，无需重建")


# ---------- AES-256-GCM ----------
def encrypt_payload(session_key: bytes, plaintext: bytes) -> dict:
    """AES-256-GCM 加密，返回 {iv, ciphertext}（Web Crypto 约定 tag 拼在 ct 末尾）。"""
    iv = secrets.token_bytes(12)
    ct = AESGCM(session_key).encrypt(iv, plaintext, associated_data=INFO)
    return {"iv": b64u_encode(iv), "ciphertext": b64u_encode(ct)}


def decrypt_payload(session_key: bytes, iv_b64u: str, ct_b64u: str) -> bytes:
    iv = b64u_decode(iv_b64u)
    ct = b64u_decode(ct_b64u)
    return AESGCM(session_key).decrypt(iv, ct, associated_data=INFO)


# ---------- Token (HMAC 签名一次性凭证) ----------
def issue_token() -> str:
    """签发一次性 token：nonce.hmac。

    服务端在 Redis 记录 token:{token} → 1（TTL），消费时 GETDEL 销毁。
    HMAC 防伪造（需 TOKEN_HMAC_SECRET）。
    """
    nonce = secrets.token_urlsafe(24)
    sig = _hmac.new(config.TOKEN_HMAC_SECRET, nonce.encode(), hashlib.sha256).hexdigest()
    return f"{nonce}.{sig[:32]}"


def verify_token_sig(token: str) -> bool:
    if "." not in token:
        return False
    nonce, sig = token.rsplit(".", 1)
    expected = _hmac.new(
        config.TOKEN_HMAC_SECRET, nonce.encode(), hashlib.sha256
    ).hexdigest()[:32]
    return _hmac.compare_digest(sig, expected)
