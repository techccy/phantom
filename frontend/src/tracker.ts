// 行为防线数据采集：pointer 轨迹（手册 §三）。
//
// 仅采集原始事件序列 [(clientX, clientY, performance.now())] 换算到画布坐标，
// 不做任何平滑/等间隔化（防伪造完美等间隔）。上采样由后端 DSP 完成。
//
// 关键：优先消费 pointermove.getCoalescedEvents() 取回被浏览器合并掉的
// 原始触摸子事件——移动端（iOS Safari/Android Chrome）为省主线程会把多个
// 触摸点合并成一个 pointermove，不取回则高频残差被降采样抹平，真实人类
// 轨迹会被后端误判为"过度平滑机器"。

export type Sample = [number, number, number]; // [x, y, t_ms]

export class TrajectoryTracker {
  private samples: Sample[] = [];
  private active = false;
  private rect: DOMRect | null = null;

  constructor(private canvas: HTMLCanvasElement) {}

  start(): void {
    this.active = true;
    this.samples = [];
    this.rect = this.canvas.getBoundingClientRect();
    this.bind();
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.active || !this.rect) return;
    // 移动端浏览器会把多个原始触摸点合并成一个 pointermove（尤其 iOS Safari），
    // 必须用 getCoalescedEvents() 取回被合并掉的子事件，否则高频细节
    // （生理震颤/微抖）会因降采样被抹平，导致后端残差偏低、误判为机器。
    // 桌面鼠标一般无合并事件（返回空数组），自动回退到 [e]，行为不变。
    const coalesced = (typeof e.getCoalescedEvents === "function")
      ? e.getCoalescedEvents()
      : [];
    const events = coalesced.length ? coalesced : [e];
    for (const ev of events) {
      const x = ((ev.clientX - this.rect.left) / this.rect.width) *
        this.canvas.width;
      const y = ((ev.clientY - this.rect.top) / this.rect.height) *
        this.canvas.height;
      this.samples.push([x, y, performance.now()]);
    }
  };

  private bind(): void {
    // 在 window 上捕获，避免快速移动时 pointer 离开元素丢点
    window.addEventListener("pointermove", this.onMove, { passive: true });
  }

  stop(): Sample[] {
    this.active = false;
    window.removeEventListener("pointermove", this.onMove);
    // 记录最后一个采样点时间戳（用于后端 3s 时效校验）
    return this.samples;
  }

  get lastPointT(): number {
    return this.samples.length
      ? this.samples[this.samples.length - 1][2]
      : 0;
  }
}
