// 目标方块"共同命运"粒子簇的纯逻辑核心（手册 §一、§二）。
//
// 设计要点：
//   - 粒子是【持久化】的：每个粒子有固定的相对偏移 (rx, ry) ∈ [-half, +half)²
//     与固定灰度 v ∈ [0,255]（均匀分布，与背景噪点同一分布）。
//   - 每帧把粒子整体平移到当前贝塞尔中心 (cx, cy) 后写入缓冲 → "共同位移"
//     （Common Fate），人眼靠帧间时间积分显出"移动的方块"。
//   - gain 控制亮度增强：
//       gain = 0 → 粒子灰度与背景【同分布】（均匀 [0,255]），单帧上目标区与背景
//                  无任何统计差异 → 机器逐帧密度分析失效；人眼靠"共同位移"仍可见。
//       gain > 0 → 在原灰度上叠加线性增益（提亮），粒子整体变亮，便于调试/增强显影。
//   - 顺带把少量粒子随机丢弃（dropRate），破坏密度统计（反密度分析）。
//
// 纯逻辑、无 canvas 依赖 → 可脱离 DOM 在 node 里单测（见 scripts/brightness-test.mjs）。

/** 持久化粒子（相对偏移 + 固定灰度）。 */
export interface Particle {
  /** 相对方块中心的 x 偏移（像素，范围 [-half, +half)）。 */
  rx: number;
  /** 相对方块中心的 y 偏移（像素，范围 [-half, +half)）。 */
  ry: number;
  /** 粒子固有灰度（0~255，均匀分布，与背景同分布）。 */
  v: number;
}

/** 生成一簇持久化粒子。
 *  count 为粒子数；half 为方块半边长（决定偏移范围）。 */
export function makeCluster(count: number, half: number): Particle[] {
  const out: Particle[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      // Math.random() ∈ [0,1) → 偏移 [-half, +half)
      rx: Math.random() * 2 * half - half,
      ry: Math.random() * 2 * half - half,
      // 与背景 paintFullNoise 同分布：均匀 [0,255]
      v: (Math.random() * 256) | 0,
    };
  }
  return out;
}

/** 画布缓冲类型：宽 w、高 h、RGBA（data.length = w*h*4）。 */
export interface Buffer {
  readonly w: number;
  readonly h: number;
  /** RGBA，按行主序；每像素 4 字节。 */
  data: Uint8ClampedArray;
}

/** 铺满整个缓冲为均匀随机灰度噪点（背景）。
 *  与动态帧背景同分布、同密度 → 按下/松开无明暗跳变。 */
export function paintFullNoise(buf: Buffer): void {
  const { data } = buf;
  for (let i = 0; i < data.length; i += 4) {
    const v = (Math.random() * 256) | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
}

/** 把一簇持久化粒子整体平移到中心 (cx,cy) 后写入缓冲。
 *
 *  - particles: 持久化粒子簇（来自 makeCluster，跨帧复用 → 共同命运）。
 *  - center: 当前贝塞尔中心（像素，浮点）。
 *  - gain: 亮度增益。0 → 粒子保持固有灰度（与背景同分布，机器逐帧看不出）；
 *          >0 → 灰度向 255 线性提亮（min 钳到 255）。
 *  - dropRate: 每帧每粒子随机丢弃概率（反密度分析）。
 *  - brightnessScale: 仅预热脉冲用（呼吸提亮），与 gain 叠加；正常渲染恒为 1。 */
export function stampCluster(
  buf: Buffer,
  particles: Particle[],
  center: [number, number],
  gain: number,
  dropRate: number,
  brightnessScale = 1,
): void {
  const { w, h, data } = buf;
  const cx = center[0];
  const cy = center[1];
  for (let i = 0; i < particles.length; i++) {
    // 反密度分析：每帧每粒子独立掷骰丢弃
    if (Math.random() < dropRate) continue;
    const px = (cx + particles[i].rx) | 0;
    const py = (cy + particles[i].ry) | 0;
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    // 灰度 = 固有 v + gain·(255 - v) → gain=0 时 = v（与背景同分布）
    const boosted = particles[i].v + gain * (255 - particles[i].v);
    const v = Math.min(255, (boosted * brightnessScale) | 0);
    const idx = (py * w + px) * 4;
    data[idx] = v;
    data[idx + 1] = v;
    data[idx + 2] = v;
    data[idx + 3] = 255;
  }
}
