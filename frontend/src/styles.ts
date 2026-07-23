// Widget 注入式样式：mount() 时把 <style> 注入宿主页面，并提供 dark/light 主题。
// 所有类名加 `.phantom-` 前缀以防与宿主页面 CSS 冲突。
//
// 接入形态仿 Cloudflare Turnstile / reCAPTCHA v2：
//   - 表单内只留紧凑复选框长条（.phantom-bar），几乎不占空间
//   - 点击复选框弹出居中模态（.phantom-modal），主体（画布+按住按钮）在模态内
//   - 验证成功后模态消失，复选框变为已验证态
//
// 视觉风格复刻 design-os（docs/ui-design/design-os）：暖中性 stone 调 + lime-500 强调，
// DM Sans / IBM Plex Mono 字体。参见 index.html 设计 token。

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
/* ===== design-os 设计 token（light 默认 / dark 覆盖） =====
   暖中性 stone 色阶 + lime-500 强调。所有颜色与 design-os src/index.css 对齐。
   ⚠️ token 必须同时挂在 .phantom-widget 与 .phantom-modal 上：模态被插入到
   document.body 末尾（脱离 .phantom-widget 子树），自定义属性只沿 DOM 树继承，
   若只在 .phantom-widget 上声明，模态卡片 / 遮罩 / 画布底色全部解析为空 → 透明，
   导致文字与按钮直接浮在原网页上（issue：弹窗无背景）。 */
.phantom-widget,
.phantom-modal,
.phantom-modal[data-theme="light"] {
  /* —— 通用 token —— */
  --ph-radius: 0.5rem;
  --ph-radius-sm: 4px;        /* calc(--radius - 4px) */
  --ph-radius-md: 6px;        /* calc(--radius - 2px) */
  --ph-radius-lg: 8px;        /* = --radius */
  --ph-radius-xl: 12px;       /* calc(--radius + 4px) */
  --ph-radius-full: 999px;

  --ph-font-display: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ph-font-body: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ph-font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;

  /* —— Light：Warm Stone palette —— */
  --ph-bg: oklch(0.985 0.001 106.424);          /* stone-50  #FAFAF9 */
  --ph-fg: oklch(0.216 0.006 56.043);           /* stone-900 #1C1917 */
  --ph-card: oklch(1 0 0);                      /* white */
  --ph-card-fg: oklch(0.216 0.006 56.043);
  --ph-muted: oklch(0.970 0.001 106.424);       /* stone-100 */
  --ph-muted-fg: oklch(0.444 0.011 73.639);     /* stone-600 #57534E */
  --ph-subtle-fg: oklch(0.553 0.013 58.071);    /* stone-500 */
  --ph-border: oklch(0.923 0.003 48.717);       /* stone-200 #E7E5E4 */
  --ph-border-subtle: oklch(0.970 0.001 106.424); /* stone-100 */
  --ph-primary: oklch(0.216 0.006 56.043);      /* stone-900 */
  --ph-primary-fg: oklch(0.985 0.001 106.424);  /* stone-50 */
  --ph-accent: oklch(0.532 0.157 131.589);      /* lime-600 (light 下更深保证对比) */
  --ph-accent-soft: color-mix(in oklch, var(--ph-accent) 22%, transparent);

  --ph-overlay-bg: rgba(0, 0, 0, 0.5);          /* design-os Dialog: bg-black/50 */
  --ph-shadow-sm: 0 1px 2px 0 rgba(28, 25, 23, 0.05);
  --ph-shadow-lg: 0 10px 15px -3px rgba(28, 25, 23, 0.1), 0 4px 6px -4px rgba(28, 25, 23, 0.05);

  /* —— 画布相关 —— */
  --ph-canvas-bg: oklch(0.216 0.006 56.043);    /* stone-900 噪点底 */
  --ph-canvas-border: var(--ph-border);

  /* —— 进度条充能时长，由 JS 按后端下发的 duration 注入 —— */
  --ph-charge-duration: 3s;

  font-family: var(--ph-font-body);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
/* dark 主题覆盖 token（模态同样在 body 末尾，需单独匹配 data-theme="dark"） */
.phantom-widget[data-theme="dark"],
.phantom-modal[data-theme="dark"] {
  --ph-bg: oklch(0.216 0.006 56.043);           /* stone-900 #1C1917 */
  --ph-fg: oklch(0.985 0.001 106.424);          /* stone-50 */
  --ph-card: oklch(0.268 0.007 34.298);         /* stone-800 #292524 */
  --ph-card-fg: oklch(0.985 0.001 106.424);
  --ph-muted: oklch(0.318 0.008 43.185);        /* stone-700 */
  --ph-muted-fg: oklch(0.709 0.01 56.259);      /* stone-400 #A8A29E */
  --ph-subtle-fg: oklch(0.553 0.013 58.071);    /* stone-500 */
  --ph-border: oklch(0.370 0.010 67.558);       /* stone-600 */
  --ph-border-subtle: oklch(0.318 0.008 43.185);/* stone-700 */
  --ph-primary: oklch(0.923 0.003 48.717);      /* stone-200 */
  --ph-primary-fg: oklch(0.216 0.006 56.043);   /* stone-900 */
  --ph-accent: oklch(0.648 0.2 131.684);        /* lime-500 */
  --ph-accent-soft: color-mix(in oklch, var(--ph-accent) 22%, transparent);

  --ph-overlay-bg: rgba(0, 0, 0, 0.6);
  --ph-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ph-shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
}

/* 让容器本身自适应宽度（紧凑框宽度由内容决定） */
.phantom-widget {
  display: block;
  width: max-content;
  max-width: 100%;
  color: var(--ph-fg);
}

/* ============================================================
   紧凑复选框长条（表单内常驻，仿 Turnstile/reCAPTCHA v2）
   data-state: idle / verifying / verified / error
   ============================================================ */
.phantom-widget .phantom-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 300px;
  max-width: 100%;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-radius-lg);
  background: var(--ph-card);
  box-shadow: var(--ph-shadow-sm);
  color: var(--ph-card-fg);
  cursor: pointer;
  user-select: none;
  transition: border-color 200ms ease, box-shadow 200ms ease, background 200ms ease;
}
.phantom-widget .phantom-bar:hover {
  border-color: color-mix(in oklch, var(--ph-accent) 45%, var(--ph-border));
}
.phantom-widget .phantom-bar:focus-visible {
  outline: none;
  border-color: var(--ph-subtle-fg);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ph-subtle-fg) 50%, transparent);
}
/* verifying：紧凑框微弱 loading 描边 */
.phantom-widget .phantom-bar[data-state="verifying"] {
  cursor: default;
  border-color: color-mix(in oklch, var(--ph-accent) 50%, var(--ph-border));
}
/* verified：lime 强调描边 */
.phantom-widget .phantom-bar[data-state="verified"] {
  border-color: var(--ph-accent);
  cursor: default;
}
/* error：红色描边 + 轻微震动 */
.phantom-widget .phantom-bar[data-state="error"] {
  border-color: var(--ph-danger, oklch(0.586 0.253 17.585));
  animation: phantom-bar-shake 0.2s ease;
}
@keyframes phantom-bar-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  75% { transform: translateX(3px); }
}

/* 复选框（左） */
.phantom-widget .phantom-check {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: 2px solid var(--ph-border);
  border-radius: var(--ph-radius-sm);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  transition: border-color 200ms ease, background 200ms ease, color 200ms ease;
}
.phantom-widget .phantom-bar[data-state="idle"]:hover .phantom-check {
  border-color: var(--ph-accent);
}
/* verifying：旋转的 lime 圆点 spinner */
.phantom-widget .phantom-bar[data-state="verifying"] .phantom-check {
  border: 2px solid transparent;
  border-top-color: var(--ph-accent);
  border-radius: var(--ph-radius-full);
  animation: phantom-spin 0.7s linear infinite;
}
@keyframes phantom-spin {
  to { transform: rotate(360deg); }
}
/* verified：lime 实心 + 白色对勾 */
.phantom-widget .phantom-bar[data-state="verified"] .phantom-check {
  border-color: var(--ph-accent);
  background: var(--ph-accent);
  color: oklch(0.985 0.001 106.424);
}
.phantom-widget .phantom-check svg {
  width: 14px;
  height: 14px;
}
/* error：红色实心 + 感叹号 */
.phantom-widget .phantom-bar[data-state="error"] .phantom-check {
  border-color: var(--ph-danger, oklch(0.586 0.253 17.585));
  background: var(--ph-danger, oklch(0.586 0.253 17.585));
  color: #fff;
}

/* 中间文案 */
.phantom-widget .phantom-bar-text {
  flex: 1 1 auto;
  font-family: var(--ph-font-body);
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--ph-card-fg);
}
.phantom-widget .phantom-bar[data-state="verified"] .phantom-bar-text {
  color: var(--ph-fg);
}

/* 右侧 logo + 版权区 */
.phantom-widget .phantom-bar-brand {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  line-height: 1;
}
.phantom-widget .phantom-bar-logo {
  width: 18px;
  height: 18px;
  color: var(--ph-subtle-fg);
}
.phantom-widget .phantom-bar[data-state="verified"] .phantom-bar-logo {
  color: var(--ph-accent);
}
.phantom-widget .phantom-bar-copyright {
  font-family: var(--ph-font-mono);
  font-size: 9px;
  letter-spacing: 0.02em;
  color: var(--ph-subtle-fg);
  white-space: nowrap;
  opacity: 0.85;
}
.phantom-widget .phantom-bar-copyright a {
  color: inherit;
  text-decoration: none;
}
.phantom-widget .phantom-bar-copyright a:hover {
  text-decoration: underline;
  color: var(--ph-accent);
}

/* ============================================================
   居中模态弹窗（document.body 末尾，验证主体容器）
   ============================================================ */
.phantom-modal {
  position: fixed;
  inset: 0;
  z-index: 2147483000; /* 高于绝大多数宿主元素 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  box-sizing: border-box;
  font-family: var(--ph-font-body);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--ph-fg);
  /* 遮罩层 */
  background: var(--ph-overlay-bg);
  animation: phantom-modal-fade-in 200ms ease-out;
}
@keyframes phantom-modal-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.phantom-modal.phantom-leaving {
  animation: phantom-modal-fade-out 150ms ease-in forwards;
  pointer-events: none;
}
@keyframes phantom-modal-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

.phantom-modal-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: max-content;
  max-width: calc(100% - 2rem);
  padding: 1.5rem;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-radius-lg);
  background: var(--ph-card);
  color: var(--ph-card-fg);
  box-shadow: var(--ph-shadow-lg);
  animation: phantom-modal-pop-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes phantom-modal-pop-in {
  from { opacity: 0; transform: scale(0.96) translateY(4px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
.phantom-modal.phantom-leaving .phantom-modal-card {
  animation: phantom-modal-pop-out 150ms ease-in forwards;
}
@keyframes phantom-modal-pop-out {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.97); }
}

/* 模态头部：logo + 标题 + 关闭按钮 */
.phantom-modal-head {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}
.phantom-modal-logo {
  width: 22px;
  height: 22px;
  color: var(--ph-accent);
  flex: 0 0 auto;
}
.phantom-modal-title {
  flex: 1 1 auto;
  font-family: var(--ph-font-display);
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ph-fg);
}
.phantom-modal-close {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--ph-radius-md);
  background: transparent;
  color: var(--ph-subtle-fg);
  cursor: pointer;
  transition: color 150ms ease, background 150ms ease;
}
.phantom-modal-close:hover {
  color: var(--ph-fg);
  background: var(--ph-muted);
}
.phantom-modal-close svg {
  width: 16px;
  height: 16px;
}
.phantom-modal-close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ph-subtle-fg) 50%, transparent);
}

/* 模态主体（画布 + 提示 + 按住按钮） */
.phantom-modal-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

/* ============================================================
   阶段提示框（画布上方常规流，非覆盖画布）
   参考 design-os 的 eyebrow：带柔光状态点 + 阶段文案，随状态机切换。
   data-stage 控制：loading / ready / preview / collect / stopped / done
   ============================================================ */
.phantom-modal .phantom-hint {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-radius-md);
  background: var(--ph-muted);
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--ph-muted-fg);
  transition: border-color 200ms ease;
}
.phantom-modal .phantom-hint::before {
  content: "";
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: var(--ph-radius-full);
  background: var(--ph-accent);
  box-shadow: 0 0 0 3px var(--ph-accent-soft);
  transition: background 200ms ease, box-shadow 200ms ease;
}
/* loading / 空文案：不画状态点 */
.phantom-modal .phantom-hint:empty::before,
.phantom-modal .phantom-hint[data-stage="loading"]::before {
  display: none;
}
/* 预热阶段：状态点呼吸（呼应方块呼吸显影） */
.phantom-modal .phantom-hint[data-stage="preview"]::before {
  animation: phantom-hint-pulse 1s ease-in-out infinite;
}
@keyframes phantom-hint-pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--ph-accent-soft); }
  50% { box-shadow: 0 0 0 6px var(--ph-accent-soft); }
}
/* 停止移动阶段：状态点转 lime，提示"该松手了" */
.phantom-modal .phantom-hint[data-stage="stopped"]::before {
  background: var(--ph-accent);
  box-shadow: 0 0 0 3px var(--ph-accent-soft);
}

/* ---------- 画布 + 玩法遮罩 ---------- */
.phantom-modal .phantom-stage-wrap {
  position: relative;
  line-height: 0; /* 消除 inline canvas 的底部空隙 */
}
.phantom-modal canvas.phantom-stage {
  border: 1px solid var(--ph-canvas-border);
  border-radius: var(--ph-radius-md);
  image-rendering: pixelated;
  background: var(--ph-canvas-bg);
  touch-action: none;
  display: block;
  /* 响应式：窄屏按宽度等比缩放（tracker 按比例映射，安全） */
  max-width: 100%;
  height: auto;
}
.phantom-modal .phantom-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  box-sizing: border-box;
  background: var(--ph-overlay-bg);
  border-radius: var(--ph-radius-md);
  transition: opacity 150ms ease;
}
.phantom-modal .phantom-overlay.phantom-hidden {
  display: none;
}
.phantom-modal .phantom-overlay-text {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.7;
  text-align: center;
  letter-spacing: 0.02em;
  color: oklch(0.985 0.001 106.424);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
.phantom-modal[data-theme="light"] .phantom-overlay-text {
  color: rgba(255, 255, 255, 0.95);
}

/* ============================================================
   按住按钮：design-os 配色 + 多状态微交互
   （保持原有充能进度条 / 成功 / 失败 / 重试 / 震动 / 呼吸逻辑）
   ============================================================ */
.phantom-modal button.phantom-activate {
  position: relative;
  overflow: hidden;
  width: 100%;
  max-width: 360px;
  height: 52px;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-radius-md);
  background: var(--ph-primary);
  color: var(--ph-primary-fg);
  font-family: var(--ph-font-body);
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.005em;
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: transform 0.12s ease, border-color 0.3s ease, box-shadow 0.3s ease,
    background 0.2s ease;
  animation: phantom-pulse 2.4s ease-in-out infinite;
}
@keyframes phantom-pulse {
  0%, 100% { box-shadow: 0 0 0 transparent; }
  50% { box-shadow: 0 0 0 3px var(--ph-accent-soft); }
}
.phantom-modal button.phantom-activate:hover:not(:disabled):not(.phantom-retry) {
  transform: translateY(-1px);
  box-shadow: 0 0 0 3px var(--ph-accent-soft);
}
.phantom-modal button.phantom-activate:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  animation: none;
}
.phantom-modal button.phantom-activate:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ph-subtle-fg) 50%, transparent);
}

/* Holding：按下瞬间充能 + 进度条跑动 */
.phantom-modal button.phantom-activate.phantom-holding {
  cursor: grabbing;
  transform: scale(0.98);
  box-shadow: 0 0 0 3px var(--ph-accent), 0 0 16px var(--ph-accent-soft);
  animation: none;
}
/* 进度条：绝对贴底，动画 0 → 100%，linear。每次加 .phantom-holding 重新播放，
   松手移除 class 时动画随之取消，宽度瞬间归零，避免重试时的回退动画残影。 */
.phantom-modal button.phantom-activate .phantom-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  width: 0;
  background: var(--ph-accent);
  box-shadow: 0 0 6px var(--ph-accent-soft);
  pointer-events: none;
}
.phantom-modal button.phantom-activate.phantom-holding .phantom-progress {
  animation: phantom-charge var(--ph-charge-duration) linear forwards;
}
@keyframes phantom-charge {
  from { width: 0; }
  to { width: 100%; }
}

/* Success：lime 绿 + 微放大 */
.phantom-modal button.phantom-activate.phantom-success {
  border-color: var(--ph-accent);
  background: var(--ph-accent);
  color: oklch(0.985 0.001 106.424);
  box-shadow: 0 0 0 3px var(--ph-accent-soft);
  animation: phantom-pop 0.3s ease;
}
@keyframes phantom-pop {
  0% { transform: scale(0.98); }
  60% { transform: scale(1.03); }
  100% { transform: scale(1); }
}

/* Fail：红色 + 水平震动 */
.phantom-modal button.phantom-activate.phantom-fail {
  border-color: var(--ph-danger, oklch(0.586 0.253 17.585));
  background: var(--ph-danger, oklch(0.586 0.253 17.585));
  color: #fff;
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
.phantom-modal button.phantom-activate.phantom-retry {
  background: var(--ph-muted);
  border-color: var(--ph-border);
  color: var(--ph-fg);
  cursor: pointer;
  animation: none;
}
.phantom-modal button.phantom-activate.phantom-retry:hover {
  filter: brightness(1.04);
}

/* ---------- 文本提示（仅 loading / 初始化失败） ---------- */
.phantom-modal .phantom-status {
  font-size: 0.8rem;
  color: var(--ph-muted-fg);
  min-height: 1.2rem;
  text-align: center;
}
`.trim();
  document.head.appendChild(style);
  injected = true;
}
