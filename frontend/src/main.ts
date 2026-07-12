// 入口：状态机编排一次完整验证流程。
//
// 流程（手册 §三 用户交互与业务流程）：
//  1) 加载 → 协商会话密钥 → 解密路径参数 → 启动动态显影
//  2) 用户按住"激活"按钮 → 肉眼跟随移动方块 → tracker 采集轨迹
//  3) 松开/超时 → 立即加密轨迹 → 提交 /verify → 展示判定

import { CONFIG } from "./config";
import { consumeToken, requestChallenge, submitVerify } from "./api";
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  generateClientKeyPair,
  importServerPublic,
} from "./crypto";
import { installAntidebug } from "./antidebug";
import { PhantomRenderer, type BezierParams } from "./renderer";
import { TrajectoryTracker } from "./tracker";

const isProd = import.meta.env.PROD;
installAntidebug(isProd);

interface Elements {
  canvas: HTMLCanvasElement;
  activateBtn: HTMLButtonElement;
  status: HTMLElement;
  result: HTMLElement;
}

function getElements(): Elements {
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const activateBtn = document.getElementById("activate") as HTMLButtonElement;
  const status = document.getElementById("status") as HTMLElement;
  const result = document.getElementById("result") as HTMLElement;
  if (!canvas || !activateBtn || !status || !result) {
    throw new Error("DOM 元素缺失");
  }
  return { canvas, activateBtn, status, result };
}

async function bootstrap(): Promise<void> {
  const el = getElements();
  el.canvas.width = CONFIG.canvasWidth;
  el.canvas.height = CONFIG.canvasHeight;
  el.status.textContent = "正在准备验证题…";

  // 1) 协商会话密钥 + 取题
  const { privateKey, publicJwk } = await generateClientKeyPair();
  const challenge = await requestChallenge(publicJwk);
  const serverPub = await importServerPublic(challenge.serverPublicJwk);
  const sessionKey = await deriveSessionKey(
    privateKey,
    serverPub,
    challenge.salt,
  );

  // 2) 解密路径参数
  const paramsJson = await decrypt(
    sessionKey,
    challenge.encryptedParams.iv,
    challenge.encryptedParams.ciphertext,
  );
  const params = JSON.parse(new TextDecoder().decode(paramsJson)) as BezierParams;
  const renderer = new PhantomRenderer(el.canvas, params);
  const tracker = new TrajectoryTracker(el.canvas);

  // 启动动态显影（用户此时肉眼可见移动方块）
  el.status.textContent = "按住下方按钮，跟随移动的方块";
  renderer.start();

  // 3) 按住激活 → 开始采集；松开 → 提交
  let collecting = false;
  const onDown = (): void => {
    if (collecting) return;
    collecting = true;
    tracker.start();
    el.status.textContent = "跟随方块移动…";
  };
  const onUp = async (): Promise<void> => {
    if (!collecting) return;
    collecting = false;
    const samples = tracker.stop();
    await verifyAndFinish(renderer, sessionKey, challenge.challengeId, samples, el);
  };
  el.activateBtn.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
}

async function verifyAndFinish(
  renderer: PhantomRenderer,
  sessionKey: CryptoKey,
  challengeId: string,
  samples: [number, number, number][],
  el: Elements,
): Promise<void> {
  // 立即提交（时效强约束，禁本地缓存可重放数据）
  const payload = {
    points: samples,
    lastPointT_ms: samples.length ? samples[samples.length - 1][2] : 0,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const { iv, ciphertext } = await encrypt(sessionKey, plaintext);

  try {
    const result = await submitVerify(challengeId, iv, ciphertext);
    renderer.stop();
    el.result.textContent = result.passed
      ? `✅ 通过 (score ${result.score.toFixed(2)})`
      : `❌ 未通过 (score ${result.score.toFixed(2)})`;
    el.status.textContent = result.passed ? "验证成功" : "验证失败";

    // 演示 token 核销（业务端实际调用）
    if (result.token) {
      const consume = await consumeToken(result.token);
      console.log("token 核销:", consume.valid);
    }
  } catch (e) {
    renderer.stop();
    el.status.textContent = "提交失败";
    el.result.textContent = `⚠️ ${(e as Error).message}`;
  }
}

bootstrap().catch((e) => {
  console.error(e);
  const status = document.getElementById("status");
  if (status) status.textContent = `初始化失败: ${(e as Error).message}`;
});
