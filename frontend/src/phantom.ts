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

import { CONFIG, isMobileViewport } from "./config";
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

/** 预热脉冲时长（毫秒）：按住后先显影方块这段时间，方便用户熟悉方块位置。
 *  时长来自 CONFIG.previewSeconds（由 VITE_PREVIEW_SECONDS 注入，可调）。 */
const PREVIEW_MS = CONFIG.previewSeconds * 1000;

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
  /** 预热脉冲态：按住后先在起点原地显影方块 2 秒，方便用户熟悉方块位置。 */
  private previewing = false;
  private previewTimer = 0;
  /** 本题路径时长（秒），来自后端解密参数，用于按钮充能进度条对齐渲染结束时刻。 */
  private duration = 3;
  /** 失败→重试 的延迟计时器，destroy/reset 时清理。 */
  private retryTimer = 0;
  /** 本题对应的端类型（pc/mobile），在 start() 里按视口确定后下发给后端，
   * 让后端据此选择 canvas_w/h 与 target_half。 */
  private device: "pc" | "mobile" = "pc";

  constructor(
    private canvas: HTMLCanvasElement,
    private apiBase: string,
    private status: HTMLElement,
    private overlay: HTMLElement,
    private activateBtn: HTMLButtonElement,
    private onResult: (r: VerifyResult) => void,
    private onError: (e: Error) => void,
    private onRetry: () => void,
  ) {}

  async start(): Promise<void> {
    // 画布尺寸按视口 PC/Mobile 区分（docs/issue3.md §2/§4）。
    // ⚠️ 必须与后端按同一 device 选出的 PHANTOM_CANVAS_*_PC/MOBILE 一致，
    // 否则后端 DTW 归一化用的 canvas_w/h 会与前端渲染尺寸错位（见下方 device 传参）。
    const mobile = isMobileViewport();
    this.device = mobile ? "mobile" : "pc";
    this.canvas.width = mobile ? CONFIG.canvasWidthMobile : CONFIG.canvasWidthPC;
    this.canvas.height = mobile ? CONFIG.canvasHeightMobile : CONFIG.canvasHeightPC;
    this.status.textContent = "正在准备验证题…";
    // 加载态：遮罩隐藏，避免遮挡空白 canvas
    this.overlay.classList.add("phantom-hidden");
    this.activateBtn.disabled = true;

    try {
      // 1) 协商会话密钥 + 取题
      const { privateKey, publicJwk } = await generateClientKeyPair();
      const challenge = await requestChallenge(this.apiBase, publicJwk, this.device);
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
      this.duration = params.duration;
      this.renderer = new PhantomRenderer(this.canvas, params);
      this.tracker = new TrajectoryTracker(this.canvas);

      // 题目就绪：先画一帧静态噪点，等用户按住按钮再开始动态显影。
      // 进度条充能时长与后端下发的路径时长对齐（充能结束 ≈ 渲染结束）。
      this.activateBtn.style.setProperty("--ph-charge-duration", `${this.duration}s`);
      this.status.textContent = "";
      this.activateBtn.disabled = false;
      this.renderer.drawStaticNoise();
      // 题目就绪：显示玩法遮罩，用户按下即隐藏（见 bindInteraction.onDown）
      this.overlay.classList.remove("phantom-hidden");
      this.bindInteraction();
    } catch (e) {
      this.onError(e as Error);
      this.status.textContent = `初始化失败: ${(e as Error).message}`;
    }
  }

  private bindInteraction(): void {
    const onDown = (): void => {
      if (this.collecting || this.previewing || this.finished) return;
      // 预热态：按住瞬间先在起点原地显影方块 2 秒，方便用户熟悉方块位置。
      // 此阶段只做脉冲呼吸显影，不采集、不出发路径、不进入充能态。
      this.previewing = true;
      this.overlay.classList.add("phantom-hidden");
      this.status.textContent = "准备跟随";
      this.renderer?.startPreview();
      this.previewTimer = window.setTimeout(beginCollect, PREVIEW_MS);
    };
    // 2 秒预热结束：方块从起点出发，同步启动轨迹采集 + 按钮充能态。
    // renderer.start() 与 tracker.start() 严格同步 → 采集起点对齐 t=0，
    // 后端 DTW/评分与改前完全一致。
    const beginCollect = (): void => {
      if (!this.previewing || this.finished) return;
      this.previewing = false;
      this.collecting = true;
      this.status.textContent = "";
      this.renderer?.stopPreview();
      this.renderer?.start();
      this.tracker?.start();
      // 充能进度条此时才开始（动画时长仍对齐 --ph-charge-duration = duration）
      this.activateBtn.classList.add("phantom-holding");
    };
    const onUp = (): void => {
      if (this.finished) return;
      // 预热中松手：取消预热、回到就绪态，不提交。
      if (this.previewing) {
        window.clearTimeout(this.previewTimer);
        this.previewing = false;
        this.renderer?.stopPreview();
        this.renderer?.drawStaticNoise();
        this.status.textContent = "";
        return;
      }
      if (!this.collecting) return;
      this.collecting = false;
      // 松手即停：进度条定格，渲染退化为纯噪点
      this.activateBtn.classList.remove("phantom-holding");
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
      this.status.textContent = "";
      if (result.passed) {
        // 成功：按钮翡翠绿微放大，文字显示"验证通过"
        this.activateBtn.classList.add("phantom-success");
        this.activateBtn.textContent = "验证通过";
      } else {
        // 失败：按钮警示红 + 震动，闪现 1s 后转"点击刷新重试"
        this.activateBtn.classList.add("phantom-fail");
        this.activateBtn.textContent = "验证失败";
        this.scheduleRetry();
      }
      this.onResult(result);
    } catch (e) {
      this.renderer?.stop();
      this.finished = true;
      this.status.textContent = "提交失败";
      // 网络异常走相同的 fail→retry 流程
      this.activateBtn.classList.add("phantom-fail");
      this.activateBtn.textContent = "验证失败";
      this.scheduleRetry();
      this.onError(e as Error);
    }
  }

  /** 闪现失败态 1s 后转为"点击刷新重试"按钮。 */
  private scheduleRetry(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.turnIntoRetryButton();
    }, 1000);
  }

  /** 把"按住跟随方块"按钮变成"点击刷新重试"按钮（点击→重新拉题）。 */
  private turnIntoRetryButton(): void {
    this._unbind();
    this._unbind = () => {};
    // 清除所有结果态 class，复位到可点击的重试样式
    this.activateBtn.classList.remove(
      "phantom-holding",
      "phantom-success",
      "phantom-fail",
    );
    this.activateBtn.classList.add("phantom-retry");
    this.activateBtn.textContent = "点击刷新重试";
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
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.previewTimer);
    this.previewing = false;
    this.renderer?.stopPreview();
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

  // canvas + 玩法遮罩一起放进相对定位的 wrap，遮罩 absolute 覆盖在画布上
  const stageWrap = document.createElement("div");
  stageWrap.className = "phantom-stage-wrap";

  const canvas = document.createElement("canvas");
  canvas.className = "phantom-stage";

  const overlay = document.createElement("div");
  overlay.className = "phantom-overlay phantom-hidden";
  const overlayText = document.createElement("div");
  overlayText.className = "phantom-overlay-text";
  overlayText.innerHTML = "按住下方按钮<br>拖动到闪烁方块处<br>方块出发后跟随移动<br>方块停止则松手";
  overlay.appendChild(overlayText);

  stageWrap.appendChild(canvas);
  stageWrap.appendChild(overlay);

  const activateBtn = document.createElement("button");
  activateBtn.className = "phantom-activate";
  activateBtn.type = "button";
  activateBtn.textContent = "按住并跟随方块";
  activateBtn.disabled = true;
  // 充能进度条贴在按钮底部
  const progress = document.createElement("span");
  progress.className = "phantom-progress";
  activateBtn.appendChild(progress);

  const status = document.createElement("div");
  status.className = "phantom-status";
  status.textContent = "正在准备验证题…";

  root.appendChild(stageWrap);
  root.appendChild(activateBtn);
  root.appendChild(status);
  container.appendChild(root);

  const dispatch = (r: VerifyResult): void => {
    if (r.passed) opts.onSuccess?.(r);
    else opts.onFail?.(r);
  };

  // 重试按钮点击后：把按钮复位为"按住并跟随方块"，再开新一轮 session。
  // 注意：新 session.start() 就绪后会自行显示遮罩，这里无需手动管理遮罩显示。
  const resetSession = (): void => {
    activateBtn.classList.remove(
      "phantom-holding",
      "phantom-success",
      "phantom-fail",
      "phantom-retry",
    );
    activateBtn.textContent = "按住并跟随方块";
    activateBtn.appendChild(progress);
    activateBtn.disabled = true;
    status.textContent = "正在准备验证题…";
    session = new WidgetSession(
      canvas,
      opts.apiBase,
      status,
      overlay,
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
    overlay,
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
