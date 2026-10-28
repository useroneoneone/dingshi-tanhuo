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

## 一键部署

在云服务器的 **root 终端**执行：

```bash
curl -fsSL https://github.com/useroneoneone/dingshi-tanhuo/releases/latest/download/install.sh | bash
```

普通用户使用：

```bash
curl -fsSL https://github.com/useroneoneone/dingshi-tanhuo/releases/latest/download/install.sh | sudo bash
```

支持 x86-64 Ubuntu 云服务器（也提供 ARM64 镜像）。需要 `curl` 和 root/sudo 权限。安装脚本会：

- 自动识别 x86-64 / ARM64，下载本地预构建的对应架构镜像。
- 校验下载文件、导入镜像并启动，云端不编译，不需要 Node.js、npm、Git 或 Docker Hub 连接。
- 缺少 Docker 时，在 Ubuntu/Debian 使用 Docker 官方软件源安装 Engine 和 Compose 插件；不自动卸载或替换已有容器环境。
- 默认使用 `/opt/tanhuo`、Compose 项目名 `tanhuo`，保留任务、密钥和数据库。
- 等待服务健康后显示访问方式；首次安装显示初始管理员信息，升级不重置密码。

其他 Linux 发行版需预装 Docker Engine 和 Compose 插件。已有 Docker 但缺少 Compose、守护进程不可访问或存在冲突软件包时，脚本会停止并提示修复，不会重装现有环境。服务器需能访问 GitHub 及其 Release 下载域名；自动安装 Docker 还需访问 Docker 官方及系统软件源。

安装脚本以 root 权限运行，可先查看仓库的 `scripts/install.sh` 再执行。附件的 SHA256 用于检测下载损坏，不是独立的发布签名。

### 访问与登录

默认仅监听服务器本机 `127.0.0.1:3000`。没有域名时，在自己的电脑执行 SSH 隧道：

```bash
ssh -N -L 3000:127.0.0.1:3000 user@your-server
```

随后打开本机 `http://127.0.0.1:3000`。默认用户名为 `admin`，首次随机密码在安装输出和首次启动日志中显示，请登录后在“系统设置”修改。不要在公网明文 HTTP 下登录或填写 API 密钥。

### 自定义安装

新安装时可指定目录、项目名和本机端口，例如：

```bash
curl -fsSL https://github.com/useroneoneone/dingshi-tanhuo/releases/latest/download/install.sh | bash -s -- --dir /opt/tanhuo --project tanhuo --port 3080
```

现有安装的端口等设置请修改部署目录中的 `.env`，再执行 `docker compose -p tanhuo up -d --pull never --no-build`。自定义目录后，更新继续指定原目录；项目名会从安装记录读取，也可显式指定原值。目标目录及所有父目录必须由 root 拥有、不可被组或其他用户写入，推荐 `/opt` 下的目录。

### 更新

再次执行相同的一键安装命令即可升级到最新稳定版。脚本只更新镜像版本及部署配置，不覆盖现有 `.env` 的其他设置，也不删除数据卷。启动失败会尝试恢复原部署配置，但不包含数据库快照；升级前仍需按下文备份数据。

从旧的手动部署迁移时，先备份，再显式指定原部署目录、原 Compose 项目名，并加 `--adopt`：

```bash
curl -fsSL https://github.com/useroneoneone/dingshi-tanhuo/releases/latest/download/install.sh | bash -s -- --dir /root/tanhuo --project tanhuo --adopt
```

不要为了迁移改用另一个项目名或重新创建空数据卷。脚本默认拒绝覆盖非自身管理的非空目录。自动接管仅支持原版命名卷布局；自定义数据挂载、加密密钥或启动命令须手动迁移，不会强行覆盖。

### 日常管理

```bash
cd /opt/tanhuo
docker compose -p tanhuo ps
docker compose -p tanhuo logs --tail 50 tanhuo
docker compose -p tanhuo restart
```

默认数据卷为 `tanhuo_tanhuo-data`。不要执行 `docker compose down -v`，它会删除数据库、会话和密钥。

### HTTPS 与访问限制

不要在公网通过明文 HTTP 登录或填写密钥。推荐由同一服务器上的 Nginx/Caddy 提供 HTTPS，`.env` 设置：

```dotenv
TANHUO_IMAGE=dingshi-tanhuo:1.0.1
HOST_BIND=127.0.0.1
HOST_PORT=3000
SECURE_COOKIE=true
TRUST_PROXY=true
ALLOW_PRIVATE_ENDPOINTS=false
```

反向代理转发到 `http://127.0.0.1:3000`，保留客户端请求的 `Host`，设置正确的 `X-Forwarded-Proto`，并覆盖客户端伪造的转发头。`TRUST_PROXY=true` 只适用于你控制的单层反向代理；应用端口不得直接对公网开放。云防火墙仅开放所需 SSH 和 HTTPS 端口。

修改配置后，在部署目录重新运行 `docker compose -p tanhuo up -d --pull never --no-build`。没有 HTTPS 时保留 `SECURE_COOKIE=false`、`TRUST_PROXY=false` 并使用 SSH 隧道。

### 备份

停止应用后备份整个数据卷，尤其是数据库和 `master.key`。丢失加密文件将无法解密 API 密钥；仅备份数据库不够。以下示例使用已加载的应用镜像，不额外下载备份工具镜像：

```bash
cd /opt/tanhuo
mkdir -p backups
chmod 700 backups
docker compose -p tanhuo stop
docker run --rm --network none --user 0:0 --entrypoint tar \
  -v tanhuo_tanhuo-data:/data:ro \
  -v "$PWD/backups:/backup" \
  dingshi-tanhuo:1.0.1 -czf /backup/tanhuo-backup.tar.gz -C /data .
docker compose -p tanhuo start
chmod 600 backups/tanhuo-backup.tar.gz
```

替换示例中的实际卷名和镜像版本。备份含敏感数据，应加密保存并限制访问，不能上传到公开仓库或公开 Release。

### 离线安装包

针对不能访问 GitHub 或镜像仓库的 x86-64 Ubuntu 服务器，下载 Release 中的 `dingshi-tanhuo-1.0.1-linux-amd64-offline.tar.gz` 及同名 `.sha256`，再上传到服务器。包内包含预构建镜像、部署配置、校验文件和离线安装脚本，不含本机密码、API 密钥或运行数据。

**离线服务器必须预装并启动 Docker Engine 和 Docker Compose v2 插件。离线包不包含 Docker 或系统依赖安装包。** 安装应用时不访问网络、不拉取镜像、不构建；安装后检测任务仍需能连接你配置的 API。

```bash
sha256sum -c dingshi-tanhuo-1.0.1-linux-amd64-offline.tar.gz.sha256
tar -xzf dingshi-tanhuo-1.0.1-linux-amd64-offline.tar.gz
cd dingshi-tanhuo-1.0.1-linux-amd64-offline
sudo bash install-offline.sh
```

root 用户可省略 `sudo`。安装目录仍默认为 `/opt/tanhuo`，监听 `127.0.0.1:3000`，初始账号和密码显示方式与在线安装一致；访问方式见上文 SSH 隧道。解压目录与安装目录需分开。

离线升级时解压新包并执行 `sudo bash install-offline.sh --dir /opt/tanhuo`，必须沿用原安装目录和项目名，升级前先备份数据。现有 `.env` 设置、密码、任务和密钥会保留。为避免 Compose 的远程引用隐式下载，离线自动升级仅接受原版 `compose.yaml`；自定义 Compose 部署需手动迁移。

维护者可复用已导出的镜像生成离线包，不再次构建：

```bash
node scripts/package-offline.mjs
```

脚本读取当前 `package.json` 版本，校验 `artifacts/` 中的镜像，输出离线压缩包及 SHA256；可用 `--platform linux/arm64`、`--image-dir PATH`、`--output-dir PATH` 指定架构和目录。仅打包显式列出的发布文件，不会包含工作目录或运行数据，也不会覆盖已有归档。

### 本地构建与手动导入

一键安装不需要本地构建。维护者需要生成新版本时，才在本地 Docker 环境执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-image.ps1 -Version 1.0.1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-image.ps1 -Version 1.0.1 -Platform linux/arm64
```

Linux/macOS 对应 `bash scripts/build-image.sh --version 1.0.1`，ARM 添加 `--platform linux/arm64`。本地无法连接 Docker Hub 时，可添加 `-BaseImage public.ecr.aws/docker/library/node:24-bookworm-slim` 或 `--base-image public.ecr.aws/docker/library/node:24-bookworm-slim`。

输出为 `artifacts/` 下的压缩镜像及校验文件，只包含镜像，不包含开发电脑的 `.env`、管理员或运行数据。脚本不自动推送任何镜像仓库，且不会覆盖已有归档。

服务器不能访问 GitHub 时，也可手动上传 Release 的对应架构镜像、同名 `.sha256`、`compose.yaml` 和 `env.example`，在部署目录执行：

```bash
sha256sum -c dingshi-tanhuo-1.0.1-linux-amd64.tar.gz.sha256
docker load -i dingshi-tanhuo-1.0.1-linux-amd64.tar.gz
cp env.example .env
chmod 600 .env
docker compose -p tanhuo up -d --pull never --no-build
docker compose -p tanhuo logs tanhuo
```

此处 `cp` 仅用于首次安装，升级不要覆盖已有 `.env`。手动回滚时可把 `TANHUO_IMAGE` 改为已加载的旧版本并重新启动；涉及数据格式变化时按对应发布说明恢复备份。

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

### 安装脚本测试

加载本地镜像后，在一次性 Linux 容器中测试安装、升级和失败处理；测试使用模拟下载和 Docker 命令，不安装宿主机软件：

```bash
docker run --rm --network none --user 0:0 --entrypoint bash -v "${PWD}:/work:ro" dingshi-tanhuo:1.0.1 /work/tests/installer.test.sh
```

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
scripts/install.sh  云服务器一键安装与更新
scripts/package-offline.mjs  使用已有镜像生成离线安装包
scripts/offline/    离线安装入口与随包说明
```
