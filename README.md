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
| `BIND_ADDRESS` | 否 | 仅 Compose：宿主机发布地址，默认 `127.0.0.1`；开放局域网时设为 `0.0.0.0` |
| `CPA_INSIGHT_IMAGE` | 否 | 仅 Compose：使用的镜像，默认 `ghcr.io/night-stars-1/cpa-kanban:latest`；可指定版本／`sha-` 标签或本地构建标签 |

可以直接由终端、容器或服务管理器注入环境变量，不必创建 `.env`。启动入口自动加载根目录 `.env`，**系统环境变量优先**；修改任一配置后需重启 Node.js 服务。不要使用 `VITE_` 前缀传递管理密钥。

缺少必需配置时，服务仍提供页面，数据接口返回明确的 HTTP 503 配置错误；页面不生成演示数据，也不自动回退到其他来源。读取失败仅将顶部刷新按钮变为「重试」，悬停可查看具体原因，不再单独显示错误面板；首次失败不填充数据，后续失败保留上次实际数据。

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

仓库与镜像包均为**公开**，可以匿名克隆和拉取；不需要登录 GHCR，也不需要配置 `GHCR_TOKEN` 或 GitHub 个人访问令牌。

```sh
docker pull ghcr.io/night-stars-1/cpa-kanban:latest
```

运行看板仍需通过服务端 `.env` 配置 Manager 地址和 Admin Key，这些配置不会进入公开仓库或镜像。推送镜像只使用 GitHub Actions 运行时的 `GITHUB_TOKEN`；发布流程会退出注册表登录后验证匿名拉取。

镜像同时发布 `linux/amd64` 与 `linux/arm64`，共用 `latest`、提交和版本标签；Docker 会按宿主机架构自动拉取对应镜像，通常无需在 Compose 中指定 `platform`。前端静态产物在构建机原生平台生成，运行镜像使用对应目标架构的 Node.js；发布后分别在原生 AMD64 和 ARM64 运行器上匿名拉取并启动验证，不依赖 QEMU 模拟执行。

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

默认不向局域网或公网公开。确需通过局域网地址访问时，只设置发布地址即可：

```dotenv
BIND_ADDRESS=0.0.0.0
```

随后用实际的主机名、IP 和端口访问，例如 `http://192.168.1.100:5173`。程序不维护访问来源清单，域名和 IP 都能直接访问，无需注册、白名单或额外的环境变量。

服务端只校验请求头本身：`Host` 语法无效时返回 HTTP 400；请求带 `Origin` 头、且其中的主机或端口与 `Host` 不一致时返回 HTTP 403。比较只涉及主机与端口，不涉及协议，因此反向代理终止 TLS、后端仍以 HTTP 提供服务时同样可以访问。反向代理应原样保留浏览器的 `Host`；程序不会自动信任 `X-Forwarded-Host` 或 `X-Forwarded-Proto`。

本看板**没有内置登录认证**，公开后他人可能读取账号用量。公网部署应使用带鉴权的 HTTPS 反向代理，通常继续保留 `BIND_ADDRESS=127.0.0.1`，只让代理访问后端。

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

镜像健康检查只验证看板进程的 `/api/health`，不代表上游地址、凭据或额度快照可用；未配置数据源时容器可以是 healthy，页面的「重试」按钮仍会保留配置错误详情。

## 上游要求

- CPA Manager Plus Full Mode 已配置 CPA 上游并启用请求监控，管理密钥已初始化。
- Manager 已采集请求历史，且数据库中已有额度快照。可先在原 CPA Manager Plus 面板完成采集；本看板不主动探测 Provider，不生成或写入额度快照。
- 纯 CPA `:8317`、轻量面板、GitHub Pages 演示站不提供所需的持久化窗口统计。

没有快照的账号会提示原因，而不是生成虚构预测。没有可信实际用量的窗口显示「无数据」，不填成零。费用使用 Manager 返回的模型计价结果，按 USD 展示。非本机上游建议使用 HTTPS。

## 看板功能

- 独立单页，无顶部导航、侧边栏、底部说明卡或页脚，也没有连接／断开入口。
- 直接展示窗口指标，不显示账号信息／选择面板。默认优先选择当前账号真实的 7 天周窗口；没有周窗口时显示该账号已有的真实窗口，不改写周期。点击明细行或用 Enter／空格切换窗口，数据刷新时保留有效的手动选择。
- 比较所选窗口的上个窗口实际、当前窗口已用、当前窗口预测，支持请求、Token、成本切换；缺失与零用量明确区分。
- 查看已用额度、配额观测时间、重置时间、预测依据与不可预测原因。
- 按窗口筛选和 CSV 导出；明细与导出仅包含当前账号，单页不显示分页按钮；导出处理电子表格公式注入。
- 页面打开时自动读取数据，支持手动刷新或每 30／60 秒刷新；隐藏页面暂停自动刷新，避免并发请求。
- 支持桌面、平板和手机，窄屏表格在内部横向滚动。
- 自动刷新和窗口筛选统一使用自定义浮层菜单，不弹出系统原生下拉菜单；支持方向键、Enter、Escape、点击外部关闭，以及长文本省略和屏幕边缘避让。

不同窗口可能覆盖同一批请求，因此**不跨窗口合计**。四项指标、图表、明细与导出始终限定当前账号的真实窗口数据。

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

管理密钥仅在 Node.js 服务端使用，不进入前端构建产物、页面、浏览器请求或浏览器存储。`.env` 已加入 Git 与 Docker 上下文忽略规则，`.env.example` 只提供不含真实密钥的模板。域名或 IP 均可直接访问，服务不维护 Host 清单；仅拒绝语法无效的 `Host`，以及主机或端口与 `Host` 不一致的 `Origin`。上游错误不转发原始响应体。字体来自 Google Fonts，失败时回退系统字体，额度数据与密钥不会发送到字体服务。

## 代码入口

- `src/App.tsx`：单页看板、自动加载与窗口交互。
- `src/contracts.ts`：规范化数据契约。
- `lib/manager.mjs`：账号身份、额度快照、窗口用量的只读适配。
- `lib/forecast.mjs`：窗口区间与预测准入、计算。
- `server.mjs`：环境变量配置、本机 API、开发／生产页面服务。
- `.env.example`：环境变量模板。
- `Dockerfile`、`compose.yaml`、`.dockerignore`：生产镜像构建与容器运行配置。
- `.github/workflows/publish.yml`：发布包含 `linux/amd64` 和 `linux/arm64` 的同一镜像索引，并在两种原生架构运行器上验证匿名拉取、运行时架构及容器启动。

`npm run build` 执行 TypeScript 检查和生产构建。本地接口协议与浏览器流程验证不等于已连接某个真实生产实例；实际数据仍取决于其版本、配置、权限和已有快照。

## 来源与许可

算法及 API 语义参考 CPA Manager Plus 的 `estimateWindowUsage.ts`、`accountQuotaWindowUsagePresentation.ts` 和相关 Manager Server API。上游 MIT 版权与许可完整保留在 [`THIRD_PARTY_NOTICES`](./THIRD_PARTY_NOTICES)。
