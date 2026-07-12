// API 客户端：/challenge 与 /verify。
// 时效强约束：采集结束【立即】提交，本地不缓存可重放数据（手册 §四 时效校验）。

import { CONFIG } from "./config";

export interface ChallengePayload {
  challengeId: string;
  serverPublicJwk: JsonWebKey;
  salt: string;
  encryptedParams: { iv: string; ciphertext: string };
}

export interface VerifyResult {
  passed: boolean;
  score: number;
  token: string | null;
  detail: Record<string, unknown>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CONFIG.apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

export function requestChallenge(clientPublicJwk: JsonWebKey): Promise<ChallengePayload> {
  return postJson("/challenge", { clientPublicJwk });
}

export function submitVerify(
  challengeId: string,
  iv: string,
  ciphertext: string,
): Promise<VerifyResult> {
  return postJson("/verify", { challengeId, iv, ciphertext });
}

export function consumeToken(token: string): Promise<{ valid: boolean }> {
  return postJson("/consume-token", { token });
}
