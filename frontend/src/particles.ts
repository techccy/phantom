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
// issue #10（docs/debug10.md §一.2）：引入【粒子生命周期高频扰动】。
//   phantom-solver 的 CV 模式靠"匹配跨帧保持灰度与相对位置的粒子"定位目标中心。
//   若粒子跨帧 100% 持久化，CV 能逐粒子关联并求质心。故每帧按 ~15-20Hz 概率让一
//   部分粒子"消亡并重绘"（rx/ry/v 重新随机）→ 质心微幅跳变 + 逐粒子关联被打断。
//   人眼视网膜有 ~100-200ms 时间积分平滑窗口，感知不到断裂；CV 的帧间匹配则失效。
//
// 纯逻辑、无 canvas 依赖 → 可脱离 DOM 在 node 里单测（见 scripts/brightness-test.mjs）。

/** 持久化粒子（相对偏移 + 固定灰度 + 生命周期阈值）。 */
export interface Particle {
  /** 相对方块中心的 x 偏移（像素，范围 [-half, +half)）。 */
  rx: number;
  /** 相对方块中心的 y 偏移（像素，范围 [-half, +half)）。 */
  ry: number;
  /** 粒子固有灰度（0~255，均匀分布，与背景同分布）。 */
  v: number;
  /** issue #10：存活计数器。每帧 +1，达到 lifeSpan 时按概率重生（打破 CV 关联）。 */
  age: number;
  /** issue #10：该粒子的生命周期长度（帧）。到龄后按 regenProb 概率重绘偏移/灰度。 */
  lifeSpan: number;
}

/** 生成一簇持久化粒子。
 *  count 为粒子数；half 为方块半边长（决定偏移范围）。 */
export function makeCluster(count: number, half: number): Particle[] {
  const out: Particle[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = _makeParticle(half);
  }
  return out;
}

/** 造一个新粒子（随机偏移 + 均匀灰度 + 随机生命周期）。 */
function _makeParticle(half: number): Particle {
  // 生命周期 lifeSpan 在 [LIFE_MIN, LIFE_MAX] 帧（@60fps ≈ 67~133ms ≈ 7.5~15Hz 重生），
  // 让每个粒子以不同周期消亡重生 → 质心持续微跳、逐粒子关联断裂。
  const lifeSpan =
    PARTICLE_LIFE_MIN + Math.floor(Math.random() * (PARTICLE_LIFE_MAX - PARTICLE_LIFE_MIN + 1));
  return {
    // Math.random() ∈ [0,1) → 偏移 [-half, +half)
    rx: Math.random() * 2 * half - half,
    ry: Math.random() * 2 * half - half,
    // 与背景 paintFullNoise 同分布：均匀 [0,255]
    v: (Math.random() * 256) | 0,
    age: 0,
    lifeSpan,
  };
}

/** issue #10：粒子生命周期边界（帧，@60fps）。重生频率落在 7.5~15Hz 区间。 */
export const PARTICLE_LIFE_MIN = 4;
export const PARTICLE_LIFE_MAX = 8;

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

/** issue #10（docs/debug10.md §一.1）：相干漂移噪点背景。
 *
 * 纯白噪点在多帧时域累加下均值为 0 → 攻击者（phantom-solver 的 CV 模式）对 N 帧
 * 求和即可抵消背景、暴露协同移动的目标粒子。本函数在逐像素白噪之上叠加一层
 * 【低分辨率相干漂移场】：该场跨帧仅缓慢平移（driftX/driftY），帧间高度相关 →
 * 时域求和后【不会抵消】，残留为非零的斑驳纹理，把目标粒子淹没其中。
 *
 * 漂移场对全画布（含目标区）均匀作用 → 单帧上目标区与背景【仍同分布】（两者都叠加了
 * 同一层漂移偏置），不破坏「gain=0 时目标≈背景」的反密度分析性质，人眼仍靠共同位移
 * 显影。漂移场由调用方持有并逐帧推进 driftX/driftY（相关更新），见 PhantomRenderer。
 *
 * 参数：
 *  - driftField: 持久低分辨率场，长度 = driftCols*driftRows，元素为 [0,255]。
 *  - tilePx: 每个场单元覆盖多少像素（越大越粗、漂移越明显）。
 *  - driftX/driftY: 当前漂移量（场单元数，可为小数→向下取整）。逐帧推进 → 帧间相关。
 *  - mix: 漂移偏置的混合强度 [0,1]：0=纯白噪（退化为 paintFullNoise），1=完全用场值。
 */
export function paintFullNoiseDrift(
  buf: Buffer,
  driftField: Uint8Array,
  driftCols: number,
  driftRows: number,
  tilePx: number,
  driftX: number,
  driftY: number,
  mix: number,
): void {
  const { w, h, data } = buf;
  if (
    driftCols < 1 || driftRows < 1 || driftField.length < driftCols * driftRows
    || tilePx < 1 || mix <= 0
  ) {
    // 退化：无漂移场或混合为 0 → 退化为纯白噪
    paintFullNoise(buf);
    return;
  }
  const dx = Math.floor(driftX);
  const dy = Math.floor(driftY);
  for (let y = 0; y < h; y++) {
    const gy = ((((y / tilePx) | 0) + dy) % driftRows + driftRows) % driftRows;
    const rowBase = gy * driftCols;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const gx = ((((x / tilePx) | 0) + dx) % driftCols + driftCols) % driftCols;
      const bias = driftField[rowBase + gx]; // 场值 [0,255]
      // 白噪 + 漂移偏置：把白噪向 bias 拉 mix 比例
      const white = (Math.random() * 256) | 0;
      let v = white + ((bias - white) * mix) | 0;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      const idx = (rowOff + x) << 2;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
}

/** 把一簇持久化粒子整体平移到中心 (cx,cy) 后写入缓冲。
 *
 *  - particles: 持久化粒子簇（来自 makeCluster，跨帧复用 → 共同命运）。
 *  - center: 当前贝塞尔中心（像素，浮点）。
 *  - gain: 亮度增益。0 → 粒子保持固有灰度（与背景同分布，机器逐帧看不出）；
 *          >0 → 灰度向 255 线性提亮（min 钳到 255）。
 *  - dropRate: 每帧每粒子随机丢弃概率（反密度分析）。
 *  - brightnessScale: 仅预热脉冲用（呼吸提亮），与 gain 叠加；正常渲染恒为 1。
 *  - half / regenProb（issue #10 §一.2）：开启【粒子生命周期高频扰动】。
 *      half≥0 且 regenProb>0 时，到龄粒子按 regenProb 概率重生（重置 rx/ry/v），
 *      打断 CV 跨帧逐粒子关联。缺省（half<0 或 regenProb=0）= 不重生，向后兼容。 */
export function stampCluster(
  buf: Buffer,
  particles: Particle[],
  center: [number, number],
  gain: number,
  dropRate: number,
  brightnessScale = 1,
  half = -1,
  regenProb = 0,
): void {
  const { w, h, data } = buf;
  const cx = center[0];
  const cy = center[1];
  const regenEnabled = half >= 0 && regenProb > 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    // issue #10 §一.2：生命周期高频扰动。到龄粒子按概率重生 → 质心微跳、CV 关联断裂。
    // 手工构造的无 lifeSpan 粒子（如亮度自检的标记粒子）视为永生，不重生。
    if (regenEnabled && p.lifeSpan !== undefined && p.age !== undefined && p.age >= p.lifeSpan) {
      if (Math.random() < regenProb) {
        // 重生：重置偏移/灰度，age 归零（half 来自入参，保证新偏移仍在方块内）
        p.rx = Math.random() * 2 * half - half;
        p.ry = Math.random() * 2 * half - half;
        p.v = (Math.random() * 256) | 0;
        p.age = 0;
      } else {
        p.age = 0; // 未重生也复位计数，继续存活一个周期
      }
    }
    if (p.age !== undefined) p.age++;
    // 反密度分析：每帧每粒子独立掷骰丢弃
    if (Math.random() < dropRate) continue;
    const px = (cx + p.rx) | 0;
    const py = (cy + p.ry) | 0;
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    // 灰度 = 固有 v + gain·(255 - v) → gain=0 时 = v（与背景同分布）
    const boosted = p.v + gain * (255 - p.v);
    const v = Math.min(255, (boosted * brightnessScale) | 0);
    const idx = (py * w + px) * 4;
    data[idx] = v;
    data[idx + 1] = v;
    data[idx + 2] = v;
    data[idx + 3] = 255;
  }
}
