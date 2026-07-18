// 端到端验证：模拟微信内置浏览器（crypto.subtle === undefined），
// 通过 tsx 直接加载 TS 源码 crypto.ts，验证 NATIVE 探测正确走 fallback 路径，
// 并完整跑通「生成密钥 → 导入服务端公钥 → 派生 → 加密 → 解密」全流程。
//
// 运行：npx tsx scripts/e2e-fallback-test.ts
//
// 关键：必须在 import crypto.ts 之前抹掉 crypto.subtle，
// 因为 crypto.ts 顶层的 const NATIVE 是一次性求值。

import { webcrypto } from "node:crypto";

// 模拟微信 X5 内核：抹掉 subtle。getter 也破坏，让 typeof crypto.subtle 仍是 object 但值为 undefined
const realCrypto = webcrypto as any;
const realSubtle = realCrypto.subtle;
Object.defineProperty(realCrypto, "subtle", {
  value: undefined,
  configurable: true,
  writable: true,
});

// 现在加载 crypto.ts —— 它顶层的 NATIVE = !!crypto.subtle = false
const {
  generateClientKeyPair,
  importServerPublic,
  deriveSessionKey,
  encrypt,
  decrypt,
} = await import("../src/crypto.ts");

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ====== 1. 客户端 fallback：生成密钥对 ======
const { privateKey, publicJwk } = await generateClientKeyPair();
check("fallback: privateKey 是 Uint8Array（fallback 形态）", privateKey instanceof Uint8Array);
check("fallback: publicJwk 字段齐全",
  publicJwk.kty === "EC" && publicJwk.crv === "P-256"
  && typeof publicJwk.x === "string" && publicJwk.x.length > 0
  && typeof publicJwk.y === "string" && publicJwk.y.length > 0);

// ====== 2. 模拟服务端：用原生 Web Crypto（临时恢复 subtle）派生会话密钥 ======
Object.defineProperty(realCrypto, "subtle", {
  value: realSubtle, configurable: true, writable: true,
});
const HKDF_INFO = new TextEncoder().encode("phantom-v1");
const b64uEncode = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

const serverKey = await webcrypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const serverPubJwk = await webcrypto.subtle.exportKey("jwk", serverKey.publicKey);
const clientPubForServer = await webcrypto.subtle.importKey(
  "jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, [], []);
const sharedBits = await webcrypto.subtle.deriveBits(
  { name: "ECDH", public: clientPubForServer }, serverKey.privateKey, 256);
const salt = webcrypto.getRandomValues(new Uint8Array(32));
const baseKey = await webcrypto.subtle.importKey(
  "raw", sharedBits, { name: "HKDF" }, false, ["deriveKey"]);
const serverSessionKey = await webcrypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO },
  baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const saltB64u = b64uEncode(salt);

// ====== 3. 再次抹掉 subtle，让 crypto.ts 继续走 fallback ======
Object.defineProperty(realCrypto, "subtle", {
  value: undefined, configurable: true, writable: true,
});

const serverPublic = await importServerPublic(serverPubJwk);
check("fallback: importServerPublic 返回 Uint8Array", serverPublic instanceof Uint8Array);
check("fallback: 服务端公钥是 65 字节 uncompressed", (serverPublic as Uint8Array).length === 65);

const sessionKey = await deriveSessionKey(privateKey, serverPublic, saltB64u);
check("fallback: deriveSessionKey 返回 Uint8Array", sessionKey instanceof Uint8Array);

// ====== 4. AES-GCM 互通：fallback(noble) 加密 → 原生(服务端) 解密 ======
const plaintext = new TextEncoder().encode("hello phantom 微信兼容 ✓");
const { iv, ciphertext } = await encrypt(sessionKey, plaintext);
check("fallback: encrypt 返回 base64url iv/ciphertext", iv.length > 0 && ciphertext.length > 0);

Object.defineProperty(realCrypto, "subtle", {
  value: realSubtle, configurable: true, writable: true,
});
const ivBytes = new Uint8Array(Buffer.from(iv, "base64url"));
const ctBytes = new Uint8Array(Buffer.from(ciphertext, "base64url"));
const ptFromServer = await webcrypto.subtle.decrypt(
  { name: "AES-GCM", iv: ivBytes, additionalData: HKDF_INFO },
  serverSessionKey, ctBytes);
check("fallback 加密 → 原生服务端解密 互通",
  new TextDecoder().decode(ptFromServer) === "hello phantom 微信兼容 ✓");

// ====== 5. 反向：原生(服务端) 加密 → fallback(noble) 解密 ======
const iv2 = webcrypto.getRandomValues(new Uint8Array(12));
const ct2 = await webcrypto.subtle.encrypt(
  { name: "AES-GCM", iv: iv2, additionalData: HKDF_INFO },
  serverSessionKey, plaintext);
const iv2B64u = b64uEncode(iv2);
const ct2B64u = b64uEncode(new Uint8Array(ct2));

Object.defineProperty(realCrypto, "subtle", {
  value: undefined, configurable: true, writable: true,
});
const ptFromClient = await decrypt(sessionKey, iv2B64u, ct2B64u);
check("原生服务端加密 → fallback 解密 互通",
  new TextDecoder().decode(ptFromClient) === "hello phantom 微信兼容 ✓");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ HAS FAILURES"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
