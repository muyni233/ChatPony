# 单实例部署

## 运行前提

Node.js 24+、Bun 1.3+，或 Docker。站点需要可写入且持久化的数据目录。数据库默认路径可以通过启动参数 `--database-path` 或部署环境变量 `DATABASE_PATH` 改变，不影响后台配置方式。

初次运行无需环境变量。第一个注册成功的账号自动获得管理员身份，之后在后台设置站点地址、SMTP、模型服务和角色。

## 构建与启动

在项目根目录运行；Windows、macOS、Linux 命令相同：

```sh
bun install --frozen-lockfile
bun run build
bun run start --port 3210 --hostname 127.0.0.1
```

`scripts/start.mjs` 检查生产构建后，将 `public` 与 `.next/static` 复制到 `.next/standalone` 的相应位置，再启动生成的 `server.js`。这符合 Next.js standalone 输出方式，无需手动运行平台特有的复制命令。每次代码更新应重新构建；不要在正在服务的构建目录内同时执行下一次构建。

| 参数                                   | 含义                                                     | 默认值 / 部署环境变量                                 |
| -------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `--port 3210`、`-p 3210`               | 监听端口，1–65535                                        | `PORT` 或 `3000`                                      |
| `--hostname 127.0.0.1`、`-H 127.0.0.1` | 监听 IP 或主机名；IPv6 可写 `::`                         | `HOSTNAME` 或 `0.0.0.0`                               |
| `--keepAliveTimeout 70000`             | 非活动 HTTP 连接超时，单位毫秒                           | `KEEP_ALIVE_TIMEOUT`；未设置时由 Next.js 决定         |
| `--database-path data/chatpony.sqlite` | 数据库文件，主密钥位于同目录                             | `DATABASE_PATH` 或项目根目录的 `data/chatpony.sqlite` |
| `--check`                              | 只检查构建、参数与解析后的数据路径，不复制文件或监听端口 | 不启动服务器                                          |
| `--help`、`-h`                         | 显示全部启动参数                                         | —                                                     |

命令行参数优先于部署环境变量；无需创建 `.env`。相对数据库路径始终按项目根目录解析，启动入口会在 standalone 改变工作目录之前将其转换成绝对路径，因此 `bun run dev` 与默认 `bun run start` 使用同一份数据库及主密钥。需要完全隔离开发与正式数据时，为正式部署指定独立的持久路径。

可以先运行 `bun run start --check --port 3210` 检查准备情况。`--keep-alive-timeout` 也可作为 `--keepAliveTimeout` 的别名；值为 `0` 时沿用 Next.js 的默认处理。此参数控制空闲连接，与聊天回合的总超时不同。

如果仅分发 `.next/standalone` 目录，需要一并打包 `public` 和 `.next/static`，通过 `node server.js` 启动，并自行将 `DATABASE_PATH` 指向持久化位置。项目 Dockerfile 已完成这些步骤；容器默认数据目录仍是 `/app/data`。项目目录部署请使用上面的 `bun run start`，不要直接执行内部生成入口而绕过资源与数据路径准备。

## Nginx

以下内容放入你已配置 HTTPS 证书的 `server` 中，域名以你自己的为准：

```nginx
location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 覆盖来源，不接受客户端预先提供的 X-Forwarded-For。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 660s;
    proxy_send_timeout 660s;
    client_max_body_size 128k;
}
```

后台「站点地址」填写公开来源，例如 `https://chat.example.com`，供验证与重置密码邮件使用；不使用邮件时可留空。它不参与请求来源校验；即使误填，也可以从原地址登录后台改回，或点击「使用当前访问地址」后保存。本地地址与公开域名可以分别正常访问同一站点。

请求来源按实际 `Host`、协议和端口验证。Next.js 使用 `X-Forwarded-Proto` 推导协议，代理必须覆盖该头并保留完整 `Host`，不要把 `Host` 改写为上游的 `127.0.0.1:3210`。这一协议推导不受后台「信任反向代理」开关控制；该开关仅决定是否读取代理提供的客户端 IP 进行限流。只有确认应用网络入口被代理隔离、来源 IP 头已覆盖时才启用它。Docker 默认端口映射可通过防火墙隔离，或改为 `127.0.0.1:3210:3000` 供同机代理访问。

后台可独立启停 5H/1D/7D 三种 AI 次数配额，默认启用 5H 与 7D；支持用户独立覆盖与按用户/全站重置。每会话消息上限、每用户会话上限、群聊接话总数和深度、公告与审计保留期均在后台管理。

## 域名访问开发服务器

公开部署使用 `bun run build` 与 `bun run start`。如果需要通过域名访问 `bun run dev`，还必须在 `next.config.ts` 的 `allowedDevOrigins` 中添加具体主机名，例如 `chat.muyni.dpdns.org`（不要包含协议、端口或路径），并确认代理支持 WebSocket。开发资源或热更新被拦截时，页面可能停在「正在读取注册设置」或无法响应表单。后台「站点地址」不会修改这个 Next.js 开发白名单。

## 持久化与恢复

Docker 使用 `chatpony-data` 命名卷持久化数据库和加密主密钥。更新容器镜像不会清空卷。不要使用 `docker compose down -v`，除非明确要删除所有数据。

文件部署时，停止应用后备份整个 `data/` 目录；若使用 `--database-path` 或 `DATABASE_PATH`，应备份实际数据库所在目录及其 `application.key`。恢复时一并恢复数据库、主密钥和 WAL 文件；如果采用在线备份，使用 SQLite 备份 API 生成一致性数据库，再复制主密钥。限制目录读写权限，只允许应用进程及备份管理员访问。

不要把开发环境的测试数据库带到正式部署。测试脚本使用临时目录或 `data/verification/`，默认数据库仍保持空白初始化状态。

## 邮件

后台配置 SMTP 主机、端口、用户、密码、发件地址和站点地址。465 通常使用隐式 TLS；587 通常使用 STARTTLS。连接会验证服务器证书；不支持跳过证书验证。设置保存后可点击「发送测试邮件」向当前管理员邮箱发送。

首位管理员免邮箱验证；普通用户默认要求邮箱验证。未配置邮件时可以先完成管理后台设置，或明确关闭验证后开放注册。重置/验证令牌保存在数据库中的哈希值有效期有限，使用后失效。

## 运行边界

- 原生 SQLite 当前会在 Node.js 24 输出实验性 API 提示；这不是启动失败。使用项目要求的 Node 主版本，升级前运行验证。
- 仅支持一个部署实例。生成锁和限流使用同一 SQLite；多实例需要独立设计共享存储和任务队列。
- 流式回合总超时为 10 分钟，提供商另有请求超时及受限重试。代理超时不要低于应用设置。
- API Key、SMTP 密码只有服务端可以解密。UI 读取配置不会得到原始密钥；编辑时留空表示保留原值。
- 真实邮件投递、模型能力、费用与接口兼容性需要使用自己的服务商配置验收。仓库不会默认发起付费 API 请求。
