/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 基于 techccy/phantom（MPL-2.0）修改。说明见 NOTICE.md。
 */

/* widget 样式 */

export type Theme = "dark" | "light";

let injected = false;
const STYLE_ID = "phantom-widget-style";

export function injectStyles(): void {
  if (injected) return;
  if (document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.phantom-widget,
.phantom-modal,
.phantom-modal[data-theme="light"] {
  --ph-radius: 0.5rem;
  --ph-radius-sm: 4px;
  --ph-radius-md: 6px;
  --ph-radius-lg: 8px;
  --ph-radius-xl: 12px;
  --ph-radius-full: 999px;

  --ph-font-display: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ph-font-body: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ph-font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --ph-bg: oklch(0.985 0.001 106.424);
  --ph-fg: oklch(0.216 0.006 56.043);
  --ph-card: oklch(1 0 0);
  --ph-card-fg: oklch(0.216 0.006 56.043);
  --ph-muted: oklch(0.970 0.001 106.424);
  --ph-muted-fg: oklch(0.444 0.011 73.639);
  --ph-subtle-fg: oklch(0.553 0.013 58.071);
  --ph-border: oklch(0.923 0.003 48.717);
  --ph-border-subtle: oklch(0.970 0.001 106.424);
  --ph-primary: oklch(0.216 0.006 56.043);
  --ph-primary-fg: oklch(0.985 0.001 106.424);
  --ph-accent: oklch(0.532 0.157 131.589);
  --ph-accent-soft: color-mix(in oklch, var(--ph-accent) 22%, transparent);

  --ph-overlay-bg: rgba(0, 0, 0, 0.5);
  --ph-shadow-sm: 0 1px 2px 0 rgba(28, 25, 23, 0.05);
  --ph-shadow-lg: 0 10px 15px -3px rgba(28, 25, 23, 0.1), 0 4px 6px -4px rgba(28, 25, 23, 0.05);

  --ph-canvas-bg: oklch(0.216 0.006 56.043);
  --ph-canvas-border: var(--ph-border);

  --ph-charge-duration: 3s;

  font-family: var(--ph-font-body);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.phantom-widget[data-theme="dark"],
.phantom-modal[data-theme="dark"] {
  --ph-bg: oklch(0.216 0.006 56.043);
  --ph-fg: oklch(0.985 0.001 106.424);
  --ph-card: oklch(0.268 0.007 34.298);
  --ph-card-fg: oklch(0.985 0.001 106.424);
  --ph-muted: oklch(0.318 0.008 43.185);
  --ph-muted-fg: oklch(0.709 0.01 56.259);
  --ph-subtle-fg: oklch(0.553 0.013 58.071);
  --ph-border: oklch(0.370 0.010 67.558);
  --ph-border-subtle: oklch(0.318 0.008 43.185);
  --ph-primary: oklch(0.923 0.003 48.717);
  --ph-primary-fg: oklch(0.216 0.006 56.043);
  --ph-accent: oklch(0.648 0.2 131.684);
  --ph-accent-soft: color-mix(in oklch, var(--ph-accent) 22%, transparent);

  --ph-overlay-bg: rgba(0, 0, 0, 0.6);
  --ph-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ph-shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
}

.phantom-widget {
  display: block;
  width: max-content;
  max-width: 100%;
  color: var(--ph-fg);
}

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
.phantom-widget .phantom-bar[data-state="verifying"] {
  cursor: default;
  border-color: color-mix(in oklch, var(--ph-accent) 50%, var(--ph-border));
}
.phantom-widget .phantom-bar[data-state="verified"] {
  border-color: var(--ph-accent);
  cursor: default;
}
.phantom-widget .phantom-bar[data-state="error"] {
  border-color: var(--ph-danger, oklch(0.586 0.253 17.585));
  animation: phantom-bar-shake 0.2s ease;
}
@keyframes phantom-bar-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  75% { transform: translateX(3px); }
}

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
.phantom-widget .phantom-bar[data-state="verifying"] .phantom-check {
  border: 2px solid transparent;
  border-top-color: var(--ph-accent);
  border-radius: var(--ph-radius-full);
  animation: phantom-spin 0.7s linear infinite;
}
@keyframes phantom-spin {
  to { transform: rotate(360deg); }
}
.phantom-widget .phantom-bar[data-state="verified"] .phantom-check {
  border-color: var(--ph-accent);
  background: var(--ph-accent);
  color: oklch(0.985 0.001 106.424);
}
.phantom-widget .phantom-check svg {
  width: 14px;
  height: 14px;
}
.phantom-widget .phantom-bar[data-state="error"] .phantom-check {
  border-color: var(--ph-danger, oklch(0.586 0.253 17.585));
  background: var(--ph-danger, oklch(0.586 0.253 17.585));
  color: #fff;
}

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

.phantom-modal {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  box-sizing: border-box;
  font-family: var(--ph-font-body);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--ph-fg);
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
  --ph-chrome-h: 270px;
  max-height: calc(100% - 1rem);
  overflow-y: auto;
  padding: 1.5rem;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-radius-lg);
  background: var(--ph-card);
  color: var(--ph-card-fg);
  box-shadow: var(--ph-shadow-lg);
  animation: phantom-modal-pop-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
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

.phantom-modal-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.phantom-modal .phantom-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  border: 1px solid var(--ph-border);
  border-radius: var(--ph-radius-md);
  background: var(--ph-muted);
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.005em;
  line-height: 1.3;
  text-align: center;
  color: var(--ph-fg);
  transition: border-color 200ms ease;
}
.phantom-modal .phantom-hint::before {
  content: "";
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--ph-radius-full);
  background: var(--ph-accent);
  box-shadow: 0 0 0 4px var(--ph-accent-soft);
  transition: background 200ms ease, box-shadow 200ms ease;
}
.phantom-modal .phantom-hint:empty::before,
.phantom-modal .phantom-hint[data-stage="loading"]::before {
  display: none;
}
.phantom-modal .phantom-hint[data-stage="preview"]::before {
  animation: phantom-hint-pulse 1s ease-in-out infinite;
}
@keyframes phantom-hint-pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--ph-accent-soft); }
  50% { box-shadow: 0 0 0 6px var(--ph-accent-soft); }
}
.phantom-modal .phantom-hint[data-stage="stopped"]::before {
  background: var(--ph-accent);
  box-shadow: 0 0 0 3px var(--ph-accent-soft);
}

.phantom-modal .phantom-loupe {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  opacity: 0.45;
  transition: opacity 150ms ease;
}
.phantom-modal .phantom-loupe-live {
  opacity: 1;
}
.phantom-modal-card.phantom-has-loupe {
  --ph-chrome-h: 460px;
}
.phantom-modal-card.phantom-has-pad {
  --ph-chrome-h: calc(34vh + 210px);
}
.phantom-modal .phantom-loupe-view {
  display: block;
  border: 1px solid var(--ph-canvas-border);
  border-radius: var(--ph-radius-md);
  background: var(--ph-canvas-bg);
  image-rendering: pixelated;
  box-shadow: var(--ph-shadow-sm);
}
.phantom-modal .phantom-loupe-live .phantom-loupe-view {
  border-color: var(--ph-accent);
}
.phantom-modal .phantom-loupe-label {
  font-family: var(--ph-font-mono);
  font-size: 0.7rem;
  color: var(--ph-subtle-fg);
  line-height: 1.2;
  text-align: center;
}

.phantom-modal .phantom-stage-wrap {
  position: relative;
  line-height: 0;
}
.phantom-modal canvas.phantom-stage {
  border: 1px solid var(--ph-canvas-border);
  border-radius: var(--ph-radius-md);
  image-rendering: pixelated;
  background: var(--ph-canvas-bg);
  touch-action: none;
  -webkit-user-select: none;
  display: block;
  max-width: 100%;
  max-height: calc(100vh - var(--ph-chrome-h, 270px));
  max-height: calc(100dvh - var(--ph-chrome-h, 270px));
  min-height: 200px;
  width: auto;
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
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
  transition: transform 0.12s ease, border-color 0.3s ease, box-shadow 0.3s ease,
    background 0.2s ease;
  animation: phantom-pulse 2.4s ease-in-out infinite;
}
@keyframes phantom-pulse {
  0%, 100% { box-shadow: 0 0 0 transparent; }
  50% { box-shadow: 0 0 0 3px var(--ph-accent-soft); }
}

.phantom-modal button.phantom-activate.phantom-pad {
  height: auto;
  aspect-ratio: 1 / 1;
  max-width: min(100%, 34vh);
  max-height: 34vh;
  border-radius: var(--ph-radius-lg);
  border: 1px dashed var(--ph-border);
  background: var(--ph-muted);
  color: var(--ph-muted-fg);
  font-size: 0.85rem;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 0.75rem;
  box-sizing: border-box;
  animation: none;
  background-image:
    linear-gradient(to right, var(--ph-border-subtle) 1px, transparent 1px),
    linear-gradient(to bottom, var(--ph-border-subtle) 1px, transparent 1px);
  background-size: 12.5% 12.5%;
}
.phantom-modal button.phantom-activate.phantom-pad:disabled {
  opacity: 0.5;
}
.phantom-modal button.phantom-activate.phantom-pad.phantom-holding {
  border-style: solid;
  border-color: var(--ph-accent);
  background-color: var(--ph-card);
}
.phantom-modal button.phantom-activate.phantom-pad.phantom-success,
.phantom-modal button.phantom-activate.phantom-pad.phantom-fail,
.phantom-modal button.phantom-activate.phantom-pad.phantom-retry {
  border-style: solid;
  background-image: none;
  align-items: center;
  padding-bottom: 0;
}

.phantom-modal .phantom-cursor {
  position: absolute;
  width: 30px;
  height: 30px;
  margin: -15px 0 0 -15px;
  border-radius: 50%;
  border: 2px solid var(--ph-accent);
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  transition: opacity 120ms ease;
  will-change: left, top;
}
.phantom-modal .phantom-cursor::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 3px;
  height: 3px;
  margin: -1.5px 0 0 -1.5px;
  border-radius: 50%;
  background: var(--ph-accent);
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

.phantom-modal button.phantom-activate.phantom-holding {
  cursor: grabbing;
  transform: scale(0.98);
  box-shadow: 0 0 0 3px var(--ph-accent), 0 0 16px var(--ph-accent-soft);
  animation: none;
}
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
