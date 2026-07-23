// 视觉防线核心：动态显影（手册 §一、§二）。
//
// 原理：每帧画布铺满高熵随机噪点粒子；目标方块区域内的【持久化粒子】在帧间被施加一个
// 【共同位移向量 Δ】（沿贝塞尔路径推进量），实现"共同命运（Common Fate）"——
// 人眼视网膜时间积分显影，机器逐帧分析失效。
//
// 关键（反密度分析）：目标簇的持久化粒子灰度与背景【同分布】（均匀 [0,255]），再由
// gain 决定是否额外提亮：
//   - gain = 0：粒子灰度与背景统计一致 → 单帧上目标区与背景无任何差异，机器逐帧
//     密度/亮度分析完全失效；人眼仅靠"共同位移"看见移动方块。
//   - gain > 0：在固有灰度上线性提亮 → 方块更亮，便于调试/增强显影（但越亮越易被
//     机器识别，生产建议 0 或极小值）。
//
// 关键：暂停（停止渲染循环）→ 立即退化成纯噪点，符合 PRD"静态无效"。
// 关键：动态帧与静态帧背景采用【同一套逐像素随机噪点】→ 按下/松开无明暗跳变，
//   避免"一按住就变暗"的密度落差（背景密度两条路径必须一致）。
//
// ⚠️ 预热脉冲（startPreview）的呼吸提亮【不受 gain 影响】——它在用户按下后的预热
// 三秒用于让用户熟悉方块位置，必须明显可见，gain 只影响正式动态渲染。

import { CONFIG } from "./config";
import {
  makeCluster,
  paintFullNoise as paintFullNoisePure,
  stampCluster as stampClusterPure,
  type Particle,
} from "./particles";

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
  /** 预热脉冲呼吸态：方块在贝塞尔起点原地显影，亮度按 sin 呼吸。 */
  private previewing = false;
  private previewRafId = 0;
  private previewStartTime = 0;
  /** 保留 canvas 引用以读取实际 buffer 尺寸（PC/Mobile 不同）。 */
  private readonly canvas: HTMLCanvasElement;
  /** 目标方块内每帧铺多少粒子（按方块面积比例，承载"共同命运"显影）。 */
  private readonly targetParticleCount: number;
  /** 持久化粒子簇（跨帧复用 → 每帧整体平移 → 共同命运）。
   *  - 动态渲染与预热脉冲【共用同一簇】：两者都要让方块"原地/沿路径"显影，
   *    用同一组粒子保证形状一致。
   *  - 灰度增益（gain）仅作用于动态渲染；预热脉冲用固定呼吸亮度显影。 */
  private readonly particles: Particle[];

  constructor(
    canvas: HTMLCanvasElement,
    private params: BezierParams,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D 不可用");
    this.ctx = ctx;
    const boxArea = (2 * params.targetHalf) ** 2;
    this.targetParticleCount = Math.max(64, Math.floor(boxArea * CONFIG.particleDensity));
    // 粒子灰度在 makeCluster 内取均匀 [0,255]（与背景同分布）→ gain=0 时与背景无差异
    this.particles = makeCluster(this.targetParticleCount, params.targetHalf);
  }

  /** 用逐像素随机灰度铺满整个 ImageData。
   * 静态帧（drawStaticNoise）与动态帧背景共用 → 两条路径密度完全一致，
   * 消除"按下瞬间背景变暗"的跳变。 */
  private paintFullNoise(data: Uint8ClampedArray): void {
    paintFullNoisePure({ w: this.canvas.width, h: this.canvas.height, data });
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

  /** 预热脉冲：方块在贝塞尔起点（t=0）原地显影，亮度按 sin 呼吸，
   *  供用户按下后用预热秒数熟悉方块位置；正式 start() 前调用 stopPreview()。
   *  ⚠️ 呼吸提亮【不受 gain 影响】——预热必须明显可见，gain 只管正式动态渲染。
   *  用固定基值亮度显影（每帧重铺随机位置 + 固定亮度，单帧仍类噪点）。 */
  startPreview(): void {
    if (this.previewing) return;
    this.previewing = true;
    this.previewStartTime = performance.now();
    const center = bezierAt(this.params.controlPoints, 0);
    const half = this.params.targetHalf;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const loop = (): void => {
      if (!this.previewing) return;
      const elapsed = (performance.now() - this.previewStartTime) / 1000;
      // 亮度呼吸：基值 0.55 + 0.45·sin(2π·f·elapsed)，f≈0.75Hz
      const brightnessScale = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.75 * elapsed);
      const img = this.ctx.createImageData(w, h);
      const data = img.data;
      // 背景：逐像素随机噪点
      this.paintFullNoise(data);
      // 目标簇：每帧在方块内重铺随机位置的粒子，按呼吸亮度显影（不持久、不受 gain 影响）。
      // 用与旧实现一致的"随机位置 + 固定亮度"模式，保证预热明显可见。
      const left = center[0] - half;
      const top = center[1] - half;
      const size = 2 * half;
      for (let i = 0; i < this.targetParticleCount; i++) {
        if (Math.random() < CONFIG.particleDropRate) continue;
        const px = (left + Math.random() * size) | 0;
        const py = (top + Math.random() * size) | 0;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const v = Math.min(255, (Math.max(0.1, brightnessScale) * 255) | 0);
        const idx = (py * w + px) * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
      this.previewRafId = requestAnimationFrame(loop);
    };
    this.previewRafId = requestAnimationFrame(loop);
  }

  /** 停止预热脉冲（不主动重绘，由调用方决定后续画布状态）。 */
  stopPreview(): void {
    this.previewing = false;
    cancelAnimationFrame(this.previewRafId);
  }

  /** 渲染单帧。t∈[0,1] 为路径归一化进度。 */
  private renderFrame(t: number): void {
    const { ctx } = this;
    // 画布尺寸以 canvas.width/height 为准（PC/Mobile 不同，由 phantom.ts 按视口设置），
    // 不再读 CONFIG 全局值，避免与实际 buffer 尺寸不一致。
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 一次 createImageData，背景与目标簇写入同一缓冲后统一落盘（60fps 友好）
    const img = ctx.createImageData(w, h);
    const data = img.data;

    // 1) 背景：逐像素随机噪点（与 drawStaticNoise 同密度）→ 单帧即纯噪点，
    //    且与静态帧无明暗跳变
    this.paintFullNoise(data);

    // 2) 目标方块：持久化粒子簇整体平移到当前贝塞尔中心 → "共同命运"显影。
    //    粒子跨帧复用（仅随机丢弃），中心逐帧沿贝塞尔推进 → 人眼积分成"移动的方块"。
    //    gain=0 时粒子灰度与背景同分布 → 机器逐帧看不出；人眼靠共同位移仍可见。
    const center = bezierAt(this.params.controlPoints, t);
    stampClusterPure(
      { w, h, data },
      this.particles,
      center,
      CONFIG.particleTargetGain,
      CONFIG.particleDropRate,
    );

    ctx.putImageData(img, 0, 0);
  }

  /** 画一帧纯随机噪点（无残留目标信息）。暂停态 / 初始态共用。 */
  drawStaticNoise(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
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
