// Widget 注入式样式：mount() 时把 <style> 注入宿主页面，并提供 dark/light 主题。
// 所有类名加 `.phantom-` 前缀以防与宿主页面 CSS 冲突。

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
  --ph-bg: #0a0a0a;
  --ph-fg: #eee;
  --ph-border: #333;
  --ph-btn-bg: #3b82f6;
  --ph-btn-active-bg: #2563eb;
  --ph-radius: 12px;
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
}
.phantom-widget canvas.phantom-stage {
  border: 1px solid var(--ph-border);
  image-rendering: pixelated;
  background: var(--ph-bg);
  touch-action: none;
}
.phantom-widget button.phantom-activate {
  width: 200px;
  height: 56px;
  border: none;
  border-radius: var(--ph-radius);
  background: var(--ph-btn-bg);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  transition: background 0.1s;
}
.phantom-widget button.phantom-activate:active {
  background: var(--ph-btn-active-bg);
}
.phantom-widget button.phantom-activate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.phantom-widget .phantom-status {
  font-size: 14px;
  color: var(--ph-fg);
  min-height: 20px;
}
.phantom-widget .phantom-result {
  font-size: 15px;
  font-weight: 600;
  color: var(--ph-fg);
  min-height: 20px;
}
`.trim();
  document.head.appendChild(style);
  injected = true;
}
