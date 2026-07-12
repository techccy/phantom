// 临时会话密钥协商（ECDH P-256）+ AES-256-GCM，与后端 crypto.py 对称。
// "零前端信任"：每次验证前端生成临时 ECDH 密钥对，与服务端临时公钥协商出
// 同一会话密钥；任何全局密钥均不存在于前端代码。

const HKDF_INFO = new TextEncoder().encode("phantom-v1");

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
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
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

/** 导入服务端 ECDH 公钥（JWK → CryptoKey）。 */
export async function importServerPublic(jwk: JsonWebKey): Promise<CryptoKey> {
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

/** ECDH + HKDF-SHA256 派生 256 位 AES-GCM 会话密钥。 */
export async function deriveSessionKey(
  clientPrivate: CryptoKey,
  serverPublic: CryptoKey,
  saltB64u: string,
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverPublic },
    clientPrivate,
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

/** AES-256-GCM 加密，返回 {iv, ciphertext}（约定 AAD = HKDF_INFO）。 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: HKDF_INFO },
    key,
    buf(plaintext),
  );
  return { iv: b64uEncode(iv), ciphertext: b64uEncode(ct) };
}

/** AES-256-GCM 解密（约定 AAD = HKDF_INFO）。 */
export async function decrypt(
  key: CryptoKey,
  ivB64u: string,
  ctB64u: string,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buf(b64uDecode(ivB64u)),
      additionalData: HKDF_INFO,
    },
    key,
    buf(b64uDecode(ctB64u)),
  );
  return new Uint8Array(pt);
}
