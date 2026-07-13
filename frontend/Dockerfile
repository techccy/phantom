# Phantom 前端镜像：node 构建 → nginx 托管。
# 产出 index.html（官方 demo）+ demo.html（接入示例）+ phantom.js（SDK 包）+ /api 反代。

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json vite.config.ts vite.sdk.config.ts ./
COPY index.html ./
COPY public ./public
COPY src ./src

# 同时构建 app 与 SDK（与 npm run build 一致）
RUN npm run build

# ---------- runtime ----------
FROM nginx:alpine AS runtime

# 拷贝构建产物
COPY --from=builder /build/dist /usr/share/nginx/html
# 拷贝 nginx 配置（含 /api 反代到 backend:8000）
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
