/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* 触控板控制区 */

import { mapSurfaceToCanvas } from "./surface";

export class PadCursor {
  readonly element: HTMLDivElement;
  private rect: DOMRect | null = null;
  private running = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private surface: HTMLElement,
  ) {
    this.element = document.createElement("div");
    this.element.className = "phantom-cursor phantom-hidden";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rect = this.surface.getBoundingClientRect();
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    window.addEventListener("touchmove", this.onTouch, { passive: true });
    this.element.classList.remove("phantom-hidden");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener("pointermove", this.onPointer);
    window.removeEventListener("touchmove", this.onTouch);
    this.element.classList.add("phantom-hidden");
  }

  destroy(): void {
    this.stop();
    this.element.remove();
  }

  place(clientX: number, clientY: number): void {
    if (!this.rect) this.rect = this.surface.getBoundingClientRect();
    this.move(clientX, clientY);
  }

  private onPointer = (e: PointerEvent): void => {
    this.move(e.clientX, e.clientY);
  };

  private onTouch = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (t) this.move(t.clientX, t.clientY);
  };

  private move(clientX: number, clientY: number): void {
    if (!this.rect || !this.running) return;
    const [x, y] = mapSurfaceToCanvas(
      clientX,
      clientY,
      this.rect,
      this.canvas.width,
      this.canvas.height,
    );
    this.element.style.left = `${(x / this.canvas.width) * 100}%`;
    this.element.style.top = `${(y / this.canvas.height) * 100}%`;
  }
}
