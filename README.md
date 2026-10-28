# 定时探活

一个自托管的 API 会话检测工具。通过中文管理面板配置任务，向自定义的 OpenAI 兼容 Chat Completions 接口发送随机短对话，记录接口状态、响应耗时和运行历史。

## 功能

- 管理员登录、服务端会话、退出登录、修改密码。
- 多个独立检测任务，可自定义 API 地址、密钥和模型名称。
- 两种调度：每隔若干分钟执行，或每天在多个指定时间执行；每个任务可独立选择时区。
- 立即运行、暂停/启用、编辑、删除，以及按任务和结果筛选历史。
- 检查 HTTP 状态、JSON 和实际的非空聊天回复，不把空响应算作成功。
- 同一任务不重叠运行，全局并发受限；重启后恢复调度，不补发大量错过的请求。
- SQLite 持久化，运行记录按保留天数清理。
- API 密钥加密存储，前端保存后只得到“已配置”状态，无法读回密钥。

## 轻量云部署

镜像在本地电脑构建，云服务器只负责加载和运行。`compose.yaml` 不包含构建步骤，云端不需要 Node.js、npm 或源码依赖。

需要本地安装 Docker Desktop（使用 Linux 容器），云端安装 Docker Engine 和 Docker Compose。当前发布镜像为 `linux/amd64`；云端执行 `uname -m`，`x86_64` 对应 `linux/amd64`，`aarch64` 对应 `linux/arm64`，不要混用架构。

### 1. 获取镜像包

可以从本仓库 GitHub Releases 下载对应版本的镜像包和同名 `.sha256` 文件，也可以在本地项目目录构建。Release 另附 `compose.yaml` 和配置模板 `env.example`；若直接使用 Release 附件，后续的 `cp .env.example .env` 改为 `cp env.example .env`，无需下载源码。

Windows PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-image.ps1 -Version 1.0.0
```

Linux / macOS：

```bash
bash scripts/build-image.sh --version 1.0.0
```

输出到 `artifacts/`：

```text
dingshi-tanhuo-1.0.0-linux-amd64.tar.gz
dingshi-tanhuo-1.0.0-linux-amd64.tar.gz.sha256
```

ARM 服务器分别添加 `-Platform linux/arm64` 或 `--platform linux/arm64`。如果本地无法连接 Docker Hub，分别添加 `-BaseImage public.ecr.aws/docker/library/node:24-bookworm-slim` 或 `--base-image public.ecr.aws/docker/library/node:24-bookworm-slim`。

脚本只保存镜像，不包含本地管理员、API 密钥、`.env` 或运行数据卷，不会自动推送任何镜像仓库。重复运行不会覆盖已有镜像包；更新时请使用新版本号。

### 2. 上传到云服务器

在云服务器准备一个固定部署目录：

```bash
mkdir -p ~/tanhuo
```

在本地项目目录上传以下四个文件，将 `user@your-server` 换成实际 SSH 地址：

```powershell
scp .\compose.yaml .\.env.example .\artifacts\dingshi-tanhuo-1.0.0-linux-amd64.tar.gz .\artifacts\dingshi-tanhuo-1.0.0-linux-amd64.tar.gz.sha256 user@your-server:~/tanhuo/
```

不需要上传整个项目、`node_modules` 或本地 `.env`。

### 3. 导入并启动

在云服务器执行：

```bash
cd ~/tanhuo
sha256sum -c dingshi-tanhuo-1.0.0-linux-amd64.tar.gz.sha256
docker load -i dingshi-tanhuo-1.0.0-linux-amd64.tar.gz
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，确认 `TANHUO_IMAGE=dingshi-tanhuo:1.0.0`。首次启动前可设置至少 12 位的独立 `ADMIN_PASSWORD`；留空则首次启动会生成随机密码，仅在启动日志输出一次。不要把 `.env` 提交到 GitHub。

```bash
docker compose -p tanhuo up -d --pull never
docker compose -p tanhuo ps
docker compose -p tanhuo logs tanhuo
```

`--pull never` 使用本地导入的镜像，不需要服务器连接镜像仓库。默认仅监听服务器本机 `127.0.0.1:3000`，按下一节配置远程访问。用户名默认为 `admin`，首次登录后请在“系统设置”修改密码。已有管理员不会被环境变量重新设置密码。

### HTTPS 与访问限制

不要在公网通过明文 HTTP 登录或填写密钥。推荐由同一服务器上的 Nginx/Caddy 提供 HTTPS，`.env` 设置：

```dotenv
TANHUO_IMAGE=dingshi-tanhuo:1.0.0
HOST_BIND=127.0.0.1
HOST_PORT=3000
SECURE_COOKIE=true
TRUST_PROXY=true
ALLOW_PRIVATE_ENDPOINTS=false
```

反向代理转发到 `http://127.0.0.1:3000`，保留客户端请求的 `Host`，设置正确的 `X-Forwarded-Proto`，并覆盖客户端伪造的转发头。`TRUST_PROXY=true` 只适用于你控制的单层反向代理；应用端口不得直接对公网开放。云防火墙仅开放所需 SSH 和 HTTPS 端口。

暂时没有域名和 HTTPS 时，保留 `HOST_BIND=127.0.0.1`、`SECURE_COOKIE=false`、`TRUST_PROXY=false`，在本地通过 SSH 隧道管理：

```bash
ssh -N -L 3000:127.0.0.1:3000 user@your-server
```

随后在本地访问 `http://127.0.0.1:3000`，不必开放服务器的 `3000` 端口。

### 更新与回滚

新版本仍在本地构建并上传。云端校验、`docker load` 后，将 `.env` 的 `TANHUO_IMAGE` 改为新版本，再运行：

```bash
docker compose -p tanhuo up -d --pull never
docker compose -p tanhuo ps
```

始终使用相同的部署目录和 Compose 项目名。`-p tanhuo` 对应数据卷 `tanhuo_tanhuo-data`；已有部署若使用其他项目名，继续沿用原项目名。不要使用 `docker compose down -v`，它会删除数据库、会话和密钥。

更新前备份。若版本没有不兼容的数据格式变化，可把 `TANHUO_IMAGE` 改回旧版本并执行相同启动命令回滚；涉及数据迁移的版本应按发布说明同时恢复备份。

### 备份

停止应用后备份整个数据卷，尤其是数据库和 `master.key`。丢失加密文件将无法解密 API 密钥；仅备份数据库不够。以下示例使用已加载的应用镜像，不额外下载备份工具镜像：

```bash
mkdir -p backups
chmod 700 backups
docker compose -p tanhuo stop
docker run --rm --network none --user 0:0 --entrypoint tar \
  -v tanhuo_tanhuo-data:/data:ro \
  -v "$PWD/backups:/backup" \
  dingshi-tanhuo:1.0.0 -czf /backup/tanhuo-backup.tar.gz -C /data .
docker compose -p tanhuo start
chmod 600 backups/tanhuo-backup.tar.gz
```

替换示例中的实际卷名和镜像版本。备份含敏感数据，应加密保存并限制访问，不能上传到公开仓库或公开 Release。

## 配置检测任务

在“检测任务”中新建任务，填写：

| 字段 | 示例 |
| --- | --- |
| 任务名称 | 主接口 |
| API 地址 | `https://api.example.com/v1` |
| 模型名称 | 上游实际支持的模型 ID |
| API 密钥 | 上游的访问密钥 |
| 调度方式 | 间隔 30 分钟，或每天 `09:00`、`14:00`、`21:30` |
| 时区 | `Asia/Shanghai` |

API 地址接受基础地址或完整的 `/chat/completions` 地址。基础地址会补上 `/chat/completions`，不会自动补 `/v1`。地址中不能携带用户名、密码、查询参数或片段；密钥只能填写在独立的密钥字段中。

当前协议是 OpenAI 兼容的非流式 Chat Completions，使用 Bearer 鉴权和 `max_tokens` 参数。模型名称会原样发送。不是任意 HTTP 端点的通用探针，也不直接支持仅提供 Responses、Anthropic Messages 或 Gemini 原生协议的端点。

每次请求会从内置的简短问题中随机选择内容，附带随机标记，限制输出长度。请求仍可能计费，具体金额由上游决定；间隔和每日时间点应按你的额度设置。检测失败不会自动重试，以免放大请求量。

编辑任务时，密钥留空表示保留原值，填写新值才会替换。浏览器不会收到已保存的明文、掩码尾号或密文。

## 安全说明

- 密码使用带随机盐的 scrypt 哈希；会话令牌的哈希存入数据库。
- API 密钥由服务端 AES-256-GCM 加密，默认加密文件自动生成并持久保存。
- Cookie 为 HttpOnly、SameSite=Strict；写操作同时校验会话、CSRF 令牌和来源。
- 登录有速率限制；接口响应、运行历史和错误信息会避免泄露密钥。
- 默认拒绝访问内网、回环和链路本地等保留地址，并禁止跟随上游重定向。
- 确需访问局域网、宿主机或 Docker 内网接口时，可显式设置 `ALLOW_PRIVATE_ENDPOINTS=true`，这会放宽 SSRF 防护，只应在可信环境启用。
- 这是单管理员、单进程应用。不要同时启动多个共享数据库的副本，否则可能重复调度任务。

## 本地开发

需要 Node.js 24。

```bash
npm ci
npm run dev
```

前端位于 `http://127.0.0.1:5173`，后端位于 `http://127.0.0.1:3000`。启动日志包含首次生成的管理员密码，本地数据默认位于 `data/`。

```bash
npm test
npm run build
npm start
```

生产构建由后端在同一个端口提供，无需单独启动前端服务。公共健康检查为 `GET /api/health`，不会返回配置信息。

### 浏览器测试

```bash
npx playwright install chromium
npm run build
npm run test:e2e
```

端到端测试使用独立的临时数据库和本地模拟上游，不会请求真实模型。已有 Chrome/Edge 的环境也可以通过 `PLAYWRIGHT_CHANNEL=chrome` 或 `PLAYWRIGHT_CHANNEL=msedge` 运行。

## 项目结构

```text
client/             React 管理面板
server/             鉴权、存储、API、检测和调度
tests/              后端与调度单元/集成测试
e2e/                浏览器端到端测试
Dockerfile          多阶段构建、非 root 运行
compose.yaml        仅运行预构建镜像及持久化卷
compose.build.yaml  可选的本地 Compose 构建配置
scripts/build-image.*  本地构建、导出镜像和 SHA256
```
