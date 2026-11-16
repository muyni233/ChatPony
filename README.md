# ChatPony (Rust + Vue 3 + Vuetify 4 MD3)

ChatPony 采用 **Rust (`axum` + `rusqlite` + `tokio`)** 后端与 **Vue 3 + TypeScript + Vite + Vuetify 4 (`md3`)** 前端架构，全面兼容既有 SQLite Schema v14 与密钥/密码加密格式，无需迁移即可直接读取原有 `./data/chatpony.db`、`.encryption-key` 与头像目录。

## 项目结构

```text
chatpony/
├── backend/                 # Rust 服务端与 CLI 工具 (axum, rusqlite, reqwest, lettre, image, tyme4rs)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs          # HTTP API + 静态 SPA 服务入口
│   │   ├── bin/
│   │   │   ├── create_admin.rs
│   │   │   └── backup.rs
│   │   ├── ai/              # 四大协议适配 / LivingMemory / 上下文压缩 / 农历元数据 / 群聊 @点名
│   │   └── routes/          # 完整 REST + SSE 接口
│   └── tests/               # Rust 单元与端到端集成测试
├── frontend/                # Vue 3 + Pinia + Vue Router + Vuetify 4 (MD3)
│   ├── src/plugins/         # Vuetify 4 MD3 Blueprint + 浅色/深色主题配置
│   ├── src/components/      # 应用外壳、对话框与管理后台子面板
│   └── src/views/           # 全量 10 个路由页面 (含 9-Tab 管理后台)
├── Dockerfile
├── compose.yaml
└── .env.example
```

## 本地开发与构建

### 1. 构建前端静态资源

```bash
cd frontend
bun install
bun run typecheck
bun run test
bun run build
```

### 2. 运行与测试 Rust 后端（建议在仓库根目录执行，以匹配 `.env` 相对路径）

```bash
cargo test --manifest-path backend/Cargo.toml
cargo run --manifest-path backend/Cargo.toml --bin chatpony
```

管理员创建与在线备份工具：

```bash
cargo run --manifest-path backend/Cargo.toml --bin create-admin -- --email admin@example.com --name Admin
cargo run --manifest-path backend/Cargo.toml --bin backup -- --dest ./backups
```

### 3. 开发热重载（双终端）

```bash
# 终端 1：Rust API 服务
bun run dev:backend

# 终端 2：Vite 前端开发服务（/api 代理至后端端口）
bun run dev:frontend
```

当 `frontend/dist` 已构建后，`chatpony` 进程会在单一端口上同时托管 `/api/*` 接口与前端 SPA 页面（默认读取 `DATABASE_PATH=./data/chatpony.db` 与 `CHATPONY_STATIC_DIR=./frontend/dist`）。

## 核心特性

- **四协议原生支持**：`openai-completions`（含兼容 `/completions`）、`openai-responses`、`anthropic`（含 Thinking Budget）、`gemini`（含原生流式与 `embedContent` 向量），支持多模态识图、思考强度配置与上游失败自动重试。
- **LivingMemory 长效记忆**：SQLite FTS5 trigram 中文检索 + 双字词模糊召回 + 语义向量余弦融合 + MMR 多样性去重 + 时间衰减归档，并支持“记住：…”显式指令与结构化抽取。
- **Vuetify 4 MD3 界面**：基于官方 Vuetify 4 Material Design 3 蓝图，以鼠尾草绿（`#2B594F`）与暖灰白 / 深咖双主题构建界面，支持主题即时切换与动作描写斜体排版。
- **完整隔离与安全防护**：Argon2id（`m=19456,t=2,p=1`）口令哈希、AES-256-GCM 密钥与 SMTP 密码加密、HttpOnly Cookie、双滑动窗口并发额度锁（5 小时 / 7 天）、私有自设角色及头像隔离、脱敏请求审计日志。
