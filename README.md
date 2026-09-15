# DeepSeek Harness 内网多用户部署方案

> **非官方项目**。这是社区对 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的第三方容器化封装，
> 由使用者自行维护，**与 DeepSeek AI 无隶属或背书关系**。`dsh` 本身采用 MIT 许可证，本项目在其之上增加了授权网关与多用户隔离。
> 请勿使用 DeepSeek 的商标或品牌标识暗示官方关联。

把 DeepSeek 官方开源的 `dsh` 打包成带授权的 Docker 镜像，
部署在没有互联网的内网服务器上，通过浏览器分发给同事使用。

- **镜像**：`dsh-harness:0.1.5-rc.1`（基于官方 npm 发布包 `@deepseek-ai/dsh@0.1.5-rc.1`）
- **授权**：授权码 + 登录会话，SQLite 存储，无需额外数据库
- **隔离**：每位同事拥有独立的 dsh 实例、独立会话历史、独立工作目录
- **离线**：所有依赖已固化进镜像，运行时不需要任何外网访问

---

<details>
<summary><b>English summary</b> (click to expand)</summary>

A licence-gated, offline-deployable Docker packaging of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`),
an open-source agent harness by DeepSeek AI.

**Unofficial.** This is a third-party packaging, not affiliated with or endorsed by DeepSeek AI.
`dsh` itself is MIT-licensed; this project adds a licence gateway and per-user isolation on top.

**Why a gateway is needed.** `dsh web` is single-user by design: one process means one session
list, one workspace and one `DSH_HOME`, and the launch token it prints is regenerated on every
start, so it cannot be handed to colleagues as a password. The gateway here authenticates users
against a licence store, starts **one isolated `dsh` process per licence key**, and performs
dsh's token exchange server-side so browsers never see it.

**Features**

- Licence-key login with SQLite storage (no external database)
- Per-user isolation: separate process, `DSH_HOME`, session history and workspace
- Fully offline: no runtime internet access required (`--network none` verified)
- Works against any OpenAI-compatible endpoint on an intranet (vLLM / SGLang / Ollama / one-api)
- Ship as a single `docker load`-able tarball or a registry image

**Quick start**

```bash
docker load -i dsh-harness-0.1.5-rc.1.tar.gz
cp .env.example .env && vi .env      # set DSH_LLM_BASE_URL and DSH_LLM_MODEL
docker compose up -d
docker compose exec dsh dsh-license add --label "alice" --days 365
```

Then open `http://<server>:8080` and enter the licence key.
See the Chinese documentation below for the full guide.

</details>

---

## 一、交付物清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 镜像定义 |
| `auth/gateway.mjs` | 授权网关：登录校验、按授权码拉起独立实例、反向代理 |
| `auth/admin.mjs` | 授权码管理命令行（容器内 `dsh-license`） |
| `auth/lib.mjs` | SQLite 授权库读写 |
| `auth/render-config.mjs` | 把环境变量渲染成 dsh 配置 |
| `entrypoint.sh` | 容器启动脚本 |
| `docker-compose.yml` | 推荐的单容器多用户部署编排 |
| `.env.example` | 环境变量模板 |
| `build.sh` | 构建并导出离线 tar 包 |
| `dist/dsh-harness-0.1.5-rc.1.tar.gz` | **可直接导入的镜像包**（适合内网离线分发） |
| `dockertest416/dsh-harness` | Docker Hub **私有**仓库，标签 `0.1.5-rc.1` 与 `latest` |
| `_probe/accept.mjs` | 部署后自检脚本：登录、代理、`/api`、WebSocket 全链路 |
| `_probe/mock-llm.mjs` | 本地模拟 OpenAI 端点，没有模型服务时可用于自测 |

`_probe/` 只是测试脚手架，不会被打进镜像（已在 `.dockerignore` 中排除）。

---

## 二、架构与设计取舍

```
同事浏览器
    │  http://<服务器IP>:8080
    ▼
┌─────────────────────────────────────────────────────────┐
│ 容器 dsh-harness                                         │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ 授权网关 :8080  ← 唯一对外暴露的进程                │ │
│  │  · 校验授权码、签发登录 Cookie                       │ │
│  │  · 按授权码路由到对应用户实例                        │ │
│  └───────┬──────────────────┬─────────────────────────┘ │
│          │                  │                            │
│    127.0.0.1:3101      127.0.0.1:3102                    │
│    ┌─────▼─────┐        ┌─────▼─────┐                    │
│    │ dsh web   │        │ dsh web   │   ← 仅监听回环     │
│    │ 张三      │        │ 李四      │                    │
│    ├───────────┤        ├───────────┤                    │
│    │home 独立  │        │home 独立  │                    │
│    │目录 独立  │        │目录 独立  │                    │
│    └───────────┘        └───────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### 为什么要加这一层网关

dsh 自身**没有多用户概念**，直接暴露会踩三个坑：

1. **只有一个「用户」**。一个 `dsh web` 进程 = 一份会话列表、一份工作目录、一份配置。
   所有连上来的浏览器共享同一份数据，同事之间能互相看到甚至改动对方的会话和文件。
   → 网关按授权码为每人拉起**独立进程**，各自独立的 `DSH_HOME` 与工作目录。

2. **没有可分发的凭证**。dsh 启动时打印的 `?token=...` 是**每次启动随机生成**的，
   打印在容器日志里，重启就变，无法当作固定密码发给同事。
   → 网关在**服务端**完成 token 兑换并保管换来 Cookie，浏览器全程接触不到它。
   同事只面对授权码，与 dsh 内部机制完全解耦。

3. **`--host 0.0.0.0` 被官方明确禁止**（官方理由是"会把远程代码执行能力暴露到网络"）。
   → 网关让 dsh 只监听 `127.0.0.1`，由网关承担对外暴露和鉴权，正好符合官方预期的部署姿势。

### 隔离强度

| 项目 | 是否隔离 |
|---|---|
| 会话历史 | ✅ 每人独立 `DSH_HOME/sessions` |
| 工作目录 | ✅ `/workspace/<备注>-<授权码后缀>` |
| 模型凭证与设置 | ✅ 每人独立 `settings.yaml` / `.credentials.yaml` |
| 登录体系 | ✅ 每人独立 dsh 会话密钥 |
| **容器本身的算力** | ❌ 共享同一台服务器的 CPU / 内存 |

> 隔离的是**数据与工作区**，不是**算力**。同事之间无法看到对方的内容，
> 但一个人跑重任务会占用共同的 CPU。如果需要连算力也隔离，见 §8.3。

---

## 三、快速开始（在服务器上）

**方式一**：从 Docker Hub 私有仓库拉取（服务器能访问 Docker Hub 时）

```bash
# 1. 登录（私有仓库需要授权，用 Docker Hub 的 Access Token 作为密码）
docker login -u dockertest416
docker pull dockertest416/dsh-harness:0.1.5-rc.1
docker tag dockertest416/dsh-harness:0.1.5-rc.1 dsh-harness:0.1.5-rc.1
```

**方式二**：离线导入 tar 包（内网无外网时）

假设你已经拿到 `dsh-harness-0.1.5-rc.1.tar.gz`。

```bash
docker load -i dsh-harness-0.1.5-rc.1.tar.gz
```

然后继续：

```bash
# 2. 准备目录与配置
mkdir -p /opt/dsh && cd /opt/dsh
#   把 docker-compose.yml、.env.example 复制过来
cp .env.example .env
vi .env                      # 至少改 DSH_LLM_BASE_URL 和 DSH_LLM_MODEL

# 3. 启动
docker compose up -d

# 4. 给自己发一个授权码
docker compose exec dsh dsh-license add --label "管理员" --days 3650 --max-devices 5
```

浏览器打开 `http://<服务器IP>:8080`，输入上一步输出的授权码即可进入。

> 授权码显示形如 `DSH-8BWA-BGEF-EA3D-B86V`。输入时不区分大小写和横线，
> 漏掉 `DSH-` 前缀也能识别。

---

## 四、离线部署完整流程

### 4.1 在有互联网的机器上构建

```bash
cd dsh-docker
./build.sh 0.1.5-rc.1
```

产物在 `dist/`：

```
dsh-harness-0.1.5-rc.1.tar.gz
dsh-harness-0.1.5-rc.1.tar.gz.sha256
```

### 4.2 传输到内网

用你们既有的方式（U 盘、跳板机、内网文件服务器）把 `dist/` 下的两个文件传进去。

**务必校验完整性**：

```bash
sha256sum -c dsh-harness-0.1.5-rc.1.tar.gz.sha256
```

### 4.3 在内网服务器上导入并启动

```bash
docker load -i dsh-harness-0.1.5-rc.1.tar.gz
docker images | grep dsh-harness     # 确认导入成功
```

然后按 §三 的步骤 2–4 启动。

### 4.4 验证部署

```bash
# 健康检查：应返回 gateway ok
curl -s http://127.0.0.1:8080/__auth/healthz

# 确认模型配置正确（应打印你的内网地址和模型名）
docker compose exec dsh sh -c 'cat /data/users/*/dsh-home/settings.yaml | head -20'
```

**完整自检**（推荐在正式交付给同事前跑一次）。
先按 §六 发一个测试授权码，然后用自检脚本验证登录、代理、接口与 WebSocket 全链路：

```bash
node _probe/accept.mjs 8080 DSH-XXXX-XXXX-XXXX-XXXX 测试
```

预期输出七项 `PASS`：

```
PASS  [测试] 未登录访问被拦截
PASS  [测试] 授权码登录成功
PASS  [测试] 专属实例已就绪
PASS  [测试] Web UI 正常返回
PASS  [测试]  /api 通过信任围栏
PASS  [测试] 未授权 WebSocket 被拒
PASS  [测试] 授权 WebSocket 建立成功
```

这些检查覆盖了内网部署中最容易出问题的环节：
容器到模型服务的连通性、dsh 的 Host/Origin 信任围栏、以及长连接代理。

> 自检脚本需要 Node.js 18+。若运维机上没有，也可以在能访问该地址的任意机器上执行，
> 把 `8080` 换成实际端口即可。没有真实模型服务时，可先用 `_probe/mock-llm.mjs` 起一个模拟端点，
> 验证整条链路是否通畅。

---

## 五、模型接入配置（重点）

### 5.1 最小配置

只需要在 `.env` 里改两项：

```ini
DSH_LLM_BASE_URL=http://10.0.0.5:8000/v1
DSH_LLM_MODEL=deepseek-chat
```

`DSH_LLM_BASE_URL` 必须带 `/v1` 后缀，指向内网 OpenAI 兼容服务的根路径。
支持 vLLM、SGLang、Ollama、Xinference、one-api、FastChat 等任何 OpenAI 格式服务。

### 5.2 配置是怎么生效的

容器启动时会校验配置并失败即停（不会出现"能启动但一用就报错"）。
每位同事首次登录时，会基于同一份环境变量为他生成独立的
`/data/users/<用户>/dsh-home/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    intranet:
      displayName: 内网 DeepSeek
      apiKeyEnv: DSH_INTRANET_LLM_KEY
      api: openai-completions
      baseURL: http://10.0.0.5:8000/v1
      models:
        - id: deepseek-chat
          contextWindow: 131072
          maxTokens: 8192
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
agent-default-model:
  provider: intranet
  model: deepseek-chat
```

> 这个文件由环境变量生成，**每次重启会覆盖**。
> 若你希望手工精调或让同事在网页里改模型设置，删掉文件首行的
> `# Generated by dsh-docker from environment variables.` 注释即可——
> 网关识别到该标记消失后就不再覆盖它。

### 5.3 兼容性排错（内网部署最容易卡在这里）

多数内网推理服务只实现了 OpenAI 协议的子集。按报错对症调整：

| 现象 | 调整 |
|---|---|
| 400，提示不识别 `developer` role | `DSH_LLM_SUPPORTS_DEVELOPER_ROLE=false`（默认已是） |
| 400，提示 `max_tokens` 不是有效参数 | `DSH_LLM_MAX_TOKENS_FIELD=max_completion_tokens` |
| 400，提示上下文超限 | 调小 `DSH_LLM_CONTEXT_WINDOW`，要与服务端实际配置一致 |
| 400，提示输出长度超限 | 调小 `DSH_LLM_MAX_TOKENS` |
| 401 / 403 | 检查 `DSH_LLM_API_KEY`；服务端若不做校验，随便填一个占位值 |
| 连接被拒 | 容器内能否解析该主机名？建议直接用 IP。见 §9.3 |

**先用 curl 在容器里直接验证模型服务**，能快速定位是模型侧还是 dsh 侧的问题：

```bash
docker compose exec dsh curl -s http://10.0.0.5:8000/v1/models
docker compose exec dsh curl -s http://10.0.0.5:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

### 5.4 暴露多个模型给同事切换

```ini
DSH_LLM_MODELS=deepseek-chat:DeepSeek Chat,deepseek-reasoner:DeepSeek R1
DSH_LLM_MODEL=deepseek-chat
```

第一个为默认模型，同事可在网页的模型选择器里切换。

---

## 六、授权码管理

所有命令通过 `docker compose exec dsh dsh-license <子命令>` 执行，**容器运行中即可操作，无需重启**。

### 6.1 常用操作

```bash
# 新增：有效期 365 天，最多 2 台设备同时在线
docker compose exec dsh dsh-license add --label "张三" --days 365 --max-devices 2

# 新增：永久有效、不限设备
docker compose exec dsh dsh-license add --label "李四"

# 新增：自定义授权码
docker compose exec dsh dsh-license add --label "王五" --key DSH-TEAM-2026-DEMO-0001 --days 90

# 查看全部
docker compose exec dsh dsh-license list

# 吊销（立即阻断访问）
docker compose exec dsh dsh-license revoke DSH-8BWA-BGEF-EA3D-B86V

# 恢复
docker compose exec dsh dsh-license restore DSH-8BWA-BGEF-EA3D-B86V

# 彻底删除
docker compose exec dsh dsh-license remove DSH-8BWA-BGEF-EA3D-B86V

# 导出全部授权码（便于登记造册）
docker compose exec dsh dsh-license export
```

### 6.2 参数说明

| 参数 | 含义 |
|---|---|
| `--label` | 备注，同时用作该用户工作目录名的一部分 |
| `--days N` | N 天后过期；省略或 `0` 表示永久 |
| `--max-devices N` | 允许同时在线的浏览器会话数；`0` 或省略表示不限 |
| `--key` | 指定授权码内容；省略则随机生成 |

### 6.3 查看在线情况与审计

```bash
# 当前在线会话
docker compose exec dsh dsh-license sessions

# 踢下线（按授权码或会话 ID 前缀）
docker compose exec dsh dsh-license kick DSH-8BWA-BGEF-EA3D-B86V

# 操作审计（登录、失败、实例回收等）
docker compose exec dsh dsh-license audit --limit 50
```

### 6.4 吊销的实际效果

- **访问**：立即阻断。被吊销的同事下一次请求就会被弹回登录页。
- **实例**：最多 60 秒内被回收（网关每分钟巡检一次）。
- **数据**：工作目录和会话历史**保留**，不会删除。若需彻底清除，见 §9.2。

---

## 七、日常运维

### 7.1 日志

```bash
docker compose logs -f dsh              # 网关日志
docker compose exec dsh tail -f /data/logs/dsh-张三-XXXXX.log   # 某位用户的 dsh 日志
```

每位用户的 dsh 输出单独记录在 `/data/logs/dsh-<用户>.log`，便于排查个体问题。

### 7.2 数据布局

```
/data/
├── auth.db                    # 授权库（SQLite）
├── instances.json             # 当前实例状态快照
├── logs/                      # 日志
│   ├── dsh-张三-XXXXX.log
│   └── dsh-李四-XXXXX.log
└── users/
    └── 张三-XXXXX/
        ├── dsh-home/          # 该用户的 DSH_HOME
        │   ├── settings.yaml
        │   ├── .credentials.yaml
        │   └── sessions/      # 会话历史
        ├── home/              # 该用户的 HOME
        └── ...

/workspace/
└── 张三-XXXXX/                # 该用户的工作目录
```

### 7.3 备份

需要备份的只有两处：

```bash
# 授权库（含所有授权码与审计记录）
docker compose exec dsh dsh-license export > licenses-backup.txt
docker run --rm -v dsh-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/dsh-data-$(date +%F).tar.gz -C /data auth.db

# 用户工作目录
tar czf workspaces-$(date +%F).tar.gz workspaces/
```

会话历史位于 `/data/users/*/dsh-home/sessions/`，若要保留请一并备份 `dsh-data` 卷。

### 7.4 升级到新的 dsh 版本

```bash
./build.sh 0.1.6        # 在有外网的机器上构建新版本
# 传输到内网后：
docker load -i dsh-harness-0.1.6.tar.gz
# 修改 docker-compose.yml 中的 image 标签
docker compose up -d
```

`/data` 卷不受影响，授权码和用户数据都会保留。

### 7.5 调整容量

```ini
GATEWAY_MAX_INSTANCES=20    # 同时在线人数上限
GATEWAY_IDLE_MINUTES=15     # 闲置多久回收实例
GATEWAY_SESSION_TTL_HOURS=24 # 登录态保持时长
```

改完 `docker compose up -d` 生效。

**内存估算**：每个在线用户约 200–300MB。10 人在线约需 3GB，
建议服务器预留 `GATEWAY_MAX_INSTANCES × 300MB + 1GB` 的可用内存。

---

## 八、安全说明

### 8.1 已经做到的

- dsh 进程只监听 `127.0.0.1`，无法绕过网关直接访问
- dsh 内部的启动 token 与签名 Cookie 由网关在服务端保管，浏览器不可见
- 登录 Cookie 带 `HttpOnly`，具备防篡改 HMAC 签名
- 授权码校验用索引查询，登录失败有频率限制（5 分钟内 10 次）
- 登录、失败、吊销、实例回收均写入审计表
- 每位同事的工作目录独立，容器内文件权限为 `0700`

### 8.2 需要你注意的

1. **网关本身是明文 HTTP**。内网若不完全可信，建议在前面加一层 HTTPS。
   nginx 示例：

   ```nginx
   server {
     listen 443 ssl;
     server_name dsh.intranet;
     ssl_certificate     /etc/ssl/dsh.crt;
     ssl_certificate_key /etc/ssl/dsh.key;

     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 3600s;   # 长连接，勿用默认 60s
       proxy_buffering off;        # SSE 需要
     }
   }
   ```

2. **dsh 的 Agent 具备执行 shell 命令和读写文件的能力**。
   它的沙箱默认把写入限制在各自的工作目录内（`workspace-write`），
   敏感操作会向浏览器发起确认。请勿设置 `DSH_PERMISSION_MODE=danger-full-access`，
   那会关闭全部确认并对所有用户生效。

3. **工作目录属主是 root**。容器以 root 运行，`./workspaces/` 下的文件在宿主机上属主为 root。
   如需调整，把 `docker-compose.yml` 里的挂载改为你希望的属主目录，并相应调整容器用户。

4. **授权码等同于身份凭证**。请像对待密码一样分发（建议一对一发送），
   并利用 `--max-devices` 限制同时在线数。怀疑泄露时立即 `revoke` 并补发。

### 8.3 如果需要连算力也隔离

当前方案共享容器算力。若某位同事的任务会影响他人，可以改为**一人一容器**：

```bash
docker run -d --name dsh-zhangsan -p 8081:8080 \
  -v dsh-data-zhangsan:/data -v /srv/code/zhangsan:/workspace \
  --cpus 2 --memory 4g \
  -e DSH_LLM_BASE_URL=http://10.0.0.5:8000/v1 \
  -e DSH_LLM_MODEL=deepseek-chat \
  dsh-harness:0.1.5-rc.1
```

此时可以关闭网关的授权（每人独占容器，靠端口和网络策略控制），
或保留授权用于审计。用 `--cpus` / `--memory` 精确限制每人用量。

---

## 九、常见问题

### 9.1 同事打开页面显示「正在准备工作环境」

这是正常的：每位同事首次登录时，网关要为他拉起一个专属实例。
容器启动时已在后台预热过模块缓存，正常情况下 **约 7–10 秒**即可进入。
页面每 3 秒自动刷新，无需手动操作。

若超过 2 分钟仍未进入：

```bash
docker compose logs dsh | tail -30
docker compose exec dsh cat /data/logs/dsh-<用户名>.log | tail -40
```

常见原因是模型地址填错导致启动校验未通过。另外，实例是**串行启动**的——
如果多位同事在同一秒内首次登录，后一位会等前一位启动完成，属正常排队。

### 9.2 想彻底删除某位同事的数据

```bash
docker compose exec dsh dsh-license remove DSH-XXXX-XXXX-XXXX-XXXX
docker compose exec dsh rm -rf /data/users/<目录名> /workspace/<目录名>
```

（先 `dsh-license list` 确认目录名，形如 `张三-MAWHP`。）

### 9.3 容器内连不上内网模型服务

1. 确认用的是 IP 而非主机名——容器有自己的 DNS，内网域名通常解析不了。
   必须用域名时，给 `dsh` 服务加 `extra_hosts`：

   ```yaml
   extra_hosts:
     - "vllm.intranet:10.0.0.5"
   ```

2. 从容器内部测试连通性：

   ```bash
   docker compose exec dsh curl -v http://10.0.0.5:8000/v1/models
   ```

3. 确认服务器本身的防火墙允许容器网段访问模型服务端口。

### 9.4 页面能打开但发消息报错

先看该用户的 dsh 日志 `docker compose exec dsh tail -50 /data/logs/dsh-<用户>.log`。
多数是 §5.3 的兼容性问题。也可在网页的「设置 → 模型」里确认 provider 是否为 `intranet`。

### 9.5 修改了 `.env` 后配置没生效

生成过的 `settings.yaml` 不会被覆盖。要么删掉它让容器重新生成：

```bash
docker compose exec dsh rm /data/users/<目录名>/dsh-home/settings.yaml
docker compose restart dsh
```

要么直接编辑该文件（编辑后可长期保留，不再被覆盖）。

### 9.6 授权库损坏或想重置

```bash
docker compose down
docker run --rm -v dsh-data:/data alpine rm -f /data/auth.db
docker compose up -d
```

**注意**：这会清除全部授权码和审计记录，用户工作目录不受影响。
操作前建议先 `dsh-license export` 备份授权码清单。

---

## 十、环境变量全表

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_LLM_BASE_URL` | **必填** | 内网 OpenAI 兼容服务地址，含 `/v1` |
| `DSH_LLM_API_KEY` | `sk-intranet` | 模型服务密钥 |
| `DSH_LLM_MODEL` | `deepseek-chat` | 默认模型 ID |
| `DSH_LLM_MODELS` | 空 | 额外模型列表，逗号分隔 |
| `DSH_LLM_PROVIDER_LABEL` | `内网 DeepSeek` | 界面上显示的服务名 |
| `DSH_LLM_CONTEXT_WINDOW` | `131072` | 上下文窗口 |
| `DSH_LLM_MAX_TOKENS` | `8192` | 单次最大输出 |
| `DSH_LLM_SUPPORTS_DEVELOPER_ROLE` | `false` | 兼容开关 |
| `DSH_LLM_MAX_TOKENS_FIELD` | `max_tokens` | 兼容开关 |
| `DSH_LLM_THINKING_FORMAT` | 空 | 设为 `deepseek` 启用思考模式 |
| `DSH_LLM_REASONING_EFFORT` | 空 | `off` / `low` / `high` / `max` |
| `GATEWAY_PORT` | `8080` | 对外监听端口 |
| `GATEWAY_SESSION_TTL_HOURS` | `12` | 登录态时长 |
| `GATEWAY_IDLE_MINUTES` | `30` | 闲置回收实例的阈值 |
| `GATEWAY_MAX_INSTANCES` | `10` | 同时在线人数上限 |
| `GATEWAY_WORKSPACE_ROOT` | `/workspace` | 工作目录根 |
| `GATEWAY_INSTANCE_PORT_BASE` | `3100` | 内部实例端口起始值 |
| `GATEWAY_AUTH_DISABLED` | 未设置 | 设为 `1` 关闭授权（**仅调试用**） |
| `DSH_PERMISSION_MODE` | `workspace-write` | 沙箱模式，**不要**设为 `danger-full-access` |

---

## 十一、已验证项

本方案在交付前已完成以下实测（Docker Desktop / Linux 容器 / Node 24）：

- 镜像构建、容器启动、配置预检（配置错误会在启动时即失败，不会拖到用时才暴露）
- 授权码生成／列表／吊销／恢复／删除／审计
- 登录流程：正确码通过、错误码拒绝、大小写与横线容错、漏输前缀容错、失败频率限制
- 未登录访问拦截、登录后正常加载 Web UI
- `/api` 接口穿透（dsh 的 Host/Origin 信任围栏）
- WebSocket 升级代理（`/api/remote.mux`，未授权返回 401，已授权返回 101）
- 模型链路：真实调用 OpenAI 兼容端点并取得回复
- **多用户隔离**：两个授权码 → 两个独立实例、独立端口、独立 `DSH_HOME`、独立工作目录
- **吊销生效**：访问立即阻断、实例在一个巡检周期内回收、其他用户不受影响
- **闲置回收**：实测 95 秒回收（60 秒阈值 + 巡检周期），进程清零，用户数据保留
- **断网启动**：以 `--network none` 完全断网运行，容器正常启动、实例就绪、Web UI 正常加载
- **离线分发**：`docker save` → `docker load` 全流程验证，导入耗时约 13 秒
- **文档流程**：按 README 的 compose 步骤从零部署并跑通全部验收项

各项的实测脚本保存在 `_probe/`，可随时复跑。

---

## 附：许可证

本仓库（容器化封装、授权网关、部署工具）采用 **MIT** 许可证，见 [`LICENSE`](LICENSE)。

DeepSeek Harness 本身是独立作品，同样采用 MIT 许可证，构建镜像时会从 npm 安装其发布包。
再分发相关的第三方组件与义务见 [`NOTICE`](NOTICE)。

本项目为**非官方**第三方封装，与 DeepSeek AI 无隶属或背书关系。
