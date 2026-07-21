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
// 单帧灰度泄露防护（docs/issue.md §1/§4）：背景与目标簇【共用同一个亮度采样器】
//   sampleLuminance() → 任意单帧下方块区域与背景逐像素同分布（i.i.d. uniform[0,255]），
//   单帧直方图/均值完全不可区分。目标的可见性仅来自时间维度：一簇【持久化的相对
//   偏移点】随贝塞尔曲线整体刚体平移，人眼积分成"移动方块"，机器逐帧统计失效。
//
// 反密度分析：少量粒子随机丢弃（particleDropRate），破坏簇内像素密度统计。

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

/**
 * 单一亮度采样器：背景与目标簇【必须】共用此函数。
 *
 * 关键不变量：目标区域任意单帧的逐像素灰度分布必须与背景【同分布】
 * （i.i.d. uniform[0,255]），否则逐帧即可用阈值分割抠出方块（docs/issue.md §4）。
 * 任何"目标更亮/更柔和"的诉求都只能从【时间维度（Common Fate 共同位移）】来提供，
 * 绝不可改这里的分布。修改本函数前请务必同步更新两处调用方。
 */
function sampleLuminance(): number {
  return (Math.random() * 255) | 0;
}

export class PhantomRenderer {
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private running = false;
  private startTime = 0;
  /**
   * 目标簇内每个粒子相对方块中心的【持久化整数偏移】。
   *
   * 仅在构造时生成一次，整个 attempt（一次按下→松开）内复用：每帧的绝对像素位置 =
   * `round(bezierAt(t)) + offset`。于是整簇随贝塞尔曲线做【刚体平移】，人眼时间积分
   * 出"共同命运"的移动方块；而单帧下方块区域内每个像素仍与背景同分布（见
   * sampleLuminance），逐帧统计不可区分。
   *
   * 每次按下都 `new PhantomRenderer`（见 phantom.ts），所以偏移随题目刷新而刷新，
   * 不会跨 attempt 复用同一形状（防形状指纹）。
   */
  private readonly targetOffsets: readonly [number, number][];

  constructor(
    canvas: HTMLCanvasElement,
    private params: BezierParams,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D 不可用");
    this.ctx = ctx;
    // 按方块面积比例生成簇密度（承载"共同命运"显影）。
    const half = params.targetHalf;
    const boxArea = (2 * half) ** 2;
    const count = Math.max(64, Math.floor(boxArea * CONFIG.particleDensity));
    const offsets: [number, number][] = new Array(count);
    for (let i = 0; i < count; i++) {
      // ox/oy ∈ [-half, +half)，整数；覆盖整个方块，密度由 count 决定。
      const ox = (Math.random() * (2 * half) - half) | 0;
      const oy = (Math.random() * (2 * half) - half) | 0;
      offsets[i] = [ox, oy];
    }
    this.targetOffsets = offsets;
  }

  /** 用逐像素随机灰度铺满整个 ImageData。
   * 静态帧（drawStaticNoise）与动态帧背景共用 → 两条路径密度完全一致，
   * 消除"按下瞬间背景变暗"的跳变。
   *
   * 必须与目标簇共用 sampleLuminance()（docs/issue.md §4），任何亮度分支差异都会
   * 导致单帧可抠图。 */
  private paintFullNoise(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
      const v = sampleLuminance();
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

    // 1) 背景：逐像素随机噪点（与 drawStaticNoise 同采样器）→ 单帧即纯噪点，
    //    且与静态帧无明暗跳变。
    this.paintFullNoise(data);

    // 2) 目标方块：把持久化的簇偏移整体平移到当前贝塞尔中心（刚体位移），
    //    承载"共同命运"显影。中心逐帧沿贝塞尔推进 → 整簇共同位移 → 人眼积分成
    //    "移动的方块"。
    //
    //    单帧灰度泄露防护（docs/issue.md §1/§4）：
    //    - 中心取整后再加整数偏移 → 所有写入坐标为整数，杜绝亚像素（§2，本就不存在）。
    //    - 亮度走 sampleLuminance()，与背景【同分布】→ 方块区域内任意被覆盖像素的
    //      灰度分布恒等于背景，单帧直方图不可区分（§4 闭环）。
    //      （亮度"偏高"曾是泄露来源，现已移除；可见性只靠时间维度的共同位移提供。）
    const center = bezierAt(params.controlPoints, t);
    const cx = Math.round(center[0]);
    const cy = Math.round(center[1]);
    const offsets = this.targetOffsets;
    const dropRate = CONFIG.particleDropRate;

    for (let i = 0; i < offsets.length; i++) {
      // 反密度分析：少量粒子随机丢弃，破坏簇内密度统计
      if (Math.random() < dropRate) continue;
      const px = cx + offsets[i][0];
      const py = cy + offsets[i][1];
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      // 与背景同分布的亮度（i.i.d. uniform[0,255]）
      const v = sampleLuminance();
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
