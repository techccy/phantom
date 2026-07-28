"""基于高熵种子的确定路径派生（issue #7）。

背景：旧协议（v0.1.0）把贝塞尔控制点 `controlPoints` 明文塞进 /challenge
密文下发，攻击者 hook 一次 `crypto.subtle.decrypt` 就能在点击前拿到整条路径
（见 issue #7、docs/fuck.js）。

修复：后端不再下发任何坐标。只下发一段高熵 `path_seed`（16 字节）。
渲染所需的 4 个贝塞尔控制点，由前后端【同一段确定性 PCG32 + 域分离派生】
从该种子推出来——网络上只有不可解读的种子在跑。

PCG32 选型理由：
  - 统计性质优良的快速伪随机算法，纯整数运算（位移 / 异或 / 乘法 / 取模）。
  - 输出仅由 (seed, 流位置) 决定，无隐藏状态 → 前后端实现只要按同一组常数
    推进即可逐字相同（见 tests/test_challenge.py 与 frontend/scripts/prng-test.ts
    锁定的同一组 KAT 向量）。

域分离（domain separation）：每抽一种数都先喂一个明文标签进状态推进，
确保"抽 x"与"抽 y / 抖动幅度"走不同的比特流分支，互相不可预测、不可复用。

路径形状的【来源】是 `derive_bezier_path` 本身（给定 seed 即给定形状），
创建 challenge 后只活在后端 Redis 里供评分，**不再下发**。本文件提供的是
"种子 → 控制点"的确定性映射，供前后端在各自一侧复现同一组坐标。
"""
from __future__ import annotations

import struct

# PCG32 常数（pcg_setseq_64_xsh_rr_32 标准实现，与 frontend/src/prng.ts 完全一致）。
# 不调整这些值——前后端任一侧改动都会让 KAT（tests/test_challenge.py）崩。
PCG32_MULTIPLIER = 0x5851F42D4C957F2D
PCG32_INCREMENT_DEFAULT = 0x14057B7EF767814F


def _rotr32(x: int, r: int) -> int:
    x &= 0xFFFFFFFF
    return (x >> r) | (x << (32 - r)) & 0xFFFFFFFF


class PCG32:
    """pcg_setseq_64_xsh_rr_32 / 32-bit 输出。

    状态 (state, inc) 均为 64 位无符号。同 (seed, seq) 下，next_u32() 输出
    序列严格确定；不同 seq 走相互独立的流。
    """

    __slots__ = ("state", "inc")

    def __init__(self, seed: int, seq: int = 0) -> None:
        self.state = 0
        # inc 必须奇数（PCG 约定）：把 seq 哈希进 64 位奇数增量。
        self.inc = (((seq << 1) | 1) & 0xFFFFFFFFFFFFFFFF)
        # PCG 初始化：先喂 seed 到 state，再步进一次。
        self.next_u32()
        self.state = (self.state + (seed & 0xFFFFFFFFFFFFFFFF)) & 0xFFFFFFFFFFFFFFFF
        self.next_u32()

    def next_u32(self) -> int:
        old = self.state
        self.state = (old * PCG32_MULTIPLIER + self.inc) & 0xFFFFFFFFFFFFFFFF
        # XSH-RR：高 58 位异或低 6 位 → 右旋 old>>59 位
        xorshifted = (((old >> 18) ^ old) >> 27) & 0xFFFFFFFF
        rot = (old >> 59) & 31
        return _rotr32(xorshifted, rot)

    def next_u32_in_range(self, lo: int, hi: int) -> int:
        """[lo, hi] 闭区间均匀整数。hi - lo 必须落在 [0, 2^32-1]。"""
        span = hi - lo
        if span < 0:
            raise ValueError("range span must be >= 0")
        limit = 0xFFFFFFFF - (0xFFFFFFFF % (span + 1)) if span < 0xFFFFFFFF else 0xFFFFFFFF
        while True:
            r = self.next_u32()
            if r <= limit:
                return lo + (r % (span + 1))


def _seed_seq(seed: bytes, seq_label: bytes) -> "PCG32":
    """从 16 字节种子派生 PCG32 实例。

    seq_label 通过 SHA-256 哈希成 64 位 seq，做域分离：同一 seed 在不同
    seq_label 下走独立的 PCG 流，互不可预测。
    """
    import hashlib
    h = hashlib.sha256(seq_label + b"\x00" + seed).digest()
    seed_u64 = int.from_bytes(h[:8], "little")
    seq_u64 = int.from_bytes(h[8:16], "little")
    return PCG32(seed_u64, seq_u64)


def derive_bezier_path(
    seed: bytes,
    canvas_w: int,
    canvas_h: int,
    margin: int = 40,
) -> list[tuple[float, float]]:
    """从 path_seed 确定性地派生 4 个贝塞尔控制点。

    与 frontend/src/prng.ts 的 deriveBezierPath 严格一一对应：
      - 同一 (seed, canvas_w, canvas_h) 必出同一组 4 控制点（见 KAT 测试）。
      - p0/p3（起终点）落在画布 [margin, w-margin] 内；
      - p1/p2（中间控制点）落点更靠内（margin=70），避免路径冲出画布。
      - 不再做"起终点距离 ≥ 0.35 对角线"重试——确定性派生不允许 reject-sampling
        （否则前后端要重放相同的随机数消耗，极易出错）。靠校验 KAT 向量
        保证两侧坐标一致，路径形状质量由 seed 熵保证。

    Args:
        seed: 16 字节高熵种子（challenge 创建时随机生成）。
        canvas_w, canvas_h: 画布尺寸。
        margin: 起终点离画布边缘的像素余量。

    Returns:
        4 个 (x, y) 控制点，与前端 deriveBezierPath 严格一一对应。
    """
    if len(seed) != 16:
        raise ValueError("path_seed 必须是 16 字节")

    rng = _seed_seq(seed, b"phantom.bezier.v1")
    points: list[tuple[float, float]] = []
    for i in range(4):
        # 每个控制点用一个独立 seq 流（域分离），x / y 同流内连续取。
        point_rng = _seed_seq(seed, b"phantom.bezier.point.%d" % i)
        # 中间控制点 p1/p2 收紧内边距，避免路径冲出画布。
        m = margin if i in (0, 3) else max(margin, 70)
        x = point_rng.next_u32_in_range(m, max(m, canvas_w - m))
        y = point_rng.next_u32_in_range(m, max(m, canvas_h - m))
        points.append((float(x), float(y)))
    # 抑制未使用警告（rng 仅用于文档化的"主流"；实际派生走 point 子流）。
    _ = rng
    return points


def path_seed_bytes_to_hex(seed: bytes) -> str:
    """约定：path_seed 以 32 字符 hex 字符串下发（base64url 也可，hex 更利于排障）。"""
    if len(seed) != 16:
        raise ValueError("path_seed 必须是 16 字节")
    return seed.hex()


def path_seed_hex_to_bytes(seed_hex: str) -> bytes:
    return bytes.fromhex(seed_hex)


# ---- 调试 / KAT 工具 ----
def _self_check() -> None:  # pragma: no cover - 仅手动运行
    """打印一组 (seed, canvas) 下的派生结果，供人工对账。"""
    seed = bytes.fromhex("0123456789abcdeffedcba9876543210")
    cp = derive_bezier_path(seed, 480, 480)
    print(struct.pack("<2Q", *[int.from_bytes(seed[i:i + 8], "little") for i in (0, 8)]).hex())
    print(cp)


if __name__ == "__main__":  # pragma: no cover
    _self_check()
