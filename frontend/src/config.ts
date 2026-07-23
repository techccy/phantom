// 全局配置。视觉/渲染参数通过 Vite 构建时 env 注入（VITE_*），改值需重 build 前端镜像。
//
// 画布尺寸必须与后端 PHANTOM_CANVAS_* 保持一致（后端按它生成路径，前端按它渲染）。
// PC / 移动端分别配置（docs/issue3.md §2/§4）：手机窄屏 + 大拇指接触面需要更紧凑的
// 画布与更大的目标方块，故拆出 PC / Mobile 两套，由 isMobileViewport() 在挂载时选用。

/** 从 import.meta.env 取值并做类型/NaN 容错，非法或缺失时回退默认值。 */
function envNum(key: string, fallback: number): number {
  const raw = import.meta.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 判定当前视口是否为移动端（触屏 + 窄屏）。
 *
 * 触屏 coarse pointer（手指/大拇指）或视口短边 ≤480px 任一命中即视为移动端，
 * 与 issue3.md §4 "大拇指接触面积 10–15mm" 场景对齐。 */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  const coarse =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const narrow =
    Math.min(window.innerWidth, window.innerHeight) <= 480;
  return coarse || narrow;
}

export const CONFIG = {
  // 后端地址；开发态走 Vite 代理 /api，生产可设 VITE_API_BASE
  apiBase: import.meta.env.VITE_API_BASE ?? "/api",

  // 画布尺寸：PC / 移动端分别配置（docs/issue3.md §2/§4）。
  // - PC 默认 480×480，与后端 PHANTOM_CANVAS_W_PC/H_PC 单一来源；
  // - Mobile 默认 360×360（窄屏友好），与后端 PHANTOM_CANVAS_W_MOBILE/H_MOBILE 一致。
  // 旧字段 canvasWidth/canvasHeight 保留为 PC 别名，向后兼容。
  canvasWidthPC: envNum("VITE_CANVAS_W_PC", 480),
  canvasHeightPC: envNum("VITE_CANVAS_H_PC", 480),
  canvasWidthMobile: envNum("VITE_CANVAS_W_MOBILE", 360),
  canvasHeightMobile: envNum("VITE_CANVAS_H_MOBILE", 360),

  // 兼容旧引用的别名（= PC 默认）。新代码请用 canvasWidthPC/HeightPC。
  get canvasWidth(): number {
    return this.canvasWidthPC;
  },
  get canvasHeight(): number {
    return this.canvasHeightPC;
  },

  // 渲染参数（动态显影"雪花"簇）：越大越密/越亮，过大易被密度分析抠图
  particleDensity: envNum("VITE_PARTICLE_DENSITY", 0.6),       // 目标方块每像素铺多少亮粒子
  particleDropRate: envNum("VITE_PARTICLE_DROP_RATE", 0.05),   // 反密度分析：每帧随机丢弃比例
  // 目标簇亮度增益（0~1）：0 = 粒子灰度与背景【同分布】，机器逐帧密度分析失效，
  // 人眼仅靠"共同命运"位移整合看见方块；>0 额外提亮（便于调试/增强显影）。
  // ⚠️ 仅作用于动态渲染（renderFrame），不影响预热脉冲的呼吸提亮（仍按固定呼吸显影）。
  particleTargetGain: envNum("VITE_PARTICLE_TARGET_GAIN", 0),
  // 旧亮度旋钮（保留向后兼容，新逻辑不再读取——被 particleTargetGain 取代）
  particleBrightness: envNum("VITE_PARTICLE_BRIGHTNESS", 0.55), // 目标簇亮度基值（0~1）
  particleBrightnessVar: envNum("VITE_PARTICLE_BRIGHTNESS_VAR", 0.45), // 亮度随机闪烁幅度

  // 预热脉冲时长（秒）：按住按钮后，方块先在起点原地显影这段时间再出发，
  // 方便用户熟悉方块位置。通过 VITE_PREVIEW_SECONDS 注入，改后需重新 build 前端。
  previewSeconds: envNum("VITE_PREVIEW_SECONDS", 2),
};

