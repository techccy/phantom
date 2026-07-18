// 官方 Demo 页入口：用 Phantom.mount() 驱动 frontend/index.html。
//
// 这里展示【浏览器侧】的最简用法：mount + onSuccess/onFail 回调拿到 token。
// 注意：本 demo 仅在前端打印 token，不演示后端核销——后端核销的完整闭环见
// demo.html + examples/mock-biz-server.py（接入文档的核心示例）。

import { mount } from "./phantom";
import { consumeToken } from "./api";
import type { VerifyResult } from "./api";

const apiBase = import.meta.env.VITE_API_BASE ?? "/api";

/* ============================================================
   主题：三态（light / dark / system），复刻 design-os ThemeToggle
   - localStorage['theme'] 持久化，默认 'system'
   - 在 <html> 上切换 .dark class，页面 CSS token 联动
   - system 模式下监听 prefers-color-scheme
   - widget 自带 data-theme，切换后重新 mount 让它跟随
   ============================================================ */
type ThemeMode = "light" | "dark" | "system";
const THEME_KEY = "theme";
const CYCLE: ThemeMode[] = ["light", "dark", "system"];

const prefersDark = (): boolean =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

function storedTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/** theme mode 实际渲染出来的明暗（widget 只认 dark/light）。 */
function resolvedTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? (prefersDark() ? "dark" : "light") : mode;
}

function applyTheme(mode: ThemeMode): void {
  const dark = resolvedTheme(mode) === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

/* ---------- ThemeToggle 图标（内联 SVG，跟页面风格统一） ---------- */
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

/* ---------- widget 挂载（带 handle，便于主题切换时重建） ---------- */
let handle: ReturnType<typeof mount> | null = null;

function mountWidget(mode: ThemeMode): void {
  handle?.destroy();
  handle = mount("#app", {
    apiBase,
    theme: resolvedTheme(mode),
    onSuccess: async (r: VerifyResult) => {
      console.log("✅ 验证通过，token =", r.token, "score =", r.score.toFixed(2));
      // ⚠️ 注意：浏览器侧【不应】核销 token。这里仅为了在 demo 里演示核销接口可用，
      //    真实接入请把 token 发给你的后端，由后端调用 /consume-token。
      if (r.token) {
        const consume = await consumeToken(apiBase, r.token);
        console.log("（仅 demo 演示）token 核销:", consume.valid);
      }
    },
    onFail: (r: VerifyResult) => {
      console.log("❌ 验证未通过，detail =", r.detail);
    },
    onError: (e: Error) => {
      console.error("Phantom 异常:", e);
    },
  });
}

/* ---------- 初始化 + 绑定切换 ---------- */
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
    mountWidget(next); // 让 widget 跟随新主题
  });

  // system 模式下，跟随操作系统明暗变化
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (storedTheme() === "system") {
        applyTheme("system");
        mountWidget("system");
      }
    });
}

/* ---------- 启动 ---------- */
initTheme();
mountWidget(storedTheme());
