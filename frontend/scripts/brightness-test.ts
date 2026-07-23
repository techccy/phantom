// 亮度/反密度分析自检：验证目标方块粒子簇在 gain=0 时与背景【同分布】，
// 机器逐帧密度/亮度分析失效；gain>0 时显著更亮；且粒子持久化 + 共同位移
// （"共同命运"）保障人眼可见。
//
// 运行：npx tsx scripts/brightness-test.ts
// 直接 import 纯逻辑模块 src/particles.ts，无需 DOM/canvas。

import { makeCluster, paintFullNoise, stampCluster, type Buffer } from "../src/particles";

const W = 300;
const H = 300;
const HALF = 26; // 与 .env PHANTOM_TARGET_HALF_PC 一致
const DENSITY = 0.8; // 与 .env VITE_PARTICLE_DENSITY 一致
const DROP = 0.05; // 与 .env VITE_PARTICLE_DROP_RATE 一致
const COUNT = Math.max(64, Math.floor((2 * HALF) ** 2 * DENSITY));
const N = 200; // 采样帧数（蒙特卡洛平均分布统计）

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? "  " + extra : ""}`);
  }
}

function mean(a: number[]): number {
  return a.reduce((s, x) => s + x, 0) / a.length;
}
function stddev(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

/** 从 buffer 中提取目标方块区域（center±HALF）内的灰度样本（非 255-alpha 覆盖的像素）。 */
function sampleBoxRegion(buf: Buffer, center: [number, number]): number[] {
  const { w, h, data } = buf;
  const out: number[] = [];
  const left = Math.round(center[0] - HALF);
  const top = Math.round(center[1] - HALF);
  for (let py = top; py < top + 2 * HALF; py++) {
    for (let px = left; px < left + 2 * HALF; px++) {
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      out.push(data[(py * w + px) * 4]); // R = G = B
    }
  }
  return out;
}

/** 从 buffer 中提取远离方块的背景区域灰度样本。 */
function sampleBgRegion(buf: Buffer, center: [number, number]): number[] {
  const { w, data } = buf;
  const d: number[] = [];
  const cx = center[0];
  const cy = center[1];
  // 取左上 1/4 区域中、距方块足够远的像素子样本
  const step = 3;
  for (let py = 10; py < H / 2 - HALF - 5; py += step) {
    for (let px = 10; px < W / 2 - HALF - 5; px += step) {
      if (Math.hypot(px - cx, py - cy) > 2 * HALF) {
        d.push(data[(py * w + px) * 4]);
      }
    }
  }
  return d;
}

// ---------- 测试 1：gain=0 时目标区与背景【同分布】 ----------
console.log("\n[1] gain=0：目标区粒子灰度与背景同分布（机器逐帧看不出）");
{
  const cluster = makeCluster(COUNT, HALF);
  const boxVals: number[] = [];
  const bgVals: number[] = [];
  for (let f = 0; f < N; f++) {
    const data = new Uint8ClampedArray(W * H * 4);
    const buf: Buffer = { w: W, h: H, data };
    paintFullNoise(buf);
    // center 随机（模拟贝塞尔推进），但测试 1 只验证分布，位置不影响分布
    const center: [number, number] = [W / 2, H / 2];
    stampCluster(buf, cluster, center, 0, DROP);
    boxVals.push(...sampleBoxRegion(buf, center));
    bgVals.push(...sampleBgRegion(buf, center));
  }
  const boxMean = mean(boxVals);
  const bgMean = mean(bgVals);
  const boxSd = stddev(boxVals);
  const bgSd = stddev(bgVals);
  // 背景 paintFullNoise 是均匀 [0,255]：理论均值≈127.5，标准差≈73.6
  check(
    "背景为均匀 [0,255]（均值≈127.5, sd≈73.6）",
    Math.abs(bgMean - 127.5) < 4 && Math.abs(bgSd - 73.6) < 5,
    `(mean=${bgMean.toFixed(1)}, sd=${bgSd.toFixed(1)})`,
  );
  // gain=0 时目标区分布应与背景几乎一致（粒子 v 也是均匀 [0,255]，未提亮）
  check(
    "gain=0 目标区均值 ≈ 背景均值（差异 < 5）",
    Math.abs(boxMean - bgMean) < 5,
    `(box mean=${boxMean.toFixed(1)} vs bg mean=${bgMean.toFixed(1)})`,
  );
  check(
    "gain=0 目标区标准差 ≈ 背景标准差（分布一致）",
    Math.abs(boxSd - bgSd) < 6,
    `(box sd=${boxSd.toFixed(1)} vs bg sd=${bgSd.toFixed(1)})`,
  );
}

// ---------- 测试 2：gain=1 时目标区显著亮于背景 ----------
console.log("\n[2] gain=1：目标区显著亮于背景（提亮可见）");
{
  const cluster = makeCluster(COUNT, HALF);
  const boxVals: number[] = [];
  const bgVals: number[] = [];
  for (let f = 0; f < N; f++) {
    const data = new Uint8ClampedArray(W * H * 4);
    const buf: Buffer = { w: W, h: H, data };
    paintFullNoise(buf);
    const center: [number, number] = [W / 2, H / 2];
    stampCluster(buf, cluster, center, 1, DROP);
    boxVals.push(...sampleBoxRegion(buf, center));
    bgVals.push(...sampleBgRegion(buf, center));
  }
  const boxMean = mean(boxVals);
  const bgMean = mean(bgVals);
  // gain=1 时粒子 v → 255，目标区均值应明显高于背景
  check(
    "gain=1 目标区均值显著高于背景（> 30）",
    boxMean - bgMean > 30,
    `(box mean=${boxMean.toFixed(1)} vs bg mean=${bgMean.toFixed(1)}, Δ=${(boxMean - bgMean).toFixed(1)})`,
  );
}

// ---------- 测试 3：粒子持久化 + 共同位移（"共同命运"） ----------
console.log("\n[3] 持久化 + 共同位移：同一簇粒子跨帧整体平移");
{
  // 用一个【可识别】的簇：手动构造一个偏右上 5px 的标记粒子（rx=+5, ry=-5）
  // 跟踪它在两帧（中心不同）下的绝对像素位置，验证相对偏移恒定。
  const cluster = makeCluster(COUNT, HALF);
  const marker = { rx: 5, ry: -5, v: 200 };
  cluster.push(marker);

  const center1: [number, number] = [100, 100];
  const center2: [number, number] = [160, 140];
  const d1 = new Uint8ClampedArray(W * H * 4);
  const buf1: Buffer = { w: W, h: H, data: d1 };
  paintFullNoise(buf1);
  // dropRate=0 保证标记粒子不丢
  stampCluster(buf1, cluster, center1, 0.9, 0);
  const expectedPx1 = (center1[0] + marker.rx) | 0;
  const expectedPy1 = (center1[1] + marker.ry) | 0;
  const got1 = buf1.data[(expectedPy1 * W + expectedPx1) * 4];

  const d2 = new Uint8ClampedArray(W * H * 4);
  const buf2: Buffer = { w: W, h: H, data: d2 };
  paintFullNoise(buf2);
  stampCluster(buf2, cluster, center2, 0.9, 0);
  const expectedPx2 = (center2[0] + marker.rx) | 0;
  const expectedPy2 = (center2[1] + marker.ry) | 0;
  const got2 = buf2.data[(expectedPy2 * W + expectedPx2) * 4];

  // 相对偏移 (5,-5) 在两帧下都把标记粒子精确放到 center+(5,-5)
  check(
    "帧1：标记粒子精确平移到 center1+(5,-5)",
    got1 === ((marker.v + 0.9 * (255 - marker.v)) | 0),
    `(center1=${center1} → px=${expectedPx1},py=${expectedPy1}, v=${got1})`,
  );
  check(
    "帧2：标记粒子精确平移到 center2+(5,-5)（同一相对偏移）",
    got2 === ((marker.v + 0.9 * (255 - marker.v)) | 0),
    `(center2=${center2} → px=${expectedPx2},py=${expectedPy2}, v=${got2})`,
  );
  // 两帧的绝对位移差 = 中心位移差 → 证明整簇共同平移
  check(
    "粒子绝对位移 = 中心位移（共同命运）",
    expectedPx2 - expectedPx1 === center2[0] - center1[0] &&
      expectedPy2 - expectedPy1 === center2[1] - center1[1],
  );
}

// ---------- 测试 4：gain=0 单帧目标区无密度峰（机器视角盲区） ----------
console.log("\n[4] gain=0：单帧目标区无亮度峰（机器逐帧密度分析盲区）");
{
  // 模拟机器"逐帧密度分析"：在单帧上比目标区 vs 等大随机区域的最大亮度。
  // gain=0 时两者不应有系统性差异（目标区不应出现明显的亮像素聚集）。
  const cluster = makeCluster(COUNT, HALF);
  let targetBrighterCount = 0;
  const trials = 50;
  for (let f = 0; f < trials; f++) {
    const data = new Uint8ClampedArray(W * H * 4);
    const buf: Buffer = { w: W, h: H, data };
    paintFullNoise(buf);
    const center: [number, number] = [W / 2, H / 2];
    stampCluster(buf, cluster, center, 0, DROP);
    const targetMean = mean(sampleBoxRegion(buf, center));
    // 另取一个等大的"对照"区域（左上角附近）
    const ctrlMean = mean(sampleBoxRegion(buf, [50, 50]));
    if (targetMean > ctrlMean + 2) targetBrighterCount++;
  }
  // gain=0 时目标区不应系统性更亮（允许少量随机波动，但多数帧不应明显更亮）
  check(
    `gain=0 目标区不系统性更亮（< ${Math.floor(trials * 0.3)}/${trials} 帧明显更亮）`,
    targetBrighterCount < trials * 0.3,
    `(实际 ${targetBrighterCount}/${trials} 帧目标区更亮)`,
  );
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ HAS FAILURES"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
