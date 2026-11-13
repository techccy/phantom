/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* 轨迹采集 */

import { mapSurfaceToCanvas } from "./surface";

export type Sample = [number, number, number];

export class TrajectoryTracker {
  private samples: Sample[] = [];
  private active = false;
  private rect: DOMRect | null = null;
  private touchActive = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private surface: HTMLElement = canvas,
  ) {}

  start(): void {
    this.active = true;
    this.samples = [];
    this.touchActive = false;
    this.rect = this.surface.getBoundingClientRect();
    this.bind();
  }

  private mapToCanvas(clientX: number, clientY: number): [number, number] {
    if (!this.rect) return [clientX, clientY];
    return mapSurfaceToCanvas(
      clientX,
      clientY,
      this.rect,
      this.canvas.width,
      this.canvas.height,
    );
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.active || !this.rect) return;
    if (this.touchActive) return;
    const [x, y] = this.mapToCanvas(e.clientX, e.clientY);
    this.samples.push([x, y, performance.now()]);
  };

  private onTouchStart = (e: TouchEvent): void => {
    if (!this.active) return;
    this.touchActive = true;
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    if (!touch || !this.rect) return;
    const [x, y] = this.mapToCanvas(touch.clientX, touch.clientY);
    this.samples.push([x, y, performance.now()]);
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (!this.active || !this.rect) return;
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    if (!touch) return;
    const [x, y] = this.mapToCanvas(touch.clientX, touch.clientY);
    this.samples.push([x, y, performance.now()]);
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.active) return;
    if (e.cancelable) e.preventDefault();
    this.touchActive = false;
  };

  private bind(): void {
    window.addEventListener("pointermove", this.onMove, { passive: true });
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
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cleaned = this.samples.filter(
      ([x, y, t]) =>
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(t) &&
        x >= 0 && y >= 0 && x < W && y < H,
    );
    return cleaned;
  }

  get lastPointT(): number {
    return this.samples.length
      ? this.samples[this.samples.length - 1][2]
      : 0;
  }
}
