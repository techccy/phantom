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

# Vite 构建时从 import.meta.env 读 VITE_*；ARG → ENV 导出供 build 注入。
#
# ⚠️ 单一来源对齐：画布尺寸 PC/Mobile 分化的 ARG 名（VITE_CANVAS_*_PC/MOBILE）必须与
# config.ts 里 envNum("VITE_CANVAS_*_PC/MOBILE") 读取的名字【逐字一致】并在此声明。
# Docker 会静默丢弃 Dockerfile 未声明的 --build-arg（仅打印一条 warning）——历史上此处
# 只声明了旧名 VITE_CANVAS_W/H，导致 .env 改了 PHANTOM_CANVAS_*_PC/MOBILE 后
# compose 透传的 VITE_CANVAS_*_PC/MOBILE 全部被丢，前端永远回退默认 480/360，
# 与后端按新尺寸算出的贝塞尔/DTW 归一化坐标系错位 → S_DTW 崩塌 → 验证恒失败。
# docker-compose.yml 从 .env 的 PHANTOM_CANVAS_*_PC/MOBILE 喂入保持前后端单一来源。
ARG VITE_API_BASE=""
ARG VITE_CANVAS_W=480
ARG VITE_CANVAS_H=480
ARG VITE_CANVAS_W_PC=480
ARG VITE_CANVAS_H_PC=480
ARG VITE_CANVAS_W_MOBILE=360
ARG VITE_CANVAS_H_MOBILE=360
ARG VITE_PARTICLE_DENSITY=0.6
ARG VITE_PARTICLE_DROP_RATE=0.05
ARG VITE_PARTICLE_BRIGHTNESS=0.55
ARG VITE_PARTICLE_BRIGHTNESS_VAR=0.45
ARG VITE_PREVIEW_SECONDS=2
ENV VITE_API_BASE=${VITE_API_BASE} \
    VITE_CANVAS_W=${VITE_CANVAS_W} \
    VITE_CANVAS_H=${VITE_CANVAS_H} \
    VITE_CANVAS_W_PC=${VITE_CANVAS_W_PC} \
    VITE_CANVAS_H_PC=${VITE_CANVAS_H_PC} \
    VITE_CANVAS_W_MOBILE=${VITE_CANVAS_W_MOBILE} \
    VITE_CANVAS_H_MOBILE=${VITE_CANVAS_H_MOBILE} \
    VITE_PARTICLE_DENSITY=${VITE_PARTICLE_DENSITY} \
    VITE_PARTICLE_DROP_RATE=${VITE_PARTICLE_DROP_RATE} \
    VITE_PARTICLE_BRIGHTNESS=${VITE_PARTICLE_BRIGHTNESS} \
    VITE_PARTICLE_BRIGHTNESS_VAR=${VITE_PARTICLE_BRIGHTNESS_VAR} \
    VITE_PREVIEW_SECONDS=${VITE_PREVIEW_SECONDS}

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
