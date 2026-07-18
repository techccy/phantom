// 临时会话密钥协商（ECDH P-256）+ AES-256-GCM，与后端 crypto.py 对称。
// "零前端信任"：每次验证前端生成临时 ECDH 密钥对，与服务端临时公钥协商出
// 同一会话密钥；任何全局密钥均不存在于前端代码。
//
// 浏览器兼容：优先使用原生 Web Crypto（window.crypto.subtle）。微信内置
// 浏览器（Android X5 内核 / 旧版 iOS WKWebView）下 crypto.subtle 常常缺失，
// 故探测失败时降级到 @noble/* 纯 JS 实现（协议实现无关，后端无需改动）。
// 两条路径产出的 JWK / 派生密钥 / GCM 密文格式完全一致。

import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

const HKDF_INFO = new TextEncoder().encode("phantom-v1");

/** 原生 SubtleCrypto 是否可用（安全上下文 + 内核支持）。 */
const NATIVE = typeof crypto !== "undefined" && !!crypto.subtle;

/**
 * 会话密钥句柄——对调用方不透明。
 * - 原生路径：CryptoKey（不可导出，由 SubtleCrypto 派生）
 * - fallback 路径：32 字节 raw AES key（Uint8Array）
 *
 * 调用方仅按值传递并回传给 encrypt/decrypt，无需关心具体形态。
 */
export type SessionKey = CryptoKey | Uint8Array;

/**
 * 服务端公钥句柄。
 * - 原生路径：CryptoKey（由 importKey("jwk") 得到，ECDH P-256）
 * - fallback 路径：65 字节 uncompressed 点（0x04 || X || Y）
 */
export type ServerPublic = CryptoKey | Uint8Array;

/** base64url 编解码（与后端约定一致）。 */
export function b64uEncode(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 视为 ArrayBuffer 兼容（TS 5.7 BufferSource 要求 ArrayBuffer 而非 Shared）。 */
function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** 生成前端临时 ECDH P-256 密钥对，返回私钥句柄与公钥 JWK。 */
export async function generateClientKeyPair(): Promise<{
  privateKey: SessionKey;
  publicJwk: JsonWebKey;
}> {
  if (NATIVE) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    // exportKey("jwk", ...) 的 TS 重载在当前 lib.dom 不含 jwk 分支，故以 any 绕过
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subtleAny = crypto.subtle as any;
    const publicJwk = (await subtleAny.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    return { privateKey: pair.privateKey, publicJwk };
  }

  // fallback（@noble）：私钥为 32 字节，公钥 JWK 与原生分支格式一致
  const priv = randomBytes(32);
  const pub = p256.getPublicKey(priv, false); // uncompressed: 0x04 || X(32) || Y(32)
  return {
    privateKey: priv,
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: b64uEncode(pub.subarray(1, 33)),
      y: b64uEncode(pub.subarray(33, 65)),
    },
  };
}

/** 导入服务端 ECDH 公钥（JWK → ServerPublic）。 */
export async function importServerPublic(jwk: JsonWebKey): Promise<ServerPublic> {
  if (NATIVE) {
    // importKey("jwk", ...) 的 TS 重载在当前 lib.dom 对 JsonWebKey 解析不到 jwk 分支
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subtleAny = crypto.subtle as any;
    return (await subtleAny.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      [],
      [],
    )) as CryptoKey;
  }

  // fallback（@noble）：组装成 65 字节 uncompressed 点，供 getSharedSecret 使用
  const x = b64uDecode(jwk.x as string);
  const y = b64uDecode(jwk.y as string);
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return uncompressed;
}

/** ECDH + HKDF-SHA256 派生 256 位 AES-GCM 会话密钥。 */
export async function deriveSessionKey(
  clientPrivate: SessionKey,
  serverPublic: ServerPublic,
  saltB64u: string,
): Promise<SessionKey> {
  if (NATIVE) {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverPublic as CryptoKey },
      clientPrivate as CryptoKey,
      256,
    );
    const baseKey = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      { name: "HKDF" },
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buf(b64uDecode(saltB64u)),
        info: HKDF_INFO,
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  // fallback（@noble）：
  // 1) ECDH 标量乘 → 65 字节 uncompressed 共享点；Web Crypto / cryptography
  //    的 ECDH.exchange 默认只输出 X 坐标 32 字节，故这里必须显式取 [1,33)。
  const shared = p256.getSharedSecret(
    clientPrivate as Uint8Array,
    serverPublic as Uint8Array,
  );
  const sharedX = shared.subarray(1, 33);
  // 2) HKDF-SHA256(ikm=sharedX, salt, info) → 32 字节 AES key
  return hkdf(sha256, sharedX, b64uDecode(saltB64u), HKDF_INFO, 32);
}

/** AES-256-GCM 加密，返回 {iv, ciphertext}（约定 AAD = HKDF_INFO）。 */
export async function encrypt(
  key: SessionKey,
  plaintext: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
  if (NATIVE) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: HKDF_INFO },
      key as CryptoKey,
      buf(plaintext),
    );
    return { iv: b64uEncode(iv), ciphertext: b64uEncode(ct) };
  }

  // fallback（@noble）：randomBytes 内部仍走 crypto.getRandomValues（微信可用）
  const iv = randomBytes(12);
  const cipher = gcm(key as Uint8Array, iv, HKDF_INFO); // 第三参数为 AAD
  const ct = cipher.encrypt(plaintext); // 返回 ct || tag(16)
  return { iv: b64uEncode(iv), ciphertext: b64uEncode(ct) };
}

/** AES-256-GCM 解密（约定 AAD = HKDF_INFO）。 */
export async function decrypt(
  key: SessionKey,
  ivB64u: string,
  ctB64u: string,
): Promise<Uint8Array> {
  if (NATIVE) {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buf(b64uDecode(ivB64u)),
        additionalData: HKDF_INFO,
      },
      key as CryptoKey,
      buf(b64uDecode(ctB64u)),
    );
    return new Uint8Array(pt);
  }

  // fallback（@noble）：密文末尾 16 字节为 GCM tag（与 Web Crypto 约定一致）
  const iv = b64uDecode(ivB64u);
  const ct = b64uDecode(ctB64u);
  const cipher = gcm(key as Uint8Array, iv, HKDF_INFO);
  return cipher.decrypt(ct);
}
