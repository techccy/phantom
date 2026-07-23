// API 客户端：/challenge /verify /consume-token。
// 时效强约束：采集结束【立即】提交，本地不缓存可重放数据（手册 §四 时效校验）。
//
// 注意：apiBase 以参数形式传入，不再依赖全局 CONFIG。这样同一个页面可挂载多个
// 指向不同后端的 widget 实例（多实例隔离），也便于 SDK 在宿主页面运行时由接入方
// 显式指定后端地址。

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

async function postJson<T>(apiBase: string, path: string, body: unknown): Promise<T> {
  const base = apiBase.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
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

export function requestChallenge(
  apiBase: string,
  clientPublicJwk: JsonWebKey,
  device?: "pc" | "mobile",
): Promise<ChallengePayload> {
  // device 用于后端按端选择 canvas_w/h 与 target_half（docs/issue3.md §2/§4）。
  // 缺省时不传，后端走 PC 默认，保持对旧 SDK 的向后兼容。
  return postJson(apiBase, "/challenge", device ? { clientPublicJwk, device } : { clientPublicJwk });
}

export function submitVerify(
  apiBase: string,
  challengeId: string,
  iv: string,
  ciphertext: string,
): Promise<VerifyResult> {
  return postJson(apiBase, "/verify", { challengeId, iv, ciphertext });
}

export function consumeToken(
  apiBase: string,
  token: string,
): Promise<{ valid: boolean }> {
  return postJson(apiBase, "/consume-token", { token });
}
