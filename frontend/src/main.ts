/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* 演示页入口 */

import { mount } from "./phantom";
import { consumeToken } from "./api";
import type { VerifyResult } from "./api";
import { BUILD_DEFAULTS, TUNE, resetTune, saveTune, type Tunables } from "./config";

const apiBase = import.meta.env.VITE_API_BASE ?? "/api";

type ThemeMode = "light" | "dark" | "system";
const THEME_KEY = "theme";
const CYCLE: ThemeMode[] = ["light", "dark", "system"];

const prefersDark = (): boolean =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

function storedTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function resolvedTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? (prefersDark() ? "dark" : "light") : mode;
}

function applyTheme(mode: ThemeMode): void {
  const dark = resolvedTheme(mode) === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

const ICONS = {
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`,
  system: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
};

function renderToggleIcon(mode: ThemeMode): void {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.innerHTML = ICONS[mode];
  const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length];
  btn.title = `主题：${mode}（点击切换到 ${next}）`;
}

let handle: ReturnType<typeof mount> | null = null;

function mountWidget(mode: ThemeMode): void {
  handle?.destroy();
  handle = mount("#app", {
    apiBase,
    theme: resolvedTheme(mode),
    antidebug: false,
    onChallenge: (info) => {
      const s = info.server;
      const e = info.effective;
      const mark = (label: string, srv: number, eff: number): string =>
        srv === eff ? `${label}=${srv}` : `${label}=${eff}（服务端 ${srv}）`;
      setServerInfo(
        `服务端下发：画布 ${s.canvas[0]}×${s.canvas[1]} · ` +
          `${mark("方块半边长", s.targetHalf, e.targetHalf)} · ` +
          `${mark("时长", s.duration, e.duration)}s`,
      );
    },
    onSuccess: async (r: VerifyResult) => {
      console.log("✅ 验证通过，token =", r.token, "score =", r.score.toFixed(2));
      logResult(r);
      if (r.token) {
        const consume = await consumeToken(apiBase, r.token);
        console.log("（仅 demo 演示）token 核销:", consume.valid);
      }
    },
    onFail: (r: VerifyResult) => {
      console.log("❌ 验证未通过，detail =", r.detail);
      logResult(r);
    },
    onError: (e: Error) => {
      console.error("Phantom 异常:", e);
    },
  });
}

interface TuneSpec {
  key: keyof Tunables;
  name: string;
  note: string;
  min: number;
  max: number;
  step: number;
  siteDefault: number | null;
  nullLabel?: string;
  upstream: number | string;
  fallback: number;
  fmt?: (v: number) => string;
}

const VISUAL_SPECS: TuneSpec[] = [
  {
    key: "targetGain",
    name: "目标亮度增益",
    note: "0 = 与背景同灰度，只能靠运动认出来（上游本意，最难）；1 = 纯白方块",
    min: 0,
    max: 1,
    step: 0.05,
    siteDefault: BUILD_DEFAULTS.targetGain,
    upstream: 0,
    fallback: BUILD_DEFAULTS.targetGain,
  },
  {
    key: "density",
    name: "粒子密度",
    note: "方块里每像素铺多少亮粒子，越大方块越实",
    min: 0.2,
    max: 1.5,
    step: 0.05,
    siteDefault: BUILD_DEFAULTS.density,
    upstream: 0.6,
    fallback: BUILD_DEFAULTS.density,
  },
  {
    key: "dropRate",
    name: "每帧丢弃率",
    note: "反密度分析用：每帧随机扔掉这个比例的粒子，越大越闪",
    min: 0,
    max: 0.3,
    step: 0.01,
    siteDefault: BUILD_DEFAULTS.dropRate,
    upstream: 0.05,
    fallback: BUILD_DEFAULTS.dropRate,
  },
  {
    key: "previewSeconds",
    name: "预热显影秒数",
    note: "按住后方块先在起点呼吸这么久再出发，用来找位置",
    min: 0,
    max: 6,
    step: 0.5,
    siteDefault: BUILD_DEFAULTS.previewSeconds,
    upstream: 2,
    fallback: BUILD_DEFAULTS.previewSeconds,
    fmt: (v) => `${v}s`,
  },
];

const CHALLENGE_SPECS: TuneSpec[] = [
  {
    key: "targetHalf",
    name: "方块半边长",
    note: "只改观感：后端评分不吃这个值。默认跟随服务端下发",
    min: 12,
    max: 64,
    step: 2,
    siteDefault: null,
    upstream: "22 (PC)",
    fallback: 32,
    fmt: (v) => `${v}px`,
  },
  {
    key: "duration",
    name: "移动时长",
    note: "方块走完整条路径的时间，越长越好跟。同样不参与评分",
    min: 3,
    max: 15,
    step: 0.5,
    siteDefault: null,
    upstream: 6,
    fallback: 7.5,
    fmt: (v) => `${v}s`,
  },
];

const AUX_SPECS: TuneSpec[] = [
  {
    key: "pad",
    name: "触控板模式",
    note: "画布只看不摸，手指在画布【下方】的控制区里操作，光标环等比映射进画布。默认手机开",
    min: 0,
    max: 1,
    step: 1,
    siteDefault: null,
    nullLabel: "自动（手机开）",
    upstream: "无此功能",
    fallback: 1,
    fmt: (v) => (v >= 0.5 ? "开" : "关"),
  },
  {
    key: "loupe",
    name: "手指放大镜",
    note: "画布上方开窗显示手指周围 + 手指位置。开了触控板就用不上了（手指本来就不挡画布），自动模式下会关掉",
    min: 0,
    max: 1,
    step: 1,
    siteDefault: null,
    nullLabel: "自动（手机开）",
    upstream: "无此功能",
    fallback: 1,
    fmt: (v) => (v >= 0.5 ? "开" : "关"),
  },
  {
    key: "loupeSize",
    name: "放大镜大小",
    note: "窗口本身多大（屏幕像素）。调大 = 看到的范围更大，但占的竖向空间也更多",
    min: 90,
    max: 240,
    step: 10,
    siteDefault: BUILD_DEFAULTS.loupeSize,
    upstream: "无此功能",
    fallback: BUILD_DEFAULTS.loupeSize,
    fmt: (v) => `${v}px`,
  },
  {
    key: "loupeZoom",
    name: "放大倍率",
    note: "倍率越高看得越清，但视野越窄、越容易跟丢。想看更宽的范围就降它",
    min: 1,
    max: 4,
    step: 0.1,
    siteDefault: BUILD_DEFAULTS.loupeZoom,
    upstream: "无此功能",
    fallback: BUILD_DEFAULTS.loupeZoom,
    fmt: (v) => `${v.toFixed(1)}×`,
  },
];

function loupeFieldOfView(): number {
  const size = TUNE.loupeSize ?? BUILD_DEFAULTS.loupeSize;
  const zoom = TUNE.loupeZoom ?? BUILD_DEFAULTS.loupeZoom;
  return Math.round(size / zoom);
}

function paintFovHint(): void {
  const el = document.getElementById("tune-fov");
  if (!el) return;
  const fov = loupeFieldOfView();
  el.textContent = `当前提示范围：${fov}×${fov} 画布像素（目标方块边长 64px）`;
}

function setServerInfo(text: string): void {
  const el = document.getElementById("tune-server");
  if (el) el.textContent = text;
}

function applyTuneChange(): void {
  saveTune();
  mountWidget(storedTheme());
}

function buildRow(spec: TuneSpec): HTMLElement {
  const row = document.createElement("div");
  row.className = "tune-row";

  const label = document.createElement("label");
  label.className = "tune-name";
  label.textContent = spec.name;
  const note = document.createElement("span");
  note.className = "tune-note";
  note.textContent = spec.note;
  label.appendChild(note);

  const range = document.createElement("input");
  range.type = "range";
  range.min = String(spec.min);
  range.max = String(spec.max);
  range.step = String(spec.step);
  range.value = String(TUNE[spec.key] ?? spec.fallback);

  const val = document.createElement("span");
  val.className = "tune-val";

  const revert = document.createElement("button");
  revert.type = "button";
  revert.className = "tune-revert";
  revert.textContent = "↺";
  revert.title =
    spec.siteDefault === null ? "回到跟随服务端" : "回到本站默认值";

  const fmt = spec.fmt ?? ((v: number) => String(v));
  const paint = (): void => {
    const cur = TUNE[spec.key];
    if (cur === null) {
      val.dataset.following = "1";
      val.textContent =
        spec.siteDefault === null
          ? spec.nullLabel ?? "跟随服务端"
          : `${fmt(spec.siteDefault)} 默认`;
      range.value = String(spec.siteDefault ?? spec.fallback);
    } else {
      val.dataset.following = "0";
      val.textContent = fmt(cur);
      range.value = String(cur);
    }
    label.title = `上游默认 ${spec.upstream}`;
  };

  range.addEventListener("input", () => {
    TUNE[spec.key] = Number(range.value);
    val.dataset.following = "0";
    val.textContent = fmt(Number(range.value));
    paintFovHint();
  });
  range.addEventListener("change", () => {
    TUNE[spec.key] = Number(range.value);
    applyTuneChange();
    paint();
  });
  revert.addEventListener("click", () => {
    TUNE[spec.key] = null;
    applyTuneChange();
    paint();
  });

  paint();
  row.append(label, range, val, revert);
  return row;
}

let repaintPanel: () => void = () => {};

function initTunePanel(): void {
  const visual = document.getElementById("tune-visual");
  const challenge = document.getElementById("tune-challenge");
  const aux = document.getElementById("tune-aux");
  if (!visual || !challenge || !aux) return;

  repaintPanel = () => {
    visual.innerHTML = "";
    challenge.innerHTML = "";
    aux.innerHTML = "";
    for (const s of VISUAL_SPECS) visual.appendChild(buildRow(s));
    for (const s of CHALLENGE_SPECS) challenge.appendChild(buildRow(s));
    for (const s of AUX_SPECS) aux.appendChild(buildRow(s));
    paintFovHint();
  };
  repaintPanel();

  document
    .getElementById("tune-reset-verify")
    ?.addEventListener("click", () => {
      handle?.reset();
      setServerInfo("已重置验证状态，点「我不是机器人」重新验证");
    });

  document
    .getElementById("tune-restore-site")
    ?.addEventListener("click", () => {
      resetTune();
      applyTuneChange();
      repaintPanel();
    });

  document
    .getElementById("tune-restore-upstream")
    ?.addEventListener("click", () => {
      TUNE.targetGain = 0;
      TUNE.density = 0.6;
      TUNE.dropRate = 0.05;
      TUNE.previewSeconds = 2;
      TUNE.targetHalf = 22;
      TUNE.duration = 6;
      TUNE.loupe = 0;
      TUNE.loupeZoom = null;
      TUNE.loupeSize = null;
      TUNE.pad = 0;
      applyTuneChange();
      repaintPanel();
    });
}

const logEntries: string[] = [];

function logResult(r: VerifyResult): void {
  const box = document.getElementById("tune-log");
  if (!box) return;
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const num = (k: string): string => {
    const v = d[k];
    return typeof v === "number" ? v.toFixed(2) : "—";
  };
  const vetoes = Object.keys(d)
    .filter((k) => k.endsWith("_veto") && d[k] === true)
    .map((k) => k.replace(/_veto$/, ""));
  const reason = typeof d.reason === "string" ? ` reason=${d.reason}` : "";

  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const cls = r.passed ? "pass" : "fail";
  const html =
    `<div class="tune-entry"><span>${time}</span>` +
    `<b class="${cls}">${r.passed ? "通过" : "未通过"}</b>` +
    `<span><b>${r.score.toFixed(3)}</b>` +
    `<span class="sub"> · S_DTW ${num("s_dtw")} · S_Bio ${num("s_bio")}` +
    (vetoes.length ? ` · 否决 ${vetoes.join(",")}` : "") +
    `${reason}</span></span></div>`;

  logEntries.unshift(html);
  if (logEntries.length > 30) logEntries.pop();
  box.innerHTML = logEntries.join("");
}

function initTheme(): void {
  const mode = storedTheme();
  applyTheme(mode);
  renderToggleIcon(mode);

  const btn = document.getElementById("theme-toggle");
  btn?.addEventListener("click", () => {
    const cur = storedTheme();
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    renderToggleIcon(next);
    mountWidget(next);
  });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (storedTheme() === "system") {
        applyTheme("system");
        mountWidget("system");
      }
    });
}

initTheme();
mountWidget(storedTheme());
initTunePanel();
