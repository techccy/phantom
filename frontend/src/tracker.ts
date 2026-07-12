// 行为防线数据采集：pointer 轨迹（手册 §三）。
//
// 仅采集原始事件序列 [(clientX, clientY, performance.now())] 换算到画布坐标，
// 不做任何平滑/等间隔化（防伪造完美等间隔）。上采样由后端 DSP 完成。

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
    const x = ((e.clientX - this.rect.left) / this.rect.width) *
      this.canvas.width;
    const y = ((e.clientY - this.rect.top) / this.rect.height) *
      this.canvas.height;
    this.samples.push([x, y, performance.now()]);
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
