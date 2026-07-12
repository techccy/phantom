// 全局配置。API base 通过 Vite 代理或环境变量注入。
export const CONFIG = {
  // 后端地址；开发态走 Vite 代理 /api，生产可设 VITE_API_BASE
  apiBase: import.meta.env.VITE_API_BASE ?? "/api",
  canvasWidth: 480,
  canvasHeight: 480,
  challengeDurationMs: 3000,
  targetFps: 60,
  // 渲染参数
  noiseDensity: 0.55, // 画布噪点覆盖率
  particleSize: 1.5,
};
