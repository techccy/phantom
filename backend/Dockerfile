# Phantom 后端镜像。
# 多阶段构建：builder 装依赖并编译 scipy wheel，runtime 仅拷贝产物，缩小镜像。

# ---------- builder ----------
FROM python:3.12-slim AS builder
WORKDIR /build

# 编译 scipy 需要的构建工具（gcc/gfortran/BLAS 头）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc gfortran libopenblas-dev liblapack-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app

# 安装到独立 prefix，便于只拷贝 site-packages
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --prefix=/install .

# ---------- runtime ----------
FROM python:3.12-slim AS runtime

# runtime 仍需 openblas 运行时库（scipy 依赖）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopenblas0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

WORKDIR /app
COPY app ./app
COPY pyproject.toml ./

EXPOSE 8000

# 生产用 gunicorn + uvicorn worker，更稳健；单机多 worker 时务必注入
# 稳定的 PHANTOM_TOKEN_SECRET（否则 token 跨 worker 不可校验）。
CMD ["gunicorn", "app.main:app", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "-w", "1", \
     "-b", "0.0.0.0:8000", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
