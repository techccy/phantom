import { defineConfig } from "vite";
import obfuscatorPlugin from "vite-plugin-javascript-obfuscator";

// 生产构建启用高强度混淆：控制流平坦化 + 反调试 + 字符串数组 + 标识符重命名
// （PRD §四：高强度代码防逆向）。开发态关闭以保留可读性与 source map。
export default defineConfig(({ mode }) => ({
  server: {
    proxy: {
      // 开发态把 /api 转发到后端 uvicorn（默认 8000）
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  plugins:
    mode === "production"
      ? [
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
        ]
      : [],
  build: {
    target: "es2020",
    sourcemap: false,
  },
}));
