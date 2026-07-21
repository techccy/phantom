// 全局配置。视觉/渲染参数通过 Vite 构建时 env 注入（VITE_*），改值需重 build 前端镜像。
// 画布尺寸必须与后端 PHANTOM_CANVAS_W/H 保持一致（后端按它生成路径，前端按它渲染）。

/** 从 import.meta.env 取值并做类型/NaN 容错，非法或缺失时回退默认值。 */
function envNum(key: string, fallback: number): number {
  const raw = import.meta.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  // 后端地址；开发态走 Vite 代理 /api，生产可设 VITE_API_BASE
  apiBase: import.meta.env.VITE_API_BASE ?? "/api",

  // 画布尺寸（与后端 PHANTOM_CANVAS_W/H 单一来源，docker-compose 从同一变量喂两边）
  canvasWidth: envNum("VITE_CANVAS_W", 480),
  canvasHeight: envNum("VITE_CANVAS_H", 480),

  // 渲染参数（动态显影"雪花"簇）：越大越密，过大易被密度分析抠图
  particleDensity: envNum("VITE_PARTICLE_DENSITY", 0.6),       // 目标方块簇粒子数 = 方块面积 × 此值
  particleDropRate: envNum("VITE_PARTICLE_DROP_RATE", 0.05),   // 反密度分析：每帧随机丢弃比例
  // 以下两项为历史兼容字段：单帧灰度泄露修复后（renderer.ts），目标簇亮度已与背景
  // 共用同一采样器（i.i.d. uniform[0,255]），不再读取这两项。保留是为不破坏已部署的
  // .env 配置；如需重新启用差异化亮度，请先评估 docs/issue.md §4 的泄露风险。
  particleBrightness: envNum("VITE_PARTICLE_BRIGHTNESS", 0.55), // （已停用）目标簇亮度基值（0~1）
  particleBrightnessVar: envNum("VITE_PARTICLE_BRIGHTNESS_VAR", 0.45), // （已停用）亮度随机闪烁幅度
};
