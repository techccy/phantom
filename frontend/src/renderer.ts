// 视觉防线核心：动态显影（手册 §一、§二）。
//
// 原理：每帧画布铺满高熵随机噪点粒子；背景粒子位置/亮度每帧完全重随机
// （帧间不相关）→ 单帧即纯噪点，机器截图送 VLM 拿到的是一团乱麻。
// 而目标方块区域内的粒子，在帧间被施加一个【共同位移向量 Δ】（沿贝塞尔
// 路径推进量），实现"共同命运（Common Fate）"——人眼视网膜时间积分显影，
// 机器逐帧分析失效。
//
// 关键：暂停（暂停渲染循环）→ 立即退化成纯噪点，符合 PRD"静态无效"。
//
// 反密度分析：粒子亮度随机闪烁 + 区域内外密度扰动，防像素密度抠图。

import { CONFIG } from "./config";

export interface BezierParams {
  controlPoints: [number, number][]; // 4 控制点
  duration: number; // 秒
  fps: number;
  targetHalf: number; // 目标方块半边长
}

interface Particle {
  x: number;
  y: number;
  vx: number; // 帧间位移（仅目标区域内粒子使用，作为"共同命运"载体）
  vy: number;
  bright: number; // 0..1
  inTarget: boolean;
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

/** 由路径与时间推进计算本帧目标中心位移向量 Δ。 */
function targetDelta(
  cp: [number, number][],
  tPrev: number,
  tCurr: number,
): { center: [number, number]; delta: [number, number] } {
  const [px, py] = bezierAt(cp, tPrev);
  const [cx, cy] = bezierAt(cp, tCurr);
  return { center: [cx, cy], delta: [cx - px, cy - py] };
}

export class PhantomRenderer {
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private rafId = 0;
  private running = false;
  private startTime = 0;
  private lastT = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private params: BezierParams,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D 不可用");
    this.ctx = ctx;
    this.seedParticles();
  }

  /** 初始化全屏随机噪点粒子。 */
  private seedParticles(): void {
    const { canvasWidth: w, canvasHeight: h, noiseDensity } = CONFIG;
    const count = Math.floor(w * h * noiseDensity * 0.01);
    this.particles = new Array(count).fill(0).map(() => this.randomParticle());
  }

  private randomParticle(): Particle {
    return {
      x: Math.random() * CONFIG.canvasWidth,
      y: Math.random() * CONFIG.canvasHeight,
      vx: 0,
      vy: 0,
      bright: Math.random(),
      inTarget: false,
    };
  }

  /** 启动动态渲染循环。返回目标当前位置（用于 UI 指引，可选）。 */
  start(onTick?: (center: [number, number], t: number) => void): void {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();
    this.lastT = 0;
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

    // 1) 清屏（深底，提升噪点对比）
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);

    // 2) 计算本帧目标中心与位移向量 Δ（共同命运载体）
    const { center, delta } = targetDelta(this.params.controlPoints, this.lastT, t);
    const half = params.targetHalf;
    this.lastT = t;

    // 3) 遍历粒子：背景粒子完全重随机；目标区域内粒子施加共同 Δ
    //    用 ImageData 批量写入以达 60fps（逐粒子 fillRect 太慢）。
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const targetLeft = center[0] - half;
    const targetRight = center[0] + half;
    const targetTop = center[1] - half;
    const targetBottom = center[1] + half;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const inTarget =
        p.x >= targetLeft &&
        p.x <= targetRight &&
        p.y >= targetTop &&
        p.y <= targetBottom;

      if (inTarget) {
        // 区域内也每帧在方块内重随机位置（与背景同分布 → 密度一致），
        // 再施加共同 Δ，保留"共同命运（Common Fate）"显影。
        p.x = targetLeft + Math.random() * (targetRight - targetLeft) + delta[0];
        p.y = targetTop + Math.random() * (targetBottom - targetTop) + delta[1];
        // 亮度小幅共同调制，增强显影但单帧仍类噪点
        p.bright = 0.5 + 0.5 * Math.random();
      } else {
        // 背景高熵：位置/亮度每帧完全重随机 → 单帧纯噪点
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.bright = Math.random();
      }
      // 反密度分析：少量粒子随机丢弃，破坏密度统计
      if (Math.random() < 0.05) continue;

      const px = p.x | 0;
      const py = p.y | 0;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const v = (p.bright * 255) | 0;
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
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
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
