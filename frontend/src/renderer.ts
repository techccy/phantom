// 视觉防线核心：动态显影（手册 §一、§二）。
//
// 原理：每帧画布铺满高熵随机噪点粒子；目标方块区域内的一簇【固有纹理粒子】在帧间被
// 施加【共同位移向量 Δ】（沿贝塞尔路径推进量），实现"共同命运（Common Fate）"——
// 人眼视网膜时间积分显影，机器逐帧分析失效。
//
// 关键：暂停（停止渲染循环）→ 立即退化成纯噪点，符合 PRD"静态无效"。
// 关键：动态帧与静态帧背景采用【同一套逐像素随机噪点】→ 按下/松开无明暗跳变，
//   避免"一按住就变暗"的密度落差（背景密度两条路径必须一致）。
//
// 单帧灰度泄露防护（docs/issue.md §1/§4）：目标簇每个粒子的【固有亮度】在构造时从
//   sampleLuminance()（uniform[0,255]）采样一次并持久化，背景每帧重采样同一采样器
//   → 任意单帧下方块区域与背景逐像素同分布（i.i.d. uniform[0,255]），单帧直方图/均值
//   完全不可区分。
//
// 肉眼显影核心（docs/issue2.md §一/§二）：每个目标粒子的固有亮度在整个 attempt 内
//   【不重置】（Persistent Texture Translation）→ 整簇随贝塞尔曲线做刚体平移时，每个
//   粒子帧间亮度固定，人眼 V1/MT 区运动能量模型识别为"同一物体在平移"，瞬间浮雕显影。
//   ⚠️ renderFrame 内绝不可对目标粒子重新调用 sampleLuminance()/Math.random()，
//   否则亮度帧间相关性归零，肉眼失明（粒子融进背景雪花，见 docs/issue2.md §一）。
//
// 反密度分析：少量粒子在构造时持久化标记为"被丢弃"（particleDropRate），破坏簇内
//   像素密度统计；持久化标记避免每帧随机消失/出现的高频闪烁（与亮度持久化同理）。

import { CONFIG } from "./config";

export interface BezierParams {
  controlPoints: [number, number][]; // 4 控制点
  duration: number; // 秒
  fps: number;
  targetHalf: number; // 目标方块半边长
}

/** 目标簇粒子：整数偏移 + 【初始化时持久化的固有亮度】+ 持久化丢弃标记。
 *
 * 亮度在构造时从 sampleLuminance()（uniform[0,255]）采样一次，整个 attempt 内
 * 不重置（docs/issue2.md §三.1）→ 整簇随贝塞尔曲线刚体平移时，每个粒子的亮度在
 * 视网膜时间积分上保持帧间连贯，人眼瞬间识别"移动方块"（浮雕显影 Pop-out）。
 *
 * 单帧下方块区域与背景仍逐像素同分布（i.i.d. uniform[0,255]），不违反
 * docs/issue.md §4。⚠️ 不要在任何渲染路径上重新采样 luminance（见文件头警告）。
 *
 * dropped 为持久化丢弃标记：构造时一次性按 particleDropRate 掷骰决定，整个 attempt
 * 不变，避免每帧随机消失/出现的高频闪烁（与亮度持久化同理，防止肉眼失明）。
 */
export interface TargetParticle {
  ox: number;
  oy: number;
  luminance: number; // 固有亮度（init 时确定，全程不重置）
  dropped: boolean; // 持久化丢弃标记（反密度分析，init 时确定）
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
   * 目标簇粒子：相对方块中心的整数偏移 + 【持久化固有亮度】+ 持久化丢弃标记。
   *
   * 仅在构造时生成一次，整个 attempt（一次按下→松开）内复用：每帧的绝对像素位置 =
   * `round(bezierAt(t)) + offset`，写入灰度 = `p.luminance`（不再重采样）。于是整簇随
   * 贝塞尔曲线做【刚体平移】且【纹理帧间固定】，人眼时间积分出"共同命运"的移动方块
   * （浮雕显影，docs/issue2.md）；而单帧下方块区域内每个像素仍与背景同分布（亮度
   * 均匀采样自同一 sampleLuminance），逐帧统计不可区分（docs/issue.md §4）。
   *
   * 每次按下都 `new PhantomRenderer`（见 phantom.ts），所以偏移+亮度随题目刷新而刷新，
   * 不会跨 attempt 复用同一形状/纹理（防形状指纹 & 防纹理指纹）。
   */
  private readonly targetParticles: readonly TargetParticle[];

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
    const dropRate = CONFIG.particleDropRate;
    const particles: TargetParticle[] = new Array(count);
    for (let i = 0; i < count; i++) {
      // ox/oy ∈ [-half, +half)，整数；覆盖整个方块，密度由 count 决定。
      const ox = (Math.random() * (2 * half) - half) | 0;
      const oy = (Math.random() * (2 * half) - half) | 0;
      // 关键（docs/issue2.md §三.1）：固有亮度在 init 时从 sampleLuminance()
      // （uniform[0,255]）采样一次并持久化，整个 attempt 内不重置 → 单帧与背景同分布
      // （docs/issue.md §4 不破坏），整簇刚体平移时帧间纹理连贯，人眼瞬间识别运动。
      const luminance = sampleLuminance();
      // 持久化丢弃标记（反密度分析）：init 时一次性掷骰，整个 attempt 不变。既保留
      // 簇内密度低于满密度的防御，又避免每帧随机消失/出现的高频闪烁（与亮度持久化
      // 同理——任何帧间随机性都会让肉眼运动感知归零，见 docs/issue2.md §一）。
      const dropped = Math.random() < dropRate;
      particles[i] = { ox, oy, luminance, dropped };
    }
    this.targetParticles = particles;
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

    // 2) 目标方块：把持久化的簇粒子整体平移到当前贝塞尔中心（刚体位移），
    //    承载"共同命运"显影。中心逐帧沿贝塞尔推进 → 整簇共同位移 → 人眼积分成
    //    "移动的方块"。
    //
    //    肉眼显影核心（docs/issue2.md §一/§二）：每个粒子的亮度用其【持久化固有亮度】
    //    p.luminance，绝不在本循环内重新调用 sampleLuminance()/Math.random()。
    //    否则帧间亮度相关性归零，人眼无法识别为同一物体在平移，方块融进背景雪花。
    //
    //    单帧灰度泄露防护（docs/issue.md §1/§4）：
    //    - 中心取整后再加整数偏移 → 所有写入坐标为整数，杜绝亚像素（§2，本就不存在）。
    //    - 粒子固有亮度在 init 时从同一 sampleLuminance() 采样 → 方块区域内任意被覆盖
    //      像素的灰度分布仍与背景同分布（i.i.d. uniform[0,255]），单帧直方图不可区分
    //      （§4 闭环）。可见性只来自时间维度的【共同位移 + 纹理连贯】。
    const center = bezierAt(params.controlPoints, t);
    const cx = Math.round(center[0]);
    const cy = Math.round(center[1]);
    const particles = this.targetParticles;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      // 持久化丢弃标记（反密度分析）：init 时已定，不再每帧掷骰（避免高频闪烁）
      if (p.dropped) continue;
      const px = cx + p.ox;
      const py = cy + p.oy;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      // 粒子的固有亮度（init 时从 uniform[0,255] 采样并持久化）。
      // ⚠️ 禁止在此重新采样 —— 见文件头注释与 docs/issue2.md §一。
      const v = p.luminance;
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
