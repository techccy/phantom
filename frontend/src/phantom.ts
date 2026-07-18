// Phantom 人机验证 SDK 公共入口。
//
// 把原先散落在 main.ts 里的"一次性 bootstrap 流程"重构为可重复调用、可传参、
// 有回调的 mount() 工厂，使第三方网站能像 reCAPTCHA 那样引一个 script + 一个
// 容器即接入。
//
// 流程（与 main.ts 原实现一致，手册 §三）：
//   1) mount → 自建 DOM → 协商会话密钥 → 解密路径参数 → 启动动态显影
//   2) 用户按住"激活"按钮 → 肉眼跟随移动方块 → tracker 采集轨迹
//   3) 松开 → 立即加密轨迹 → 提交 /verify → 通过回调回传 { passed, score, token }
//
// 关键语义修正（相对旧 main.ts）：
//   - 不再在浏览器侧自动调用 /consume-token 核销 token。token 通过 onSuccess
//     回调交给接入方，由接入方后端在自己的业务流程里核销（见接入文档）。

import { CONFIG } from "./config";
import {
  requestChallenge,
  submitVerify,
  type VerifyResult,
} from "./api";
import {
  decrypt,
  deriveSessionKey,
  encrypt,
  generateClientKeyPair,
  importServerPublic,
  type SessionKey,
} from "./crypto";
import { installAntidebug } from "./antidebug";
import { PhantomRenderer, type BezierParams } from "./renderer";
import { TrajectoryTracker } from "./tracker";
import { injectStyles, type Theme } from "./styles";

export type { VerifyResult } from "./api";

export interface PhantomOptions {
  /** 后端地址，必填，如 "https://phantom.you.com" 或开发态 "/api"。 */
  apiBase: string;
  /** 验证通过回调（含 token，接入方应把 token 提交给自己的后端核销）。 */
  onSuccess?: (result: VerifyResult) => void;
  /** 验证未通过回调（score 低于阈值 / 时效超限 / 轨迹过短等）。 */
  onFail?: (result: VerifyResult) => void;
  /** 网络/解密/提交异常回调。 */
  onError?: (error: Error) => void;
  /** 主题，默认 dark。 */
  theme?: Theme;
  /** 生产环境是否安装反调试（默认仅在 import.meta.env.PROD 下安装）。 */
  antidebug?: boolean;
}

export interface PhantomHandle {
  /** 销毁 widget：停止渲染、解绑事件、清空容器。 */
  destroy(): void;
  /** 重置：重新拉一道题，回到初始"待验证"状态。 */
  reset(): void;
}

const VERSION = "0.1.0";

/** 把字符串或 HTMLElement 解析为容器元素。 */
function resolveContainer(el: string | HTMLElement): HTMLElement {
  const node = typeof el === "string" ? document.querySelector(el) : el;
  if (!(node instanceof HTMLElement)) {
    throw new Error(`Phantom.mount: 容器未找到 (${el})`);
  }
  return node;
}

/** 内部状态机：封装一次"拉题→渲染→采集→提交"的生命周期。 */
class WidgetSession {
  private renderer: PhantomRenderer | null = null;
  private tracker: TrajectoryTracker | null = null;
  private sessionKey: SessionKey | null = null;
  private challengeId = "";
  private collecting = false;
  private finished = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private apiBase: string,
    private status: HTMLElement,
    private result: HTMLElement,
    private activateBtn: HTMLButtonElement,
    private onResult: (r: VerifyResult) => void,
    private onError: (e: Error) => void,
    private onRetry: () => void,
  ) {}

  async start(): Promise<void> {
    this.canvas.width = CONFIG.canvasWidth;
    this.canvas.height = CONFIG.canvasHeight;
    this.status.textContent = "正在准备验证题…";
    this.result.textContent = "";
    this.activateBtn.disabled = true;

    try {
      // 1) 协商会话密钥 + 取题
      const { privateKey, publicJwk } = await generateClientKeyPair();
      const challenge = await requestChallenge(this.apiBase, publicJwk);
      const serverPub = await importServerPublic(challenge.serverPublicJwk);
      this.sessionKey = await deriveSessionKey(
        privateKey,
        serverPub,
        challenge.salt,
      );
      this.challengeId = challenge.challengeId;

      // 2) 解密路径参数
      const paramsJson = await decrypt(
        this.sessionKey,
        challenge.encryptedParams.iv,
        challenge.encryptedParams.ciphertext,
      );
      const params = JSON.parse(new TextDecoder().decode(paramsJson)) as BezierParams;
      this.renderer = new PhantomRenderer(this.canvas, params);
      this.tracker = new TrajectoryTracker(this.canvas);

      // 题目就绪：先画一帧静态噪点，等用户按住按钮再开始动态显影
      this.status.textContent = "按住下方按钮，跟随移动的方块";
      this.activateBtn.disabled = false;
      this.renderer.drawStaticNoise();
      this.bindInteraction();
    } catch (e) {
      this.onError(e as Error);
      this.status.textContent = `初始化失败: ${(e as Error).message}`;
    }
  }

  private bindInteraction(): void {
    const onDown = (): void => {
      if (this.collecting || this.finished) return;
      this.collecting = true;
      // 用户按下才启动动态显影（startTime 重置为按下时刻，t 从 0 走）
      this.renderer?.start();
      this.tracker?.start();
      this.status.textContent = "跟随方块移动…";
    };
    const onUp = (): void => {
      if (!this.collecting || this.finished) return;
      this.collecting = false;
      // 松手即停：退化为纯噪点（滑块不再移动）
      this.renderer?.pause();
      const samples = this.tracker?.stop() ?? [];
      void this.verifyAndFinish(samples);
    };
    this.activateBtn.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    // 保存以便 destroy 解绑
    this._unbind = () => {
      this.activateBtn.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  }

  private _unbind: () => void = () => {};

  private async verifyAndFinish(samples: [number, number, number][]): Promise<void> {
    if (!this.sessionKey) return;
    // 采样点时间戳用 performance.now()（单调高精度，仅相对时差参与 DSP 重采样），
    // 但防重放时效字段 lastPointT_ms 必须与后端 epoch 对齐——后端拿
    // time.time()*1000 与之比对，传 performance.now() 会被误判 timeout_drift、
    // 导致真实轨迹恒得 0.0 分。故此处用 Date.now()（epoch 毫秒）。
    const payload = {
      points: samples,
      lastPointT_ms: Date.now(),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const { iv, ciphertext } = await encrypt(this.sessionKey, plaintext);

    try {
      const result = await submitVerify(this.apiBase, this.challengeId, iv, ciphertext);
      this.renderer?.stop();
      this.finished = true;
      this.result.textContent = result.passed
        ? `✅ 通过 (score ${result.score.toFixed(2)})`
        : `❌ 未通过 (score ${result.score.toFixed(2)})`;
      if (result.passed) {
        this.status.textContent = "验证成功";
      } else {
        // 验证失败：按钮退化为"点击刷新重试"，点击触发新一轮拉题
        this.status.textContent = "验证失败";
        this.turnIntoRetryButton();
      }
      this.onResult(result);
    } catch (e) {
      this.renderer?.stop();
      this.finished = true;
      this.status.textContent = "提交失败";
      this.result.textContent = `⚠️ ${(e as Error).message}`;
      // 网络异常同样允许点击重试
      this.turnIntoRetryButton();
      this.onError(e as Error);
    }
  }

  /** 把"按住跟随方块"按钮变成"点击刷新重试"按钮（点击→重新拉题）。 */
  private turnIntoRetryButton(): void {
    this._unbind();
    this._unbind = () => {};
    this.activateBtn.textContent = "点击刷新重试";
    this.activateBtn.classList.add("phantom-retry");
    this.activateBtn.disabled = false;
    const onClick = (): void => {
      this.activateBtn.removeEventListener("click", onClick);
      this.onRetry();
    };
    this.activateBtn.addEventListener("click", onClick);
    // 合并到 _unbind 以便 destroy/reset 清理
    this._unbind = () => {
      this.activateBtn.removeEventListener("click", onClick);
      this.activateBtn.classList.remove("phantom-retry");
    };
  }

  destroy(): void {
    this._unbind();
    this.renderer?.stop();
    this.tracker?.stop();
  }
}

/**
 * 在指定容器挂载一个 Phantom 人机验证 widget。
 * @returns handle，可用于 destroy() / reset()
 */
export function mount(
  el: string | HTMLElement,
  opts: PhantomOptions,
): PhantomHandle {
  injectStyles();

  // 反调试：默认仅在生产构建安装，可由 opts.antidebug 覆盖
  if (opts.antidebug ?? import.meta.env.PROD) {
    installAntidebug(true);
  }

  const container = resolveContainer(el);
  // 清空容器，避免重复 mount 残留
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "phantom-widget";
  root.setAttribute("data-theme", opts.theme ?? "dark");

  const canvas = document.createElement("canvas");
  canvas.className = "phantom-stage";

  const activateBtn = document.createElement("button");
  activateBtn.className = "phantom-activate";
  activateBtn.type = "button";
  activateBtn.textContent = "按住跟随方块";
  activateBtn.disabled = true;

  const status = document.createElement("div");
  status.className = "phantom-status";
  status.textContent = "正在准备验证题…";

  const result = document.createElement("div");
  result.className = "phantom-result";

  root.appendChild(canvas);
  root.appendChild(activateBtn);
  root.appendChild(status);
  root.appendChild(result);
  container.appendChild(root);

  const dispatch = (r: VerifyResult): void => {
    if (r.passed) opts.onSuccess?.(r);
    else opts.onFail?.(r);
  };

  // 重试按钮点击后：把按钮复位为"按住跟随方块"，再开新一轮 session
  const resetSession = (): void => {
    activateBtn.classList.remove("phantom-retry");
    activateBtn.textContent = "按住跟随方块";
    activateBtn.disabled = true;
    status.textContent = "正在准备验证题…";
    result.textContent = "";
    session = new WidgetSession(
      canvas,
      opts.apiBase,
      status,
      result,
      activateBtn,
      dispatch,
      (e) => opts.onError?.(e),
      resetSession,
    );
    void session.start();
  };

  let session = new WidgetSession(
    canvas,
    opts.apiBase,
    status,
    result,
    activateBtn,
    dispatch,
    (e) => opts.onError?.(e),
    resetSession,
  );
  void session.start();

  return {
    destroy(): void {
      session.destroy();
      root.remove();
    },
    reset(): void {
      session.destroy();
      resetSession();
    },
  };
}

export const Phantom = { mount, version: VERSION };

/** 仅在浏览器环境且未占用 window.Phantom 时挂到全局，便于 script-tag 接入。 */
if (typeof window !== "undefined") {
  const w = window as unknown as { Phantom?: typeof Phantom };
  if (!w.Phantom) w.Phantom = Phantom;
}

export default Phantom;
