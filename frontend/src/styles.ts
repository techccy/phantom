// Widget 注入式样式：mount() 时把 <style> 注入宿主页面，并提供 dark/light 主题。
// 所有类名加 `.phantom-` 前缀以防与宿主页面 CSS 冲突。
//
// 按钮设计参考 docs/按钮设计.md：去除实色背景，改为 Cyber Dark / Glassmorphism
// 磨砂玻璃风格，并实现 Idle/Hover/Holding/Success/Fail 多状态微交互。

export type Theme = "dark" | "light";

let injected = false;
const STYLE_ID = "phantom-widget-style";

/** 幂等注入全局样式表。多次 mount 只注入一次。 */
export function injectStyles(): void {
  if (injected) return;
  if (document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.phantom-widget {
  /* 主题变量（dark 默认） */
  --ph-bg: #0a0a0a;
  --ph-fg: #eee;
  --ph-border: #333;
  --ph-radius: 12px;

  /* 遮罩变量 */
  --ph-overlay-bg: rgba(10, 10, 10, 0.82);
  --ph-overlay-fg: rgba(241, 245, 249, 0.92);

  /* 按钮变量 */
  --ph-btn-bg: rgba(15, 23, 42, 0.65);
  --ph-btn-border: rgba(255, 255, 255, 0.15);
  --ph-btn-fg: rgba(241, 245, 249, 0.9);
  --ph-accent: rgba(56, 189, 248, 1);
  --ph-accent-soft: rgba(56, 189, 248, 0.5);
  --ph-success: rgba(16, 185, 129, 0.8);
  --ph-danger: rgba(239, 68, 68, 0.8);
  /* 进度条充能时长，由 JS 按后端下发的 duration 注入 */
  --ph-charge-duration: 3s;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: var(--ph-radius);
  width: max-content;
}
/* light 主题覆盖变量 */
.phantom-widget[data-theme="light"] {
  --ph-bg: #f5f5f5;
  --ph-fg: #111;
  --ph-border: #ddd;

  --ph-overlay-bg: rgba(245, 245, 245, 0.86);
  --ph-overlay-fg: rgba(17, 17, 17, 0.92);

  --ph-btn-bg: rgba(255, 255, 255, 0.55);
  --ph-btn-border: rgba(15, 23, 42, 0.12);
  --ph-btn-fg: rgba(15, 23, 42, 0.85);
}

/* ---------- 画布 + 玩法遮罩 ---------- */
.phantom-widget .phantom-stage-wrap {
  position: relative;
  line-height: 0; /* 消除 inline canvas 的底部空隙 */
}
.phantom-widget canvas.phantom-stage {
  border: 1px solid var(--ph-border);
  image-rendering: pixelated;
  background: var(--ph-bg);
  touch-action: none;
  display: block;
}
.phantom-widget .phantom-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  background: var(--ph-overlay-bg);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  transition: opacity 0.15s ease;
}
.phantom-widget .phantom-overlay.phantom-hidden {
  display: none;
}
.phantom-widget .phantom-overlay-text {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.8;
  text-align: center;
  letter-spacing: 0.04em;
  color: var(--ph-overlay-fg);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}

/* ---------- 按钮：Glassmorphism + 多状态 ---------- */
.phantom-widget button.phantom-activate {
  position: relative;
  overflow: hidden;
  width: 220px;
  height: 56px;
  border: 1px solid var(--ph-btn-border);
  border-radius: var(--ph-radius);
  background: var(--ph-btn-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--ph-btn-fg);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  cursor: grab;
  user-select: none;
  touch-action: none;
  /* 呼吸灯与状态过渡共用 transition，时长足够短以免影响轨迹帧率 */
  transition: transform 0.12s ease, border-color 0.3s ease, box-shadow 0.3s ease,
    background 0.2s ease;
  animation: phantom-pulse 2s ease-in-out infinite;
}
@keyframes phantom-pulse {
  0%, 100% { box-shadow: 0 0 0 rgba(56, 189, 248, 0); }
  50% { box-shadow: 0 0 8px rgba(56, 189, 248, 0.25); }
}
.phantom-widget button.phantom-activate:hover:not(:disabled):not(.phantom-retry) {
  border-color: var(--ph-accent-soft);
  transform: translateY(-1px);
}
.phantom-widget button.phantom-activate:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  animation: none;
}
.phantom-widget button.phantom-activate:focus-visible {
  outline: 2px solid var(--ph-accent-soft);
  outline-offset: 2px;
}

/* Holding：按下瞬间充能 + 进度条跑动 */
.phantom-widget button.phantom-activate.phantom-holding {
  cursor: grabbing;
  transform: scale(0.98);
  border-color: var(--ph-accent-soft);
  box-shadow: 0 0 20px rgba(56, 189, 248, 0.35);
  animation: none;
}
/* 进度条：绝对贴底，动画 0 → 100%，linear。每次加 .phantom-holding 重新播放，
   松手移除 class 时动画随之取消，宽度瞬间归零，避免重试时的回退动画残影。 */
.phantom-widget button.phantom-activate .phantom-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  width: 0;
  background: linear-gradient(90deg, var(--ph-accent-soft), var(--ph-accent));
  box-shadow: 0 0 6px var(--ph-accent-soft);
  pointer-events: none;
}
.phantom-widget button.phantom-activate.phantom-holding .phantom-progress {
  animation: phantom-charge var(--ph-charge-duration) linear forwards;
}
@keyframes phantom-charge {
  from { width: 0; }
  to { width: 100%; }
}

/* Success：翡翠绿 + 微放大 */
.phantom-widget button.phantom-activate.phantom-success {
  border-color: var(--ph-success);
  box-shadow: 0 0 20px rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.18);
  animation: phantom-pop 0.3s ease;
}
@keyframes phantom-pop {
  0% { transform: scale(0.98); }
  60% { transform: scale(1.03); }
  100% { transform: scale(1); }
}

/* Fail：警示红 + 水平震动 */
.phantom-widget button.phantom-activate.phantom-fail {
  border-color: var(--ph-danger);
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.18);
  animation: phantom-shake 0.2s ease;
}
@keyframes phantom-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(3px); }
}

/* Retry：点击刷新重试 */
.phantom-widget button.phantom-activate.phantom-retry {
  background: rgba(100, 116, 139, 0.4);
  border-color: rgba(148, 163, 184, 0.5);
  cursor: pointer;
  animation: none;
}
.phantom-widget button.phantom-activate.phantom-retry:hover {
  filter: brightness(1.15);
}

/* ---------- 文本提示（仅 loading / 初始化失败） ---------- */
.phantom-widget .phantom-status {
  font-size: 14px;
  color: var(--ph-fg);
  min-height: 20px;
}
`.trim();
  document.head.appendChild(style);
  injected = true;
}
