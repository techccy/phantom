// PCG32 / 派生路径互通性自检（issue #7）。
//
// 目的：验证 frontend/src/prng.ts 与 backend/app/prng.py 在【同一组 KAT 向量】
// 下产出完全相同的 4 控制点。这组向量与 tests/test_challenge.py 镜像——
// 任一侧常数改错都会让两侧同时红。
//
// 运行：npx tsx scripts/prng-test.ts（或 npm run test:prng）

import { deriveBezierPath } from "../src/prng";

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

// 与 backend/tests/test_challenge.py::test_pcg_kat_vectors 完全一致。
const KAT: Array<[string, number, number, [number, number][]]> = [
  ["0123456789abcdeffedcba9876543210", 480, 480,
    [[355, 397], [402, 252], [75, 77], [60, 372]]],
  ["abcdef012345678900000000ffffffff", 480, 480,
    [[298, 405], [394, 102], [186, 133], [91, 240]]],
  ["11111111111111112222222222222222", 360, 360,
    [[290, 206], [136, 262], [273, 101], [135, 107]]],
];

console.log("[1] KAT：前端派生 == 后端派生（逐点对齐）");
for (const [seed, w, h, expected] of KAT) {
  const got = deriveBezierPath(seed, w, h);
  const ok = got.length === expected.length &&
    got.every((p, i) => p[0] === expected[i][0] && p[1] === expected[i][1]);
  check(`seed=${seed} canvas=${w}x${h}`, ok,
    `→ got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
}

console.log("\n[2] 确定性：同 seed 两次派生结果相同");
{
  const seed = "abababababababababababababababab";
  const a = deriveBezierPath(seed, 480, 480);
  const a2 = deriveBezierPath(seed, 480, 480);
  const ok = a.length === a2.length &&
    a.every((p, i) => p[0] === a2[i][0] && p[1] === a2[i][1]);
  check("同 seed 两次一致", ok);
}

console.log("\n[3] 不同 seed → 不同路径");
{
  const a = deriveBezierPath("01".repeat(16), 480, 480);
  const b = deriveBezierPath("02".repeat(16), 480, 480);
  check("seed 差 1 位 → 路径不同",
    !a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]));
}

console.log("\n[4] 画布边界：所有控制点落在 [margin, w-margin] 内");
{
  const cp = deriveBezierPath("deadbeef".repeat(4), 480, 480);
  const ok = cp.every(([x, y], i) => {
    const m = i === 0 || i === 3 ? 40 : 70;
    return x >= m && x <= 480 - m && y >= m && y <= 480 - m;
  });
  check("4 控制点全部在画布边界内", ok, `→ ${JSON.stringify(cp)}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ HAS FAILURES"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
