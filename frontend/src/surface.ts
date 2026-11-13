/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* 坐标换算 */

export function mapSurfaceToCanvas(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  canvasW: number,
  canvasH: number,
): [number, number] {
  const scaleX = rect.width > 0 ? canvasW / rect.width : 1;
  const scaleY = rect.height > 0 ? canvasH / rect.height : 1;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  return [
    Math.max(0, Math.min(canvasW - 1, x)),
    Math.max(0, Math.min(canvasH - 1, y)),
  ];
}
