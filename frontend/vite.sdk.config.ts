import { defineConfig } from "vite";
import obfuscatorPlugin from "vite-plugin-javascript-obfuscator";

// SDK 构建：把 src/phantom.ts 打成单个 IIFE 产物 dist/phantom.js，
// 全局变量名 Phantom，供第三方网站 <script src="phantom.js"></script> 接入。
// 生产构建继承高强度混淆（控制流平坦化 + 反调试 + 字符串数组）。

export default defineConfig({
  plugins: [
    obfuscatorPlugin({
      include: ["src/**/*.ts"],
      exclude: [/node_modules/],
      apply: "build",
      options: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        debugProtection: true,
        debugProtectionInterval: 2000,
        disableConsoleOutput: true,
        identifierNamesGenerator: "hexadecimal",
        renameGlobals: false,
        selfDefending: true,
        stringArray: true,
        stringArrayEncoding: ["base64"],
        stringArrayThreshold: 0.75,
        transformObjectKeys: true,
        unicodeEscapeSequence: false,
      },
    }),
  ],
  build: {
    target: "es2020",
    sourcemap: false,
    // 不清空 outDir —— 与 app 构建共用 dist/，app 先构建，sdk 再追加 phantom.js
    emptyOutDir: false,
    lib: {
      entry: "src/phantom.ts",
      name: "Phantom",
      formats: ["iife"],
      fileName: () => "phantom.js",
    },
    rollupOptions: {
      output: {
        // 单文件 IIFE，不拆 chunk
        inlineDynamicImports: true,
        // phantom.ts 同时有命名导出与默认导出；IIFE 场景接入方用
        // window.Phantom.mount，故强制 named，避免 default 误用警告
        exports: "named",
      },
    },
  },
});
