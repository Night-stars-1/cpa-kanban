# CPA Insight

独立的中文单账号 CPA 窗口预测看板，参考 [CPA Manager Plus](https://github.com/seakee/CPA-Manager-Plus) 的「当前窗口预测」算法。React + TypeScript 前端，Node.js 本机只读适配服务。

## 配置与启动

本机运行需要 Node.js 22.12+ 与 npm；Docker 部署只需要 Docker Engine 和 Docker Compose。数据源由**服务端环境变量**配置，不在网页中输入地址或密钥。

```sh
npm install
cp .env.example .env
```

编辑项目根目录 `.env`，填写实际配置：

```dotenv
CPA_MANAGER_BASE_URL=http://127.0.0.1:18317
CPA_MANAGER_ADMIN_KEY=填写实际的_Manager_Admin_Key
PORT=5173
```

然后启动：

```sh
npm run dev
```

打开 **http://127.0.0.1:5173**，页面自动加载当前账号的窗口数据，无需点击连接实例。

| 环境变量 | 必需 | 说明 |
|---|---|---|
| `CPA_MANAGER_BASE_URL` | 是 | CPA Manager Plus Full Mode 地址，通常为 `http://host:18317`，也接受带 `/management.html` 或 `/v0/management` 的地址 |
| `CPA_MANAGER_ADMIN_KEY` | 是 | Manager Admin Key，不是模型 API Key，也不是单独 CPA 的 Management Key |
| `PORT` | 否 | 本机端口，默认 `5173`；Compose 中为宿主机发布端口，容器内部固定 `5173` |
| `HOST` | 否 | Node.js 监听地址，默认 `127.0.0.1`；镜像与 Compose 内固定为 `0.0.0.0` |
| `PUBLIC_ORIGIN` | 否 | 非本机访问时允许的完整 `http(s)://主机[:端口]`，不能包含路径、查询或凭据 |
| `BIND_ADDRESS` | 否 | 仅 Compose：宿主机发布地址，默认 `127.0.0.1`；开放局域网需配合 `PUBLIC_ORIGIN` |
| `CPA_INSIGHT_IMAGE` | 否 | 仅 Compose：使用的镜像，默认 `ghcr.io/night-stars-1/cpa-kanban:latest`；可指定版本／`sha-` 标签或本地构建标签 |

可以直接由终端、容器或服务管理器注入环境变量，不必创建 `.env`。启动入口自动加载根目录 `.env`，**系统环境变量优先**；修改任一配置后需重启 Node.js 服务。不要使用 `VITE_` 前缀传递管理密钥。

缺少必需配置时，服务仍提供页面，数据接口返回明确的 HTTP 503 配置错误；页面不生成演示数据，也不自动回退到其他来源。首次读取失败显示无数据；已成功加载后刷新失败则保留上次实际数据，并提示错误。

生产运行：

```sh
npm run build
npm start
```

开发与生产模式均由 `server.mjs` 提供页面和数据接口，不需要另启 Vite 服务。本机启动默认只监听 `127.0.0.1`；容器监听所有容器接口，但 Compose 默认只向宿主机回环地址发布端口。

## Docker 部署

项目包含多阶段 `Dockerfile`、`compose.yaml` 和 `.dockerignore`，不需要在宿主机安装 Node.js 或提前构建前端。可以直接使用 CI 发布的镜像，也可以在本机构建；两种方式共用同一份 `compose.yaml`，安全默认值不变（非 root、回环发布端口、密钥只在运行时注入）。

### 镜像与访问

镜像发布在 `ghcr.io/night-stars-1/cpa-kanban`，由仓库 [Night-stars-1/cpa-kanban](https://github.com/Night-stars-1/cpa-kanban) 的 GitHub Actions 在 `main` 分支和 `v*` 标签上构建并推送。

仓库与镜像包都是**私有**的：拉取前需要先登录 GHCR，且该 GitHub 账号必须能访问上述仓库并已获得该镜像包的读取权限；仅凭镜像地址无法匿名拉取。

```sh
# 先通过安全方式设置临时 GHCR_TOKEN 环境变量，再通过标准输入登录
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u 你的GitHub用户名 --password-stdin
```

`GHCR_TOKEN` 应为具有 `read:packages` 权限、且允许读取该包的 GitHub 个人访问令牌（classic），**不是** CPA Manager Admin Key。普通 `gh auth` 登录令牌未必有包读取权限，不能直接假定它能用于拉取。不要把注册表令牌写进命令行参数、`compose.yaml`、`.env` 或本仓库文件；Docker 可能把登录凭据保存到本机凭据助手或 Docker 登录配置，临时机器使用完成后执行 `docker logout ghcr.io`。

仓库与镜像包的可见性由仓库所有者维护，本仓库不要求也不记录任何账号凭据；推送镜像只使用 GitHub Actions 运行时的 `GITHUB_TOKEN`。

镜像目前仅发布 `linux/amd64`。其他架构需要自行从源码构建，或显式以 `--platform linux/amd64` 运行并接受模拟执行的性能与兼容性风险。

`main` 分支每次推送发布 `latest` 与 `sha-<短提交>` 标签；推送 `v*` 标签时额外按语义化版本发布版本标签（如 `1.2.3`、`1.2`）。当前仓库还没有发布任何版本标签，可用标签以 GHCR 包页面为准，不要假定某个版本号已存在。

### 使用已发布镜像

```sh
cp .env.example .env
```

编辑 `.env`，填写真实的 Manager 地址和 Admin Key。若 Manager 运行在 Docker 宿主机上，可以使用：

```dotenv
CPA_MANAGER_BASE_URL=http://host.docker.internal:18317
CPA_MANAGER_ADMIN_KEY=填写实际的_Manager_Admin_Key
PORT=5173
BIND_ADDRESS=127.0.0.1
```

拉取并启动已发布镜像：

```sh
docker compose pull
docker compose up -d --no-build
```

`compose.yaml` 默认使用 `ghcr.io/night-stars-1/cpa-kanban:latest`；需要固定到某个版本或提交时，在 `.env` 中设置 `CPA_INSIGHT_IMAGE=ghcr.io/night-stars-1/cpa-kanban:sha-<短提交>`。

### 从源码构建

保留本仓库源码并希望自行编译时，直接构建：

```sh
docker compose up -d --build
```

`--build` 会用本地源码构建并打上同一个镜像名；如需与已发布镜像共存，可在 `.env` 设置 `CPA_INSIGHT_IMAGE=cpa-insight:local` 再执行 `docker compose up -d --build`。

两种方式启动后，都在 Docker 宿主机打开 **http://127.0.0.1:5173**。如果已有开发服务占用 `5173`，将 `.env` 的 `PORT` 改为例如 `5175`，或先停止开发服务。容器内部始终使用 `5173`，不需要同步修改内部端口。

### Manager 地址与网络

- **容器中的 `127.0.0.1` 指容器自身**，不能直接沿用指向宿主机 Manager 的 `http://127.0.0.1:18317`。
- Compose 已为 `host.docker.internal` 配置 `host-gateway` 别名。原生 Linux Docker 下，宿主机 Manager 还需监听容器可达的地址，且防火墙允许容器访问；只监听宿主机回环地址的服务不能靠该别名自动开放。
- 如果 Manager 也在容器中，并且两个服务已加入同一个 Docker 网络，使用 Manager 的服务名和容器端口，例如 `http://cpa-manager-plus:18317`；其他情况使用容器可达的宿主机地址或远程 HTTPS 地址。

### 局域网与反向代理

默认不向局域网或公网公开。确需通过服务器 IP 访问时，设置实际的发布地址与浏览器来源，例如：

```dotenv
BIND_ADDRESS=0.0.0.0
PUBLIC_ORIGIN=http://192.168.1.100:5173
```

将示例 IP、协议和端口改成实际访问地址。`PUBLIC_ORIGIN` 只允许一个完整来源；未知 Host 和跨来源请求仍被拒绝，不会因为容器监听 `0.0.0.0` 而全部放开。

本看板**没有内置登录认证**，公开后他人可能读取账号用量。公网部署应使用带鉴权的 HTTPS 反向代理，通常继续保留 `BIND_ADDRESS=127.0.0.1`，并设置 `PUBLIC_ORIGIN=https://你的实际域名`。代理必须保留浏览器访问的 Host；程序不自动信任 `X-Forwarded-Host` 或 `X-Forwarded-Proto`。

### 更新、日志与停止

```sh
# 已发布镜像有更新：拉取新镜像后用现有镜像重新创建容器
docker compose pull
docker compose up -d --no-build

# 从源码部署时：重新构建并启动
docker compose up -d --build

# 只修改 .env 后重新创建容器；单纯 restart 不会重新注入变量
docker compose up -d --force-recreate --no-build

# 查看进程状态与日志
docker compose ps
docker compose logs -f cpa-insight

# 停止并移除本项目容器和网络
docker compose down
```

镜像以非 root 用户运行，运行阶段仅包含 Node.js、服务端代码与前端产物，不携带项目的 `node_modules` 或前端构建工具。`.env` 和管理密钥不参与镜像构建，只在运行时注入。看板没有本地数据库，无需数据卷；原有配额快照和请求历史仍保存在 Manager。

镜像健康检查只验证看板进程的 `/api/health`，不代表上游地址、凭据或额度快照可用；未配置数据源时容器可以是 healthy，页面仍会明确显示配置错误。

## 上游要求

- CPA Manager Plus Full Mode 已配置 CPA 上游并启用请求监控，管理密钥已初始化。
- Manager 已采集请求历史，且数据库中已有额度快照。可先在原 CPA Manager Plus 面板完成采集；本看板不主动探测 Provider，不生成或写入额度快照。
- 纯 CPA `:8317`、轻量面板、GitHub Pages 演示站不提供所需的持久化窗口统计。

没有快照的账号会提示原因，而不是生成虚构预测。没有可信实际用量的窗口显示「无数据」，不填成零。费用使用 Manager 返回的模型计价结果，按 USD 展示。非本机上游建议使用 HTTPS。

## 看板功能

- 独立单页，无顶部导航、侧边栏、底部说明卡或页脚，也没有连接／断开入口。
- 单账号直接展示名称、服务商和套餐，切换额度窗口查看实际请求、预计整窗口请求、预计 Token 和预计费用。
- 比较所选窗口的上个窗口实际、当前窗口已用、当前窗口预测，支持请求、Token、成本切换；缺失与零用量明确区分。
- 查看已用额度、配额观测时间、重置时间、预测依据与不可预测原因。
- 按窗口筛选和 CSV 导出；明细与导出仅包含当前账号，单页不显示分页按钮；导出处理电子表格公式注入。
- 页面打开时自动读取数据，支持手动刷新或每 30／60 秒刷新；隐藏页面暂停自动刷新，避免并发请求。
- 支持桌面、平板和手机，窄屏表格在内部横向滚动。
- 自动刷新、窗口筛选和账号选择统一使用自定义浮层菜单，不弹出系统原生下拉菜单；支持方向键、Enter、Escape、点击外部关闭，以及长文本省略和屏幕边缘避让。

不同窗口可能覆盖同一批请求，因此**不跨窗口合计**。如果上游实际返回多个账号，界面才显示账号选择器；图表、明细与导出仍限定当前账号。

## 预测口径

「当前窗口预测」指**整个额度窗口的预计总用量**，不是剩余可用量、耗尽时间、未来请求成功率或额度保证。

已用额度为 `p%`，可信当前用量为 `x`：

```text
外推系数 = 100 / p
预计请求 = max(当前请求, round(当前请求 × 外推系数))
预计 Token = max(当前 Token, round(当前 Token × 外推系数))
预计费用 = max(当前费用, round(当前费用 × 100 × 外推系数) / 100)
```

例如已用 25% 额度、实际 100 次请求，预计整窗口 400 次，而非剩余 400 次。

与上游一致，预测要求固定或日历窗口、可靠起止边界、有效且未过期的周期、完整模型范围、可信的当前统计，以及足够新的配额观测。当前用量晚于配额观测时间时不预测。额度比例或当前用量不足以外推时，只有可信且正常结束的上一周期可以回退使用；回退结果不能低于当前实际值。滚动窗口不外推。不预测成功率或耗尽时间。

## 接口与安全边界

浏览器只调用 **`GET /api/snapshot`**，不携带实例地址、管理密钥或配置请求体。旧的 `POST /api/snapshot` 已移除，返回 HTTP 405；网页不能改写服务端数据源。`GET /api/health` 提供不含敏感配置的健康状态。

服务端只允许以下上游路由：

| 方法 | 路由 | 用途 |
|---|---|---|
| GET | `/usage-service/info` | 识别 Manager Server |
| GET | `/v0/management/auth-files` | 通过 Manager 读取账号清单 |
| POST | `/v0/management/quota-snapshots/query` | 查询已有额度快照，只读语义 |
| POST | `/v0/management/monitoring/account-window-usage` | 查询当前／上一周期实际统计，只读语义 |

不会调用写入端点 `POST /v0/management/quota-snapshots`。账号／窗口请求分批遵循上游数量上限，响应按账号、请求键及精确时间区间关联，不跨账号猜测数据。上游请求超时 30 秒，不跟随重定向。

管理密钥仅在 Node.js 服务端使用，不进入前端构建产物、页面、浏览器请求或浏览器存储。`.env` 已加入 Git 与 Docker 上下文忽略规则，`.env.example` 只提供不含真实密钥的模板。服务只接受本机 Host 或显式配置的 `PUBLIC_ORIGIN`，拒绝不匹配的 Origin；上游错误不转发原始响应体。字体来自 Google Fonts，失败时回退系统字体，额度数据与密钥不会发送到字体服务。

## 代码入口

- `src/App.tsx`：单页看板、自动加载与窗口交互。
- `src/contracts.ts`：规范化数据契约。
- `lib/manager.mjs`：账号身份、额度快照、窗口用量的只读适配。
- `lib/forecast.mjs`：窗口区间与预测准入、计算。
- `server.mjs`：环境变量配置、本机 API、开发／生产页面服务。
- `.env.example`：环境变量模板。
- `Dockerfile`、`compose.yaml`、`.dockerignore`：生产镜像构建与容器运行配置。
- `.github/workflows/publish.yml`：在 `main` 和 `v*` 标签上构建 `linux/amd64` 镜像、推送到 GHCR，并用发布的镜像摘要做容器启动冒烟验证。

`npm run build` 执行 TypeScript 检查和生产构建。本地接口协议与浏览器流程验证不等于已连接某个真实生产实例；实际数据仍取决于其版本、配置、权限和已有快照。

## 来源与许可

算法及 API 语义参考 CPA Manager Plus 的 `estimateWindowUsage.ts`、`accountQuotaWindowUsagePresentation.ts` 和相关 Manager Server API。上游 MIT 版权与许可完整保留在 [`THIRD_PARTY_NOTICES`](./THIRD_PARTY_NOTICES)。
