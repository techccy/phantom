# Phantom - 新一代人机验证思路

### [ENGLISH VERSION >>>](README_EN.md)

> 本项目由广州初三生独立制作！

> 传统图形验证码易被 AI 识破，滑块曲线易被脚本模拟。Phantom 不拼"图形死记硬背"，只拼"你是不是真正拥有肉体和视网膜的人类"。

## 双重防线

### 1. 视觉防线 · 动态显影
验证码目标方块隐藏在满屏动态噪点中。**只有当粒子动态运动时**，人眼凭借"共同命运 (Common Fate)"与视网膜时间积分才能识别形状；任何**单帧截图**都只是一团无规律噪点，让逐帧分析的 CV/VLM 直接失效。

- 背景粒子每帧完全重随机（帧间不相关）→ 单帧纯高熵噪点
- 目标区域内粒子**每帧在方块内重随机位置**后施加**共同位移向量** → 相干运动显影，且区域内/外密度完全一致（无密度陷阱）
- 反密度分析：亮度随机闪烁，防像素密度抠图
- **静止即显形防护**：题目加载后画布仅显示静态噪点，**用户按住按钮才启动动态显影**；松手立即退化为纯噪点，保证静态截图无任何目标信息

### 2. 行为防线 · 生物节律
用户按住按钮跟随移动方块。系统**不看坐标精准度，只看轨迹的"人性"**：人类因神经传导延迟必然产生"滞后→跟进→偏离→修正"节律，伴随不可消除的微幅震颤与非线性加减速。机器轨迹"过于完美"，一票否决。

> 交互细节：按下按钮时方块从起点开始动态显影并采集轨迹；松手即停止移动（滑块停在原地、画面退化为纯噪点）并自动提交本次轨迹供评分。

## 核心判定

```
Composite = W_DTW · S_DTW + W_BIO · S_Bio              默认 0.6 / 0.4，阈值 0.8
S_Bio     = W_JERK·energy + W_ZC·zc + W_PSD·tremor      默认 0.4 / 0.3 / 0.3
```

> 上述权重、阈值、频段、能量/零交叉边界**全部可通过环境变量调整**（见下方「配置项」）。

- **S_DTW**：实际轨迹与后端下发贝塞尔路径的 DTW 距离（方向拟合度）
- **S_Bio**：在 4 阶双向巴特沃斯低通（截止 7Hz）后的**残差**上度量
  - 残差能量（人类 0.3–8px；完美机器 ≈0；粗糙机器 >20px）
  - 加速度零交叉频率（人类 3 秒 ≥5 次，钟形区间）
  - 8–12Hz 震颤幅度与功率占比
- **平滑否决**：残差能量 ≈0（过度平滑）→ `S_Bio=0.05`，Composite 封顶 **0.20**

## 安全设计

| 需求 | 实现 |
|---|---|
| 零前端信任 / 动态密钥 | 每次 ECDH P-256 临时会话密钥 + AES-256-GCM，无全局硬编码密钥 |
| 高强度防逆向 | `vite-plugin-javascript-obfuscator`：控制流平坦化 + debugProtection + 字符串数组 + 标识符重命名；运行时反调试死循环 |
| 严防时间差 | 服务端校验 `last_point_t` 距 now ≤ `MAX_DRIFT_SECONDS`（默认 3s，防离线慢算） |
| 一题一答 / 一票一用 | Redis `GETDEL` 原子弹出 challenge 与 token，无论成败即销毁 |

## 目录结构

```
phantom/
├── backend/                 # FastAPI + scipy + cryptography + redis
│   ├── app/
│   │   ├── main.py          # 路由 /challenge /verify /consume-token
│   │   ├── config.py        # 阈值/时效/TTL 集中配置
│   │   ├── crypto.py        # ECDH + HKDF + AES-GCM + token HMAC
│   │   ├── challenge.py     # 贝塞尔路径生成 + 参数加密下发
│   │   ├── store.py         # async redis GETDEL 封装
│   │   └── scoring/         # DSP 判定核心（dsp / dtw / engine）
│   ├── tests/               # 12 个单测全通过
│   └── .env.example
├── frontend/                # 原生 TS + Vite + Canvas2D
│   └── src/
│       ├── renderer.ts      # 动态显影（视觉防线核心）
│       ├── tracker.ts       # pointer 轨迹采集
│       ├── crypto.ts        # Web Crypto ECDH/AES-GCM
│       ├── api.ts           # /challenge /verify /consume-token
│       ├── antidebug.ts     # devtools 检测 → 死循环
│       ├── phantom.ts       # SDK 公共入口：Phantom.mount()
│       ├── styles.ts        # widget 注入式样式
│       └── main.ts          # 状态机编排（官方 demo 入口）
├── docker-compose.yml       # 全栈部署：Redis + 后端 + 前端
└── README.md
```

## 快速开始

### Docker一键部署

```docker compose up -d --build```

### 手动部署

### 1. 启动 Redis

```bash
docker compose up -d redis
# 或本机已装 redis-server 则直接运行
```

### 2. 启动后端

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env          # 按需修改
uvicorn app.main:app --reload --port 8000
```

健康检查：`curl http://localhost:8000/health` → `{"ok":true}`

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

浏览器访问 `http://localhost:5173`，**按住"按住跟随方块"按钮**（按住瞬间方块开始动态显影），用肉眼跟随移动方块移动约 5 秒后松开，即得到判定。

### 4. 生产构建（高强度混淆）

```bash
cd frontend && npm run build  # 产出 dist/，控制流平坦化 + 反调试
```

## 运行测试

```bash
cd backend && . .venv/bin/activate
pytest -v                     # 12 个测试：scoring / crypto / api 全链路
```

测试覆盖：
- **评分**：合成人类轨迹通过、完美机器被平滑否决（封顶 0.20）、粗糙噪声机器不通过、点数不足拒绝
- **密码学**：ECDH 双方派生一致、AES-GCM 往返与篡改检测、token 签发/校验
- **API**：全链路通过、一题一答（第二次 verify 返回 410）、3s 时效拦截、非法曲线拒绝、token 一票一用

## 配置项

所有可调参数集中在 `.env`（见 `.env.example` / `backend/.env.example`）。

- **后端 `PHANTOM_*`**：改完重启 backend 容器即生效（`docker compose up -d`）
- **前端 `VITE_*`**：属 Vite 构建时注入，改后必须 `docker compose up -d --build` 重 build 前端镜像
- **画布尺寸**只改 `PHANTOM_CANVAS_W/H` —— 后端按它生成路径、前端 `VITE_CANVAS_W/H` 从同一变量取值，保证两者一致（否则路径出界）

### 基础 / 安全

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PHANTOM_REDIS_URL` | `redis://localhost:6379/0` | Redis 连接 |
| `PHANTOM_CORS_ORIGINS` | 本地三源 | 允许的前端来源（逗号分隔，接入方网站源都要加） |
| `PHANTOM_TOKEN_SECRET` | 进程随机 | token HMAC 密钥（生产必注入 `openssl rand -hex 32`） |
| `PHANTOM_CHALLENGE_TTL` / `PHANTOM_TOKEN_TTL` | 120 / 300 | challenge / token 生命周期（秒） |
| `PHANTOM_MAX_DRIFT_SECONDS` | `3.0` | 提交时效上限：`last_point_t` 距 now 最大偏移（防离线慢算） |
| `PHANTOM_CLOCK_SKEW_MS` | `1500` | 前后端时钟漂移容差（毫秒） |

### 画布 / 难度

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PHANTOM_CANVAS_W` / `PHANTOM_CANVAS_H` | `480` / `480` | 画布尺寸（单一来源，前端 `VITE_CANVAS_*` 同步取值） |
| `PHANTOM_CHALLENGE_DURATION` | `5.0` | 方块沿贝塞尔路径移动时长（秒）—— 决定速度与难度 |
| `PHANTOM_TARGET_HALF` | `22` | 目标方块半边长（画布相对） |
| `PHANTOM_FPS` | `60` | 帧率（仅约定下发） |

### 评分权重

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PHANTOM_PASS_THRESHOLD` | `0.8` | 综合评分通过阈值 |
| `PHANTOM_W_DTW` / `PHANTOM_W_BIO` | `0.6` / `0.4` | Composite 权重；调大 W_DTW 偏向"跟得准" |
| `PHANTOM_W_JERK` / `PHANTOM_W_ZC` / `PHANTOM_W_PSD` | `0.4` / `0.3` / `0.3` | S_Bio 内部权重（能量 / 零交叉 / 震颤） |
| `PHANTOM_DTW_D_REF_RATIO` | `0.15` | DTW 衰减尺度（越大越宽松；每点偏差占对角线此比例时 S≈0.37） |
| `PHANTOM_SMOOTHNESS_EPS` / `_CAP` / `_BIO` | `0.08` / `0.20` / `0.05` | 平滑否决线 / Composite 封顶 / 否决态 S_Bio |

### DSP / 生理特征阈值

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PHANTOM_DSP_FS` | `100` | 上采样目标频率（Hz） |
| `PHANTOM_BUTTER_ORDER` / `PHANTOM_BUTTER_CUTOFF` | `4` / `7.0` | 巴特沃斯阶数 / 截止频率（Hz） |
| `PHANTOM_TREMOR_LO_HZ` / `PHANTOM_TREMOR_HI_HZ` | `8.0` / `12.0` | 生理震颤频段（Hz） |
| `PHANTOM_ENERGY_MIN/LOW/HIGH/MAX` | `0.1/0.3/8.0/20.0` | 残差能量边界（px）；LOW~HIGH 生理区间 |
| `PHANTOM_ZC_FLOOR/RISE/PLATEAU/DROP` | `1.0/1.67/15.0/40.0` | 加速度零交叉率边界（次/秒）；RISE~PLATEAU 满分 |
| `PHANTOM_TREMOR_AMP_MIN/LOW/HIGH/MAX` | `0.05/0.3/8.0/20.0` | 震颤振幅边界（px） |
| `PHANTOM_TREMOR_PSD_MIN/LOW/MID` | `0.02/0.4/0.13` | 震颤频谱占比段 |
| `PHANTOM_W_TREMOR_AMP` / `PHANTOM_W_TREMOR_PSD` | `0.5` / `0.5` | tremor 子分内部权重 |
| `PHANTOM_MIN_POINTS` | `30` | 轨迹有效点数下限 |

### 前端渲染参数（Vite 构建时注入，改后需 `--build`）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `VITE_API_BASE` | `/api` | 后端地址（生产可设独立域名） |
| `VITE_PARTICLE_DENSITY` | `0.6` | 目标方块每像素铺的亮粒子比例（越大越密） |
| `VITE_PARTICLE_DROP_RATE` | `0.05` | 反密度分析：每帧随机丢弃粒子比例 |
| `VITE_PARTICLE_BRIGHTNESS` | `0.55` | 目标簇亮度基值（0~1） |
| `VITE_PARTICLE_BRIGHTNESS_VAR` | `0.45` | 亮度随机闪烁幅度 |

> 前端 `VITE_*` 非法或缺失时回退默认值；非法 `PHANTOM_*` 同样回退（不影响启动）。

## 数据流

```
前端 ──ECDH 公钥──▶ /challenge ◀── 后端生成 ECDH+会话密钥+贝塞尔路径
   ◀── 后端公钥 + 加密路径参数 ──
前端 ECDH 派生同一会话密钥 → 解密路径 → Canvas 动态显影
用户按住激活键跟随方块 5s → tracker 采集轨迹
前端 AES-GCM 加密轨迹 ──▶ /verify（立即提交，MAX_DRIFT_SECONDS 时效）
后端 GETDEL challenge（一次性销毁）→ 解密 → 评分 → 签发 token
业务端 ──token──▶ /consume-token ◀── GETDEL（一票一用）
```

## 接入与部署

### 在你的网站里接入 Phantom

Phantom 提供 **script-tag SDK**，接入方引一个 `<script>` + 一个容器 `div` 即可嵌入，
类似 reCAPTCHA：

```html
<script src="https://phantom.your-domain.com/phantom.js"></script>
<div id="phantom-box"></div>
<script>
  Phantom.mount("#phantom-box", {
    apiBase: "https://phantom.your-domain.com",
    onSuccess: (r) => console.log("token =", r.token),   // 把 token 发给你的后端核销
    onFail:   (r) => console.log("未通过", r.detail),
  });
</script>
```

> ⚠️ token 是**一次性真人券**，必须由你的业务后端调用 `/consume-token` 核销，**不要
> 在浏览器侧核销**。完整接入流程（前端嵌入 + 后端核销闭环）见 **[接入文档](./docs/integration.md)**。

### 一键全栈部署（Docker Compose）

```bash
cp .env.example .env          # 编辑：设置 PHANTOM_CORS_ORIGINS、PHANTOM_TOKEN_SECRET
docker compose up -d --build  # Redis + 后端 + 前端 nginx，一条命令起全栈
# http://localhost           → 官方 demo
# http://localhost/demo.html → 接入示例页
# https://…/phantom.js       → SDK 包（接入方引用）
```

生产部署前务必在 `.env` 中设置稳定的 `PHANTOM_TOKEN_SECRET`（`openssl rand -hex 32`）
和你的网站域名 `PHANTOM_CORS_ORIGINS`。

### 目录结构（接入相关）

```
phantom/
├── frontend/
│   ├── src/phantom.ts       # SDK 公共入口：Phantom.mount() 工厂
│   ├── src/styles.ts        # 注入式 widget 样式（dark/light 主题）
│   ├── vite.sdk.config.ts   # SDK 构建：产出 phantom.js（IIFE + 混淆）
│   ├── public/demo.html     # 模拟第三方接入示例页
│   ├── Dockerfile           # 前端镜像（node 构建 → nginx 托管 + /api 反代）
│   └── nginx.conf
├── backend/Dockerfile       # 后端镜像（多阶段，scipy 编译优化）
├── examples/mock-biz-server.py  # 模拟接入方业务后端（演示 token 核销闭环）
├── docker-compose.yml       # 全栈：redis + backend + frontend
├── .env.example             # Compose 部署环境变量
└── docs/integration.md      # ★ 面向接入程序员的完整文档
```

---

## Buy me a coffee ~
![donate](static/donate.png)