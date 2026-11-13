/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* 可调参数 */

function envNum(key: string, fallback: number): number {
  const raw = import.meta.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  const coarse =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const narrow =
    Math.min(window.innerWidth, window.innerHeight) <= 480;
  return coarse || narrow;
}

const TUNE_KEY = "phantom.tune";

export interface Tunables {
  targetGain: number | null;
  density: number | null;
  dropRate: number | null;
  previewSeconds: number | null;
  targetHalf: number | null;
  duration: number | null;
  loupe: number | null;
  loupeZoom: number | null;
  loupeSize: number | null;
  pad: number | null;
}

const EMPTY_TUNE: Tunables = {
  targetGain: null,
  density: null,
  dropRate: null,
  previewSeconds: null,
  targetHalf: null,
  duration: null,
  loupe: null,
  loupeZoom: null,
  loupeSize: null,
  pad: null,
};

function loadTune(): Tunables {
  if (typeof localStorage === "undefined") return { ...EMPTY_TUNE };
  try {
    const raw = localStorage.getItem(TUNE_KEY);
    if (!raw) return { ...EMPTY_TUNE };
    const parsed = JSON.parse(raw) as Partial<Tunables>;
    const out = { ...EMPTY_TUNE };
    for (const k of Object.keys(EMPTY_TUNE) as (keyof Tunables)[]) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return { ...EMPTY_TUNE };
  }
}

export const TUNE: Tunables = loadTune();

export function saveTune(): void {
  try {
    localStorage.setItem(TUNE_KEY, JSON.stringify(TUNE));
  } catch {
  }
}

export function resetTune(): void {
  Object.assign(TUNE, EMPTY_TUNE);
  try {
    localStorage.removeItem(TUNE_KEY);
  } catch {
  }
}

export const CONFIG = {
  apiBase: import.meta.env.VITE_API_BASE ?? "/api",

  canvasWidthPC: envNum("VITE_CANVAS_W_PC", 480),
  canvasHeightPC: envNum("VITE_CANVAS_H_PC", 480),
  canvasWidthMobile: envNum("VITE_CANVAS_W_MOBILE", 360),
  canvasHeightMobile: envNum("VITE_CANVAS_H_MOBILE", 360),

  get canvasWidth(): number {
    return this.canvasWidthPC;
  },
  get canvasHeight(): number {
    return this.canvasHeightPC;
  },

  particleDensity: envNum("VITE_PARTICLE_DENSITY", 0.6),
  particleDropRate: envNum("VITE_PARTICLE_DROP_RATE", 0.05),
  particleTargetGain: envNum("VITE_PARTICLE_TARGET_GAIN", 0),
  particleBrightness: envNum("VITE_PARTICLE_BRIGHTNESS", 0.55),
  particleBrightnessVar: envNum("VITE_PARTICLE_BRIGHTNESS_VAR", 0.45),

  previewSeconds: envNum("VITE_PREVIEW_SECONDS", 2),

  loupeSize: envNum("VITE_LOUPE_SIZE", 160),
  loupeZoom: envNum("VITE_LOUPE_ZOOM", 1.6),
};

export function effTargetGain(): number {
  return TUNE.targetGain ?? CONFIG.particleTargetGain;
}
export function effDensity(): number {
  return TUNE.density ?? CONFIG.particleDensity;
}
export function effDropRate(): number {
  return TUNE.dropRate ?? CONFIG.particleDropRate;
}
export function effPreviewSeconds(): number {
  return TUNE.previewSeconds ?? CONFIG.previewSeconds;
}
export function effPadEnabled(): boolean {
  return TUNE.pad === null ? isMobileViewport() : TUNE.pad >= 0.5;
}
export function effLoupeEnabled(): boolean {
  if (TUNE.loupe !== null) return TUNE.loupe >= 0.5;
  return isMobileViewport() && !effPadEnabled();
}
export function effLoupeZoom(): number {
  return TUNE.loupeZoom ?? CONFIG.loupeZoom;
}
export function effLoupeSize(): number {
  return TUNE.loupeSize ?? CONFIG.loupeSize;
}

export const BUILD_DEFAULTS = {
  targetGain: CONFIG.particleTargetGain,
  density: CONFIG.particleDensity,
  dropRate: CONFIG.particleDropRate,
  previewSeconds: CONFIG.previewSeconds,
  loupeZoom: CONFIG.loupeZoom,
  loupeSize: CONFIG.loupeSize,
};
