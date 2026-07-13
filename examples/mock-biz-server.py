"""模拟接入方业务后端 —— 演示 token 核销的完整闭环。

这个脚本扮演【接入 Phantom 的第三方】角色：
  - 浏览器里的 Phantom widget 验证通过后拿到 token；
  - 浏览器把 token 发到【本】业务后端（POST /demo/login）；
  - 本后端调用 Phantom 的 /consume-token 核销，核销成功才放行业务（如登录）。

运行：
    # 先确保 Phantom 后端已起在 http://localhost:8000
    pip install fastapi uvicorn httpx
    python examples/mock-biz-server.py
    # 然后浏览器打开 http://localhost:8088/  （页面会引用本地 dist/phantom.js）

这是接入文档 docs/integration.md §完整接入示例 的活样本，刻意保持极简。
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

# Phantom 后端地址（即你要接入的目标）
PHANTOM_BACKEND = os.environ.get("PHANTOM_BACKEND", "http://localhost:8000")
# 本 demo 页静态资源目录（指向已构建的 frontend/dist）
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

app = FastAPI(title="Phantom 模拟业务后端")


class LoginRequest(BaseModel):
    username: str
    phantomToken: str


@app.post("/demo/login")
async def login(req: LoginRequest):
    """接入方业务接口：先核销 Phantom token，再放行业务。"""
    # 1) 调用 Phantom 后端核销 token（一票一用）
    async with httpx.AsyncClient(timeout=5) as client:
        try:
            r = await client.post(
                f"{PHANTOM_BACKEND}/consume-token",
                json={"token": req.phantomToken},
            )
            consume = r.json()
        except Exception as e:
            return JSONResponse(
                {"ok": False, "reason": f"phantom 后端不可达: {e}"}, status_code=502
            )

    # 2) token 无效/已被核销 → 拒绝业务
    if not consume.get("valid"):
        return {"ok": False, "reason": "人机验证未通过或 token 已失效"}

    # 3) token 有效 → 这里写你自己的业务逻辑（查库、发 session 等）
    #    demo 里直接放行
    return {"ok": True, "message": f"欢迎 {req.username}，登录成功（token 已核销）"}


@app.get("/", response_class=HTMLResponse)
async def index():
    """返回 demo.html（模拟第三方网站接入页）。"""
    demo = FRONTEND_DIST / "demo.html"
    if not demo.exists():
        return HTMLResponse(
            "<h3>demo.html 未找到，请先在 frontend/ 下运行 <code>npm run build</code> 与 "
            "<code>npm run build:sdk</code></h3>",
            status_code=404,
        )
    return HTMLResponse(demo.read_text(encoding="utf-8"))


@app.get("/phantom.js")
async def sdk_bundle():
    """提供本地构建的 phantom.js，供 demo.html 的 &lt;script&gt; 引用。"""
    js = FRONTEND_DIST / "phantom.js"
    if not js.exists():
        return HTMLResponse("phantom.js 未构建", status_code=404)
    return HTMLResponse(
        js.read_text(encoding="utf-8"),
        media_type="application/javascript",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8088)
