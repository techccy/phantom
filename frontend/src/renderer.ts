// 视觉防线核心：动态显影（手册 §一、§二）。
//
// 原理：每帧画布铺满高熵随机噪点粒子；目标方块区域内的粒子在帧间被施加一个
// 【共同位移向量 Δ】（沿贝塞尔路径推进量），实现"共同命运（Common Fate）"——
// 人眼视网膜时间积分显影，机器逐帧分析失效。
//
// 关键：暂停（停止渲染循环）→ 立即退化成纯噪点，符合 PRD"静态无效"。
// 关键：动态帧与静态帧背景采用【同一套逐像素随机噪点】→ 按下/松开无明暗跳变，
//   避免"一按住就变暗"的密度落差（背景密度两条路径必须一致）。
//
// 反密度分析：目标簇亮度随机闪烁 + 少量粒子随机丢弃，防像素密度抠图。

import { CONFIG } from "./config";

export interface BezierParams {
  controlPoints: [number, number][]; // 4 控制点
  duration: number; // 秒
  fps: number;
  targetHalf: number; // 目标方块半边长
}

/** 三次贝塞尔位置采样。 */
function bezierAt(
  cp: [number, number][],
  t: number,
): [number, number] {
  const u = 1 - t;
  const x =
    u * u * u * cp[0][0] +
    3 * u * u * t * cp[1][0] +
    3 * u * t * t * cp[2][0] +
    t * t * t * cp[3][0];
  const y =
    u * u * u * cp[0][1] +
    3 * u * u * t * cp[1][1] +
    3 * u * t * t * cp[2][1] +
    t * t * t * cp[3][1];
  return [x, y];
}

export class PhantomRenderer {
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private running = false;
  private startTime = 0;
  /** 目标方块内每帧铺多少亮粒子（按方块面积比例，承载"共同命运"显影）。 */
  private readonly targetParticleCount: number;

  constructor(
    canvas: HTMLCanvasElement,
    private params: BezierParams,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D 不可用");
    this.ctx = ctx;
    const boxArea = (2 * params.targetHalf) ** 2;
    this.targetParticleCount = Math.max(64, Math.floor(boxArea * 0.6));
  }

  /** 用逐像素随机灰度铺满整个 ImageData。
   * 静态帧（drawStaticNoise）与动态帧背景共用 → 两条路径密度完全一致，
   * 消除"按下瞬间背景变暗"的跳变。 */
  private paintFullNoise(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }

  /** 启动动态渲染循环。返回目标当前位置（用于 UI 指引，可选）。 */
  start(onTick?: (center: [number, number], t: number) => void): void {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const elapsed = (now - this.startTime) / 1000;
      const t = Math.min(elapsed / this.params.duration, 1);
      this.renderFrame(t);
      const center = bezierAt(this.params.controlPoints, t);
      onTick?.(center, t);
      if (t >= 1) {
        this.running = false;
        return;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** 渲染单帧。t∈[0,1] 为路径归一化进度。 */
  private renderFrame(t: number): void {
    const { ctx, params } = this;
    const w = CONFIG.canvasWidth;
    const h = CONFIG.canvasHeight;

    // 一次 createImageData，背景与目标簇写入同一缓冲后统一落盘（60fps 友好）
    const img = ctx.createImageData(w, h);
    const data = img.data;

    // 1) 背景：逐像素随机噪点（与 drawStaticNoise 同密度）→ 单帧即纯噪点，
    //    且与静态帧无明暗跳变
    this.paintFullNoise(data);

    // 2) 目标方块：在当前贝塞尔中心周围铺密集亮粒子，承载"共同命运"显影。
    //    中心逐帧沿贝塞尔推进 → 整簇共同位移 → 人眼积分成"移动的方块"。
    const center = bezierAt(params.controlPoints, t);
    const half = params.targetHalf;
    const left = center[0] - half;
    const top = center[1] - half;
    const size = 2 * half;

    for (let i = 0; i < this.targetParticleCount; i++) {
      // 反密度分析：少量粒子随机丢弃，破坏密度统计
      if (Math.random() < 0.05) continue;
      const px = (left + Math.random() * size) | 0;
      const py = (top + Math.random() * size) | 0;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      // 亮度共同调制：偏高且小幅闪烁，单帧仍类噪点，帧间积分显出方块
      const v = ((0.55 + 0.45 * Math.random()) * 255) | 0;
      const idx = (py * w + px) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  /** 画一帧纯随机噪点（无残留目标信息）。暂停态 / 初始态共用。 */
  drawStaticNoise(): void {
    const { ctx } = this;
    const w = CONFIG.canvasWidth;
    const h = CONFIG.canvasHeight;
    const img = ctx.createImageData(w, h);
    this.paintFullNoise(img.data);
    ctx.putImageData(img, 0, 0);
  }

  /** 暂停 → 立即退化为纯噪点（PRD：静态无效）。 */
  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.drawStaticNoise();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
