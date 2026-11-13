/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* 放大镜 */

const RING = "#84cc16";

export class Loupe {
  readonly element: HTMLDivElement;
  private view: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private label: HTMLSpanElement;
  private rect: DOMRect | null = null;
  private pos: [number, number] | null = null;
  private inside = false;
  private rafId = 0;
  private running = false;

  constructor(
    private source: HTMLCanvasElement,
    private zoom: number,
    private size: number,
  ) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    this.element = document.createElement("div");
    this.element.className = "phantom-loupe";

    this.view = document.createElement("canvas");
    this.view.className = "phantom-loupe-view";
    this.view.width = Math.round(size * dpr);
    this.view.height = Math.round(size * dpr);
    this.view.style.width = `${size}px`;
    this.view.style.height = `${size}px`;

    const ctx = this.view.getContext("2d");
    if (!ctx) throw new Error("Loupe: 2d context 不可用");
    this.ctx = ctx;
    this.ctx.scale(dpr, dpr);
    this.ctx.imageSmoothingEnabled = false;

    this.label = document.createElement("span");
    this.label.className = "phantom-loupe-label";
    this.label.textContent = "手指位置";

    this.element.appendChild(this.view);
    this.element.appendChild(this.label);
    this.drawIdle();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rect = this.source.getBoundingClientRect();
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    window.addEventListener("touchmove", this.onTouch, { passive: true });
    this.element.classList.add("phantom-loupe-live");
    this.loop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("pointermove", this.onPointer);
    window.removeEventListener("touchmove", this.onTouch);
    this.element.classList.remove("phantom-loupe-live");
    this.drawIdle();
  }

  destroy(): void {
    this.stop();
    this.element.remove();
  }

  private onPointer = (e: PointerEvent): void => {
    this.track(e.clientX, e.clientY);
  };

  private onTouch = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (t) this.track(t.clientX, t.clientY);
  };

  private track(clientX: number, clientY: number): void {
    if (!this.rect) return;
    const scaleX = this.source.width / this.rect.width;
    const scaleY = this.source.height / this.rect.height;
    const x = (clientX - this.rect.left) * scaleX;
    const y = (clientY - this.rect.top) * scaleY;
    this.inside =
      x >= 0 && y >= 0 && x < this.source.width && y < this.source.height;
    this.pos = [x, y];
  }

  private loop = (): void => {
    if (!this.running) return;
    this.render();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private drawIdle(): void {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "rgba(120,120,120,0.15)";
    ctx.fillRect(0, 0, size, size);
  }

  private render(): void {
    const { ctx, size, zoom, source } = this;

    if (!this.pos) {
      this.pos = [source.width / 2, source.height / 2];
      this.inside = true;
    }

    const win = Math.max(8, Math.round(size / zoom));
    const maxX = Math.max(0, source.width - win);
    const maxY = Math.max(0, source.height - win);
    const sx = Math.min(maxX, Math.max(0, Math.round(this.pos[0] - win / 2)));
    const sy = Math.min(maxY, Math.max(0, Math.round(this.pos[1] - win / 2)));

    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, sx, sy, win, win, 0, 0, size, size);

    const cxv = (this.pos[0] - sx) * (size / win);
    const cyv = (this.pos[1] - sy) * (size / win);
    const r = Math.max(9, size * 0.09);

    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.arc(cxv, cyv, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1.75;
    ctx.strokeStyle = RING;
    if (!this.inside) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cxv, cyv, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(cxv - r - 5, cyv);
    ctx.lineTo(cxv - r + 1, cyv);
    ctx.moveTo(cxv + r - 1, cyv);
    ctx.lineTo(cxv + r + 5, cyv);
    ctx.moveTo(cxv, cyv - r - 5);
    ctx.lineTo(cxv, cyv - r + 1);
    ctx.moveTo(cxv, cyv + r - 1);
    ctx.lineTo(cxv, cyv + r + 5);
    ctx.stroke();
    ctx.restore();

    this.label.textContent = this.inside
      ? `手指位置 ${Math.round(this.pos[0])}, ${Math.round(this.pos[1])}`
      : "手指已划出画布";
  }
}
