// 行为防线数据采集：pointer/touch 轨迹（手册 §三、docs/issue3.md §3）。
//
// 仅采集原始事件序列 [(clientX, clientY, performance.now())] 换算到画布坐标，
// 不做任何平滑/等间隔化（防伪造完美等间隔）。上采样由后端 DSP 完成。
//
// iOS Safari 适配（docs/issue3.md §3）：iOS 在 pointermove 上强制 passive 且会
// 节流 touchmove，必须在 touchmove 上显式 { passive: false } + preventDefault
// 才能阻止页面弹性滚动/侧滑返回并保持 60Hz 采样率。故这里同时绑两套事件：
//   - pointermove（桌面鼠标 + 大多数 Android）：维持原有路径。
//   - touchmove { passive: false }（iOS Safari 旁路）：preventDefault + 同公式
//     映射坐标 + Math.round（issue3.md §三示例一致）。
// 通过 touchActive 标志去重，避免 iOS 上 pointer 与 touch 双重采样的重复点。
//
// 越界 clamp（docs/log5 根因）：监听器绑在 window 上，手指滑出画布边缘仍采样。
// iOS 大拇指接触面大 + activate 按钮紧贴画布下方，按下/拖拽时极易越过下沿，
// 产生 y>canvas_h 的点。后端 dtw.py 按 canvas_w/h 归一化到单位正方形，越界点
// 跑到 [0,1]² 外会与贝塞尔参考路径每点拉开 DTW 代价 → S_DTW 崩塌（log5 现象）。
// 故 mapToCanvas 内对 x/y clamp 到 [0, canvas.{width,height}-1]，stop() 再做兜底过滤。

export type Sample = [number, number, number]; // [x, y, t_ms]

export class TrajectoryTracker {
  private samples: Sample[] = [];
  private active = false;
  private rect: DOMRect | null = null;
  /** iOS 触屏进行中标志：true 时跳过 pointermove，避免 pointer+touch 双重采样。 */
  private touchActive = false;

  constructor(private canvas: HTMLCanvasElement) {}

  start(): void {
    this.active = true;
    this.samples = [];
    this.touchActive = false;
    this.rect = this.canvas.getBoundingClientRect();
    this.bind();
  }

  /** 把客户端坐标映射到画布像素坐标（issue3.md §三.2，与示例公式等价）。
   *
   * 关键：映射后必须 clamp 到 [0, canvas.width-1] / [0, canvas.height-1]。
   * 监听器绑在 window 上（见 bind()），手指滑出画布边缘仍会触发采样——
   * iOS 大拇指接触面大、activate 按钮又紧贴画布下方（phantom.ts stageWrap→
   * activateBtn→status 的纵向 flex 布局），按下/拖拽时极易越过画布下沿。
   * 后端 dtw.py 按 canvas_w/h 把轨迹归一化到单位正方形，越界点（如
   * log5 中 y=395 超 360 画布 → 归一化 1.097）会跑到 [0,1]² 外，与始终
   * 在 [0,1] 内的贝塞尔参考路径每点都拉开 DTW 代价 → S_DTW 崩塌
   * （log5：s_dtw=0.6158 → composite=0.734 < 0.8 → 即便 s_bio=0.91 仍判失败）。
   * 选 clamp 而非丢点：保留时间戳与点数，不影响后端 DSP/零交叉/震颤分析。
   */
  private mapToCanvas(clientX: number, clientY: number): [number, number] {
    if (!this.rect) return [clientX, clientY];
    const scaleX = this.canvas.width / this.rect.width;
    const scaleY = this.canvas.height / this.rect.height;
    const x = (clientX - this.rect.left) * scaleX;
    const y = (clientY - this.rect.top) * scaleY;
    const cx = Math.max(0, Math.min(this.canvas.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(this.canvas.height - 1, Math.round(y)));
    return [cx, cy];
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.active || !this.rect) return;
    // iOS/触屏环境下 pointer 与 touch 会同时触发，touchActive 时跳过 pointer
    // 走 touch 旁路（那里能 preventDefault 保采样率）。
    if (this.touchActive) return;
    const [x, y] = this.mapToCanvas(e.clientX, e.clientY);
    this.samples.push([x, y, performance.now()]);
  };

  private onTouchStart = (e: TouchEvent): void => {
    if (!this.active) return;
    // 标记触屏进行中，使 onMove(pointer) 让位于 onTouchMove
    this.touchActive = true;
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    if (!touch || !this.rect) return;
    const [x, y] = this.mapToCanvas(touch.clientX, touch.clientY);
    this.samples.push([x, y, performance.now()]);
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (!this.active || !this.rect) return;
    // 关键（issue3.md §3）：阻止 Safari 默认页面滚动/侧滑手势，避免 touchmove
    // 被节流到十几 Hz 导致零交叉率不足被判机器。
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    if (!touch) return;
    const [x, y] = this.mapToCanvas(touch.clientX, touch.clientY);
    this.samples.push([x, y, performance.now()]);
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.active) return;
    if (e.cancelable) e.preventDefault();
    // 触屏结束：交还 pointer 通道（虽然本次采集通常也快 stop 了，但保持状态干净）
    this.touchActive = false;
  };

  private bind(): void {
    // pointer：在 window 上捕获，避免快速移动时 pointer 离开元素丢点
    window.addEventListener("pointermove", this.onMove, { passive: true });
    // iOS Safari 旁路（issue3.md §3）：必须 passive:false 才能 preventDefault
    window.addEventListener("touchstart", this.onTouchStart, { passive: false });
    window.addEventListener("touchmove", this.onTouchMove, { passive: false });
    window.addEventListener("touchend", this.onTouchEnd, { passive: false });
    window.addEventListener("touchcancel", this.onTouchEnd, { passive: false });
  }

  stop(): Sample[] {
    this.active = false;
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("touchstart", this.onTouchStart);
    window.removeEventListener("touchmove", this.onTouchMove);
    window.removeEventListener("touchend", this.onTouchEnd);
    window.removeEventListener("touchcancel", this.onTouchEnd);
    // 防御性兜底：过滤掉任何非法坐标（NaN/Infinity/负值/越界）。
    // 正常路径下 mapToCanvas 已 clamp，不会有脏点；这里只兜底 rect=null
    // 退化分支（直接返回 [clientX, clientY]）或异常事件产生的极端点，
    // 避免其进入后端归一化算式让 S_DTW 异常。
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cleaned = this.samples.filter(
      ([x, y, t]) =>
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(t) &&
        x >= 0 && y >= 0 && x < W && y < H,
    );
    // 记录最后一个采样点时间戳（用于后端 3s 时效校验）
    return cleaned;
  }

  get lastPointT(): number {
    return this.samples.length
      ? this.samples[this.samples.length - 1][2]
      : 0;
  }
}
