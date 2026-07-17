# Phantom (幻影)

下一代人机验证系统 —— 利用**人类视觉物理极限**与**神经肌肉生理极限**，对自动化机器脚本进行非对称对抗。

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

## 核心判定（手册 §四）

```
Composite = 0.6 · S_DTW + 0.4 · S_Bio        阈值 0.8
S_Bio     = 0.35·energy + 0.30·zc + 0.35·tremor
```

- **S_DTW**：实际轨迹与后端下发贝塞尔路径的 DTW 距离（方向拟合度）
- **S_Bio**：在 4 阶双向巴特沃斯低通（截止 7Hz）后的**残差**上度量
  - 残差能量（人类 0.3–8px；完美机器 ≈0；粗糙机器 >20px）
  - 加速度零交叉频率（人类 3 秒 ≥5 次，钟形区间）
  - 8–12Hz 震颤幅度与功率占比
- **平滑否决**：残差能量 ≈0（过度平滑）→ `S_Bio=0.05`，Composite 封顶 **0.20**

## 安全设计（PRD §四）

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

## 配置项（关键）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PHANTOM_REDIS_URL` | `redis://localhost:6379/0` | Redis 连接 |
| `PHANTOM_CHALLENGE_DURATION` | `5.0` | 方块沿贝塞尔路径的移动时长（秒）—— 决定跟随难度与速度 |
| `PHANTOM_MAX_DRIFT_SECONDS` | `3.0` | 提交时效上限：`last_point_t` 距 now 的最大允许偏移（手册 §四.2，防离线慢算） |
| `PHANTOM_PASS_THRESHOLD` | `0.8` | 综合评分通过阈值 |
| `PHANTOM_SMOOTHNESS_EPS` | `0.08` | 残差能量平滑否决线 (px) |
| `PHANTOM_BUTTER_CUTOFF` | `7.0` | 巴特沃斯截止频率 (Hz) |
| `PHANTOM_TOKEN_SECRET` | 进程随机 | token HMAC 密钥（生产必注入） |

完整列表见 `backend/.env.example` 与 `backend/app/config.py`。

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

