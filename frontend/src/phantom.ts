/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* widget 主体 */

import {
  CONFIG,
  TUNE,
  effLoupeEnabled,
  effLoupeSize,
  effLoupeZoom,
  effPadEnabled,
  effPreviewSeconds,
  isMobileViewport,
} from "./config";
import { Loupe } from "./loupe";
import { PadCursor } from "./pad";
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
import { deriveBezierPath } from "./prng";

export type { VerifyResult } from "./api";

export interface PhantomOptions {
  apiBase: string;
  onSuccess?: (result: VerifyResult) => void;
  onFail?: (result: VerifyResult) => void;
  onError?: (error: Error) => void;
  onChallenge?: (info: {
    server: { targetHalf: number; duration: number; canvas: [number, number] };
    effective: { targetHalf: number; duration: number };
  }) => void;
  theme?: Theme;
  antidebug?: boolean;
}

export interface PhantomHandle {
  destroy(): void;
  reset(): void;
}

const VERSION = "0.1.0";

const previewMs = (): number => effPreviewSeconds() * 1000;

const holdLabel = (padMode: boolean): string =>
  padMode ? "按住这里控制光标" : "按住并跟随方块";

const LOGO_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 2.5C7.86 2.5 4.5 5.86 4.5 10v8.2c0 .83.99 1.3 1.63.77.36-.3.88-.3 1.24 0 .36.3.88.3 1.24 0 .36-.3.88-.3 1.24 0 .36.3.88.3 1.24 0 .36-.3.88-.3 1.24 0 .36.3.88.3 1.24 0 .36-.3.88-.3 1.24 0 .64.53 1.63.06 1.63-.77V10C19.5 5.86 16.14 2.5 12 2.5Z"/>' +
  '<path fill="var(--ph-card, #fff)" d="M9.3 10.2a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3Zm5.4 0a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3Z"/>' +
  "</svg>";

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 12.5l4.5 4.5L19 7"/>' +
  "</svg>";

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 6 6 18M6 6l12 12"/>' +
  "</svg>";

const ALERT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 8v5M12 16.5v.5"/>' +
  "</svg>";

function resolveContainer(el: string | HTMLElement): HTMLElement {
  const node = typeof el === "string" ? document.querySelector(el) : el;
  if (!(node instanceof HTMLElement)) {
    throw new Error(`Phantom.mount: 容器未找到 (${el})`);
  }
  return node;
}

type HintStage = "loading" | "ready" | "preview" | "collect" | "stopped" | "done";

type BarState = "idle" | "verifying" | "verified" | "error";

class WidgetSession {
  private renderer: PhantomRenderer | null = null;
  private tracker: TrajectoryTracker | null = null;
  private sessionKey: SessionKey | null = null;
  private challengeId = "";
  private collecting = false;
  private finished = false;
  private previewing = false;
  private previewTimer = 0;
  private duration = 3;
  private retryTimer = 0;
  private device: "pc" | "mobile" = "pc";

  constructor(
    private canvas: HTMLCanvasElement,
    private apiBase: string,
    private status: HTMLElement,
    private overlay: HTMLElement,
    private hint: HTMLElement,
    private activateBtn: HTMLButtonElement,
    private onResult: (r: VerifyResult) => void,
    private onError: (e: Error) => void,
    private onRetry: () => void,
    private onChallenge: (info: {
      server: { targetHalf: number; duration: number; canvas: [number, number] };
      effective: { targetHalf: number; duration: number };
    }) => void = () => {},
    private loupe: Loupe | null = null,
    private cursor: PadCursor | null = null,
  ) {}

  private setHint(stage: HintStage, text: string): void {
    this.hint.setAttribute("data-stage", stage);
    this.hint.textContent = text;
  }

  async start(): Promise<void> {
    const mobile = isMobileViewport();
    this.device = mobile ? "mobile" : "pc";
    this.canvas.width = mobile ? CONFIG.canvasWidthMobile : CONFIG.canvasWidthPC;
    this.canvas.height = mobile ? CONFIG.canvasHeightMobile : CONFIG.canvasHeightPC;
    this.status.textContent = "正在准备验证题…";
    this.overlay.classList.add("phantom-hidden");
    this.setHint("loading", "");
    this.activateBtn.disabled = true;

    try {
      const { privateKey, publicJwk } = await generateClientKeyPair();
      const challenge = await requestChallenge(this.apiBase, publicJwk, this.device);
      const serverPub = await importServerPublic(challenge.serverPublicJwk);
      this.sessionKey = await deriveSessionKey(
        privateKey,
        serverPub,
        challenge.salt,
      );
      this.challengeId = challenge.challengeId;

      const paramsJson = await decrypt(
        this.sessionKey,
        challenge.encryptedParams.iv,
        challenge.encryptedParams.ciphertext,
      );
      const raw = JSON.parse(new TextDecoder().decode(paramsJson)) as {
        canvas: { w: number; h: number };
        duration: number;
        fps: number;
        targetHalf: number;
        pathSeed: string;
      };
      const controlPoints = deriveBezierPath(
        raw.pathSeed,
        raw.canvas.w,
        raw.canvas.h,
      );
      const params: BezierParams = {
        controlPoints,
        duration: TUNE.duration ?? raw.duration,
        fps: raw.fps,
        targetHalf: TUNE.targetHalf ?? raw.targetHalf,
      };
      this.duration = params.duration;
      this.onChallenge({
        server: {
          targetHalf: raw.targetHalf,
          duration: raw.duration,
          canvas: [raw.canvas.w, raw.canvas.h],
        },
        effective: { targetHalf: params.targetHalf, duration: params.duration },
      });
      this.renderer = new PhantomRenderer(this.canvas, params);
      this.tracker = new TrajectoryTracker(
        this.canvas,
        this.cursor ? this.activateBtn : this.canvas,
      );

      this.activateBtn.style.setProperty("--ph-charge-duration", `${this.duration}s`);
      this.status.textContent = "";
      this.setHint("ready", this.cursor ? "按住下方控制区" : "按住下方按钮");
      this.activateBtn.disabled = false;
      this.renderer.drawStaticNoise();
      this.overlay.classList.remove("phantom-hidden");
      this.bindInteraction();
    } catch (e) {
      this.onError(e as Error);
      this.status.textContent = `初始化失败: ${(e as Error).message}`;
    }
  }

  private bindInteraction(): void {
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (this.collecting || this.previewing || this.finished) return;
      this.previewing = true;
      this.overlay.classList.add("phantom-hidden");
      this.setHint(
        "preview",
        this.cursor ? "把光标环拖到闪烁的方块上等待" : "手指/鼠标拖动到闪烁的方块等待",
      );
      this.loupe?.start();
      this.cursor?.start();
      this.cursor?.place(e.clientX, e.clientY);
      this.renderer?.startPreview();
      this.previewTimer = window.setTimeout(beginCollect, previewMs());
    };
    const beginCollect = (): void => {
      if (!this.previewing || this.finished) return;
      this.previewing = false;
      this.collecting = true;
      this.status.textContent = "";
      this.setHint("collect", "按住跟随方块移动");
      this.renderer?.stopPreview();
      this.renderer?.start((_center, t) => {
        if (t >= 1) this.setHint("stopped", "请松手");
      });
      this.tracker?.start();
      this.activateBtn.classList.add("phantom-holding");
    };
    const onUp = (): void => {
      if (this.finished) return;
      if (this.previewing) {
        window.clearTimeout(this.previewTimer);
        this.previewing = false;
        this.loupe?.stop();
        this.cursor?.stop();
        this.renderer?.stopPreview();
        this.renderer?.drawStaticNoise();
        this.status.textContent = "";
        this.setHint(
          "ready",
          this.cursor ? "按住控制区并把光标环拖到方块" : "按住下方按钮并马上拖动到方块",
        );
        return;
      }
      if (!this.collecting) return;
      this.collecting = false;
      this.loupe?.stop();
      this.cursor?.stop();
      this.activateBtn.classList.remove("phantom-holding");
      this.renderer?.pause();
      this.setHint("done", "");
      const samples = this.tracker?.stop() ?? [];
      void this.verifyAndFinish(samples);
    };
    this.activateBtn.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    const onSelectStart = (e: Event): void => e.preventDefault();
    document.addEventListener("selectstart", onSelectStart, { capture: true });
    document.addEventListener("dragstart", onSelectStart, { capture: true });
    this._unbind = () => {
      this.activateBtn.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("selectstart", onSelectStart, { capture: true } as EventListenerOptions);
      document.removeEventListener("dragstart", onSelectStart, { capture: true } as EventListenerOptions);
    };
  }

  private _unbind: () => void = () => {};

  private async verifyAndFinish(samples: [number, number, number][]): Promise<void> {
    if (!this.sessionKey) return;
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
        this.activateBtn.classList.add("phantom-success");
        this.activateBtn.textContent = "验证通过";
      } else {
        this.activateBtn.classList.add("phantom-fail");
        this.activateBtn.textContent = "验证失败";
        this.scheduleRetry();
      }
      this.onResult(result);
    } catch (e) {
      this.renderer?.stop();
      this.finished = true;
      this.status.textContent = "提交失败";
      this.activateBtn.classList.add("phantom-fail");
      this.activateBtn.textContent = "验证失败";
      this.scheduleRetry();
      this.onError(e as Error);
    }
  }

  private scheduleRetry(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.turnIntoRetryButton();
    }, 1000);
  }

  private turnIntoRetryButton(): void {
    this._unbind();
    this._unbind = () => {};
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
    this.loupe?.stop();
    this.cursor?.stop();
    this.renderer?.stopPreview();
    this.renderer?.stop();
    this.tracker?.stop();
  }
}

export function mount(
  el: string | HTMLElement,
  opts: PhantomOptions,
): PhantomHandle {
  injectStyles();

  if (opts.antidebug ?? import.meta.env.PROD) {
    installAntidebug(true);
  }

  const container = resolveContainer(el);
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "phantom-widget";
  root.setAttribute("data-theme", opts.theme ?? "dark");

  const bar = document.createElement("div");
  bar.className = "phantom-bar";
  bar.setAttribute("data-state", "idle");
  bar.setAttribute("role", "checkbox");
  bar.setAttribute("aria-checked", "false");
  bar.tabIndex = 0;
  bar.title = "点击进行人机验证";

  const check = document.createElement("span");
  check.className = "phantom-check";
  check.innerHTML = "";

  const barText = document.createElement("span");
  barText.className = "phantom-bar-text";
  barText.textContent = "我不是机器人";

  const brand = document.createElement("span");
  brand.className = "phantom-bar-brand";
  const barLogo = document.createElement("span");
  barLogo.className = "phantom-bar-logo";
  barLogo.innerHTML = LOGO_SVG;
  const copyright = document.createElement("span");
  copyright.className = "phantom-bar-copyright";
  copyright.innerHTML =
    'techccy/<a href="https://github.com/techccy/phantom" target="_blank" rel="noopener">phantom</a>';
  brand.appendChild(barLogo);
  brand.appendChild(copyright);

  bar.appendChild(check);
  bar.appendChild(barText);
  bar.appendChild(brand);
  root.appendChild(bar);

  container.appendChild(root);

  let modal: {
    node: HTMLDivElement;
    session: WidgetSession;
    closing: boolean;
  } | null = null;

  const setBarState = (state: BarState): void => {
    bar.setAttribute("data-state", state);
    bar.setAttribute("aria-checked", state === "verified" ? "true" : "false");
    if (state === "verified") {
      check.innerHTML = CHECK_SVG;
      barText.textContent = "已验证";
    } else if (state === "error") {
      check.innerHTML = ALERT_SVG;
      barText.textContent = "验证失败，点击重试";
    } else if (state === "verifying") {
      check.innerHTML = "";
      barText.textContent = "验证中…";
    } else {
      check.innerHTML = "";
      barText.textContent = "我不是机器人";
    }
  };

  const buildModalBody = (modalCard: HTMLDivElement): {
    hint: HTMLDivElement;
    canvas: HTMLCanvasElement;
    overlay: HTMLDivElement;
    activateBtn: HTMLButtonElement;
    status: HTMLDivElement;
    progress: HTMLSpanElement;
    loupe: Loupe | null;
    cursor: PadCursor | null;
  } => {
    const head = document.createElement("div");
    head.className = "phantom-modal-head";
    const headLogo = document.createElement("span");
    headLogo.className = "phantom-modal-logo";
    headLogo.innerHTML = LOGO_SVG;
    const title = document.createElement("span");
    title.className = "phantom-modal-title";
    title.textContent = "Phantom 人机验证";
    const closeBtn = document.createElement("button");
    closeBtn.className = "phantom-modal-close";
    closeBtn.type = "button";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭验证");
    closeBtn.innerHTML = CLOSE_SVG;
    closeBtn.addEventListener("click", () => closeModal(false));
    head.appendChild(headLogo);
    head.appendChild(title);
    head.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "phantom-modal-body";

    const hint = document.createElement("div");
    hint.className = "phantom-hint";
    hint.setAttribute("data-stage", "loading");

    const stageWrap = document.createElement("div");
    stageWrap.className = "phantom-stage-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "phantom-stage";
    const overlay = document.createElement("div");
    overlay.className = "phantom-overlay phantom-hidden";
    const padMode = effPadEnabled();

    const overlayText = document.createElement("div");
    overlayText.className = "phantom-overlay-text";
    overlayText.innerHTML = padMode
      ? "手指按住下方控制区<br>画布里会出现光标环<br>把光标环拖到闪烁方块上<br>方块出发后跟着走，停了就松手"
      : "按住下方按钮<br>马上拖动到闪烁方块处<br>方块出发后跟随移动<br>方块停止则松手";
    overlay.appendChild(overlayText);
    stageWrap.appendChild(canvas);
    stageWrap.appendChild(overlay);

    const activateBtn = document.createElement("button");
    activateBtn.className = padMode
      ? "phantom-activate phantom-pad"
      : "phantom-activate";
    activateBtn.type = "button";
    activateBtn.textContent = holdLabel(padMode);
    activateBtn.disabled = true;
    const progress = document.createElement("span");
    progress.className = "phantom-progress";
    activateBtn.appendChild(progress);

    const cursor = padMode ? new PadCursor(canvas, activateBtn) : null;
    if (cursor) stageWrap.appendChild(cursor.element);

    const status = document.createElement("div");
    status.className = "phantom-status";
    status.textContent = "正在准备验证题…";

    const loupe = effLoupeEnabled()
      ? new Loupe(canvas, effLoupeZoom(), effLoupeSize())
      : null;
    if (loupe) modalCard.classList.add("phantom-has-loupe");
    if (padMode) modalCard.classList.add("phantom-has-pad");

    body.appendChild(hint);
    if (loupe) body.appendChild(loupe.element);
    body.appendChild(stageWrap);
    body.appendChild(activateBtn);
    body.appendChild(status);

    modalCard.appendChild(head);
    modalCard.appendChild(body);

    return { hint, canvas, overlay, activateBtn, status, progress, loupe, cursor };
  };

  const dispatch = (r: VerifyResult): void => {
    if (r.passed) opts.onSuccess?.(r);
    else opts.onFail?.(r);
  };

  const openModal = (): void => {
    if (modal) return;

    const node = document.createElement("div");
    node.className = "phantom-modal";
    node.setAttribute("data-theme", opts.theme ?? "dark");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-label", "Phantom 人机验证");

    const modalCard = document.createElement("div");
    modalCard.className = "phantom-modal-card";
    node.appendChild(modalCard);

    const { hint, canvas, overlay, activateBtn, status, progress, loupe, cursor } =
      buildModalBody(modalCard);

    node.addEventListener("click", (e) => {
      if (e.target === node) closeModal(false);
    });
    modalCard.addEventListener("click", (e) => e.stopPropagation());

    document.body.appendChild(node);

    const resetSession = (): void => {
      activateBtn.classList.remove(
        "phantom-holding",
        "phantom-success",
        "phantom-fail",
        "phantom-retry",
      );
      activateBtn.textContent = holdLabel(cursor !== null);
      activateBtn.appendChild(progress);
      activateBtn.disabled = true;
      status.textContent = "正在准备验证题…";
      session = new WidgetSession(
        canvas,
        opts.apiBase,
        status,
        overlay,
        hint,
        activateBtn,
        (r) => {
          dispatch(r);
          if (r.passed) onVerified();
        },
        (e) => opts.onError?.(e),
        resetSession,
        (info) => opts.onChallenge?.(info),
        loupe,
        cursor,
      );
      void session.start();
    };

    let session = new WidgetSession(
      canvas,
      opts.apiBase,
      status,
      overlay,
      hint,
      activateBtn,
      (r) => {
        dispatch(r);
        if (r.passed) onVerified();
      },
      (e) => opts.onError?.(e),
      resetSession,
      (info) => opts.onChallenge?.(info),
      loupe,
      cursor,
    );

    modal = { node, session, closing: false };
    setBarState("verifying");
    void session.start();
  };

  const closeModal = (verified: boolean): void => {
    if (!modal || modal.closing) return;
    modal.closing = true;
    modal.session.destroy();
    const node = modal.node;
    const finalize = (): void => {
      node.remove();
    };
    node.classList.add("phantom-leaving");
    window.setTimeout(finalize, 160);
    modal = null;
    setBarState(verified ? "verified" : "idle");
  };

  const onVerified = (): void => {
    window.setTimeout(() => closeModal(true), 700);
  };

  const onBarClick = (): void => {
    if (bar.getAttribute("data-state") === "verified") return;
    if (bar.getAttribute("data-state") === "verifying") return;
    openModal();
  };
  bar.addEventListener("click", onBarClick);
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onBarClick();
    }
  });

  return {
    destroy(): void {
      if (modal) {
        modal.session.destroy();
        modal.node.remove();
        modal = null;
      }
      bar.removeEventListener("click", onBarClick);
      root.remove();
    },
    reset(): void {
      closeModal(false);
      setBarState("idle");
    },
  };
}

export const Phantom = { mount, version: VERSION };

if (typeof window !== "undefined") {
  const w = window as unknown as { Phantom?: typeof Phantom };
  if (!w.Phantom) w.Phantom = Phantom;
}

export default Phantom;
