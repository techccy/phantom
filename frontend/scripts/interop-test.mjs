// 协议互通性自检：验证 @noble fallback 路径与原生 Web Crypto 在相同输入下
// 派生出相同会话密钥、加解密互通。等价于证明 fallback 与后端互通。
//
// 运行：node scripts/interop-test.mjs
// 不依赖项目源（crypto.ts 是 TS），直接镜像其双路径实现做对照。

import { webcrypto } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

const HKDF_INFO = new TextEncoder().encode("phantom-v1");

function b64uEncode(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return Buffer.from(s, "binary").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function buf(u) { return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ====== 模拟"服务端"用原生 Web Crypto 生成 ECDH key pair（等价后端行为） ======
const serverKey = await webcrypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const serverPubJwk = await webcrypto.subtle.exportKey("jwk", serverKey.publicKey);

// ====== 客户端用 noble 生成（fallback 路径） ======
const clientPriv = randomBytes(32);
const clientPub = p256.getPublicKey(clientPriv, false);
const clientPubJwk = {
  kty: "EC", crv: "P-256",
  x: b64uEncode(clientPub.subarray(1, 33)),
  y: b64uEncode(clientPub.subarray(33, 65)),
};
check("客户端 JWK 字段齐全", clientPubJwk.kty === "EC" && clientPubJwk.crv === "P-256"
  && clientPubJwk.x.length > 0 && clientPubJwk.y.length > 0);

// ====== 双向派生会话密钥，对照是否一致 ======
const salt = randomBytes(32);
const saltB64u = b64uEncode(salt);

// 路径 A：客户端（noble）派生
const serverPubBytes = new Uint8Array(65);
serverPubBytes[0] = 0x04;
serverPubBytes.set(b64uDecode(serverPubJwk.x), 1);
serverPubBytes.set(b64uDecode(serverPubJwk.y), 33);
const sharedClient = p256.getSharedSecret(clientPriv, serverPubBytes);
const sharedXClient = sharedClient.subarray(1, 33);
const sessionKeyClient = hkdf(sha256, sharedXClient, salt, HKDF_INFO, 32);

// 路径 B：服务端（原生 Web Crypto）派生——等价后端 cryptography 库
const clientPubForNative = await webcrypto.subtle.importKey(
  "jwk", clientPubJwk, { name: "ECDH", namedCurve: "P-256" }, [], []);
const sharedBitsServer = await webcrypto.subtle.deriveBits(
  { name: "ECDH", public: clientPubForNative }, serverKey.privateKey, 256);
const baseKey = await webcrypto.subtle.importKey(
  "raw", sharedBitsServer, { name: "HKDF" }, false, ["deriveKey"]);
const sessionKeyServerCryptoKey = await webcrypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: HKDF_INFO },
  baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
// CryptoKey 不可导出，但只要 GCM 互通即可证明派生一致（AES-GCM 密钥不一致必失败）

// ====== AES-256-GCM 互通（等价于会话密钥一致性证明） ======
// noble 加密
const iv = randomBytes(12);
const plaintext = new TextEncoder().encode("hello phantom 微信兼容");
const cipherNoble = gcm(sessionKeyClient, iv, HKDF_INFO);
const ct = cipherNoble.encrypt(plaintext);
// 原生解密
const ptDecrypted = await webcrypto.subtle.decrypt(
  { name: "AES-GCM", iv: buf(iv), additionalData: HKDF_INFO },
  sessionKeyServerCryptoKey, buf(ct));
check("客户端(noble) ↔ 服务端(原生) 派生相同会话密钥（GCM 互通证明）",
  new TextDecoder().decode(ptDecrypted) === "hello phantom 微信兼容");

// 原生加密
const iv2 = randomBytes(12);
const ct2 = await webcrypto.subtle.encrypt(
  { name: "AES-GCM", iv: buf(iv2), additionalData: HKDF_INFO },
  sessionKeyServerCryptoKey, buf(plaintext));
// noble 解密
const cipherNoble2 = gcm(sessionKeyClient, iv2, HKDF_INFO);
const pt2 = cipherNoble2.decrypt(new Uint8Array(ct2));
check("原生加密 → noble 解密 互通",
  new TextDecoder().decode(pt2) === "hello phantom 微信兼容");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ HAS FAILURES"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
