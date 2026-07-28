// 基于高熵种子的确定性路径派生（issue #7）。
//
// 背景：旧协议（v0.1.0）把贝塞尔控制点 controlPoints 明文塞进 /challenge
// 密文下发，攻击者 hook 一次 crypto.subtle.decrypt 就能在点击前拿到整条路径
// （见 issue #7、docs/fuck.js）。
//
// 修复：后端不再下发任何坐标。只下发一段高熵 pathSeed（16 字节，hex 字符串）。
// 渲染所需的 4 个贝塞尔控制点，由前端【本地】用本文件的 PCG32 + 域分离派生
// 从种子推出来——后端用【完全相同的算法】（backend/app/prng.py）推出同一组
// 坐标做 DTW 评分。
//
// 为什么安全：
//   - 网络上只有不可解读的 pathSeed（且在 AES-GCM 密文里）。
//   - 即使攻击者 hook decrypt 拿到 pathSeed，仍需逆出被混淆 + 内联进 SDK 的
//     派生算法才能复算控制点；而 v0.1.0 是直接给可用的 [x,y]，零成本。
//   - 前端 SDK 在 vite.sdk.config.ts 下经控制流平坦化 + 字符串数组加密，进一步
//     提升派生逻辑的静态分析成本。
//
// 本文件与 backend/app/prng.py 严格一一对应：
//   - 同一 (pathSeed, canvas_w, canvas_h) 必出同一组 4 控制点。
//   - 锁定：tests/test_challenge.py 与 scripts/prng-test.ts 共用同一组 KAT 向量。
// ⚠️ 改任何常数前请同时改两侧并更新 KAT。

import { sha256 } from "@noble/hashes/sha2.js";

// PCG32 标准常数（pcg_setseq_64_xsh_rr_32）。与后端 prng.py 完全一致。
const PCG_MULTIPLIER = 0x5851f42d4c957f2dn;
const MASK64 = (1n << 64n) - 1n;
const MASK32 = (1n << 32n) - 1n;

/** PCG32（pcg_setseq_64_xsh_rr_32 / 32-bit 输出）。
 *  纯 BigInt 实现，与 backend PCG32 逐 next_u32 对齐。 */
class PCG32 {
  state = 0n;
  inc: bigint;

  constructor(seed: bigint, seq: bigint) {
    this.inc = ((seq << 1n) | 1n) & MASK64; // inc 必须奇数
    // PCG 初始化：先 next 一次，state += seed，再 next 一次。
    this.nextU32();
    this.state = (this.state + (seed & MASK64)) & MASK64;
    this.nextU32();
  }

  nextU32(): number {
    const old = this.state;
    this.state = (old * PCG_MULTIPLIER + this.inc) & MASK64;
    // XSH-RR：((old>>18) ^ old) >> 27，再按 old>>59 右旋。
    const xorshifted = (((old >> 18n) ^ old) >> 27n) & MASK32;
    const rot = Number((old >> 59n) & 31n);
    return Number(rotr32(xorshifted, rot));
  }

  /** [lo, hi] 闭区间均匀整数（与后端 next_u32_in_range 对齐，含拒绝采样）。 */
  nextU32InRange(lo: number, hi: number): number {
    const span = hi - lo;
    if (span < 0) throw new Error("range span must be >= 0");
    const limit =
      span < 0xffffffff
        ? 0xffffffff - (0xffffffff % (span + 1))
        : 0xffffffff;
    // span+1 最大 ~2^32；与后端一致用 32-bit 比较。
    for (;;) {
      const r = this.nextU32() >>> 0;
      if (r <= limit) return lo + (r % (span + 1));
    }
  }
}

/** 32-bit 右旋。x 视为无符号 32 位。 */
function rotr32(x: bigint, r: number): bigint {
  const v = x & MASK32;
  return ((v >> BigInt(r)) | (v << BigInt(32 - r))) & MASK32;
}

/** 后端 _seed_seq 的前端镜像。
 *  SHA-256(seq_label || 0x00 || seed) → 前 8B seed_u64 / 后 8B seq_u64（均小端）。 */
function seedSeq(seed: Uint8Array, seqLabel: Uint8Array): PCG32 {
  const msg = new Uint8Array(seqLabel.length + 1 + seed.length);
  msg.set(seqLabel, 0);
  msg[seqLabel.length] = 0x00;
  msg.set(seed, seqLabel.length + 1);
  const h = sha256(msg);
  const seedU64 = bytesToU64LE(h.subarray(0, 8));
  const seqU64 = bytesToU64LE(h.subarray(8, 16));
  return new PCG32(seedU64, seqU64);
}

function bytesToU64LE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v & MASK64;
}

/** 把 hex 字符串（32 字符 = 16 字节）转成 Uint8Array。 */
export function pathSeedHexToBytes(hex: string): Uint8Array {
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`pathSeed 格式非法（期望 32 位 hex，实际 ${hex.length}）`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** UTF-8 编码（与后端 bytes 字面量一致）。 */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * 从 pathSeed 确定性地派生 4 个贝塞尔控制点。
 *
 * 与 backend/app/prng.py 的 derive_bezier_path 严格一一对应：
 *   - 同一 (pathSeed, canvas_w, canvas_h) 必出同一组 4 控制点（见 KAT）。
 *   - 每个控制点用独立的 seq 流（域分离），x/y 同流内连续取。
 *   - 中间控制点 p1/p2 收紧内边距到 70，避免路径冲出画布。
 *
 * @param pathSeedHex  32 字符 hex 种子（/challenge 解密参数里的 pathSeed 字段）
 * @param canvasW      画布宽（必须与后端按同 device 选出的一致）
 * @param canvasH      画布高
 * @param margin       起终点离画布边缘的像素余量（默认 40）
 */
export function deriveBezierPath(
  pathSeedHex: string,
  canvasW: number,
  canvasH: number,
  margin = 40,
): [number, number][] {
  const seed = pathSeedHexToBytes(pathSeedHex);
  const points: [number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const pointRng = seedSeq(seed, utf8(`phantom.bezier.point.${i}`));
    const m = i === 0 || i === 3 ? margin : Math.max(margin, 70);
    const x = pointRng.nextU32InRange(m, Math.max(m, canvasW - m));
    const y = pointRng.nextU32InRange(m, Math.max(m, canvasH - m));
    points.push([x, y]);
  }
  return points;
}
