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

# Vite 构建时从 process.env 读 VITE_*；ARG → ENV 导出供 build 注入。
# 画布尺寸默认取与后端一致的 480，docker-compose 会从 PHANTOM_CANVAS_W/H 喂入保持单一来源。
ARG VITE_API_BASE=""
ARG VITE_CANVAS_W=480
ARG VITE_CANVAS_H=480
ARG VITE_PARTICLE_DENSITY=0.6
ARG VITE_PARTICLE_DROP_RATE=0.05
ARG VITE_PARTICLE_BRIGHTNESS=0.55
ARG VITE_PARTICLE_BRIGHTNESS_VAR=0.45
ENV VITE_API_BASE=${VITE_API_BASE} \
    VITE_CANVAS_W=${VITE_CANVAS_W} \
    VITE_CANVAS_H=${VITE_CANVAS_H} \
    VITE_PARTICLE_DENSITY=${VITE_PARTICLE_DENSITY} \
    VITE_PARTICLE_DROP_RATE=${VITE_PARTICLE_DROP_RATE} \
    VITE_PARTICLE_BRIGHTNESS=${VITE_PARTICLE_BRIGHTNESS} \
    VITE_PARTICLE_BRIGHTNESS_VAR=${VITE_PARTICLE_BRIGHTNESS_VAR}

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
