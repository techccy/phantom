// 官方 Demo 页入口：用 Phantom.mount() 驱动 frontend/index.html。
//
// 这里展示【浏览器侧】的最简用法：mount + onSuccess/onFail 回调拿到 token。
// 注意：本 demo 仅在前端打印 token，不演示后端核销——后端核销的完整闭环见
// demo.html + examples/mock-biz-server.py（接入文档的核心示例）。

import { mount } from "./phantom";
import { consumeToken } from "./api";
import type { VerifyResult } from "./api";

const apiBase = import.meta.env.VITE_API_BASE ?? "/api";

mount("#app", {
  apiBase,
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
