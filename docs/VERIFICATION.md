# 验证与回归

## 自动检查

安装 Node.js 24 和 Bun 1.3 后，在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
```

`bun test` 的协议适配、分片流、错误恢复与上下文测试使用本地响应。后端集成测试在 `.tmp/` 下的专用临时目录创建真实 SQLite，退出后自动清理。它们不访问付费模型或真实邮箱。

## 浏览器回归

以下脚本会创建测试用户、角色与聊天，必须使用**专用空数据库**。不要针对正在使用的数据库运行。全部脚本在项目根目录执行，使用 Python 3.10+ 和本机 Microsoft Edge。

PowerShell 中创建独立环境并启动 QA 服务器：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:DATABASE_PATH = 'data/verification/chatpony.sqlite'
bun run dev --port 3210
```

在第二个 PowerShell 终端依次运行：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
.\.venv\Scripts\python.exe tests/ui-admin.py bootstrap
.\.venv\Scripts\python.exe tests/ui-admin.py full
.\.venv\Scripts\python.exe tests/ui-account.py
.\.venv\Scripts\python.exe tests/ui-smoke.py
.\.venv\Scripts\python.exe tests/ui-display.py
.\.venv\Scripts\python.exe tests/ui-policy.py
.\.venv\Scripts\python.exe tests/ui-quota.py
.\.venv\Scripts\python.exe tests/ui-audit.py
.\.venv\Scripts\python.exe tests/ui-announcements.py
.\.venv\Scripts\python.exe tests/ui-users.py
.\.venv\Scripts\python.exe tests/ui-metadata.py
```

- `bootstrap` 只适用于全新 QA 数据库；创建首个管理员并保存随机测试凭据。
- `full` 配置临时角色和模型表单。模型保持停用，普通聊天使用带明确标记的本地演示模式。
- `ui-account` 覆盖普通注册、管理员权限、禁用、修改密码、旧会话撤销、账号注销和认证错误。
- `inspect-ui` 覆盖未登录跳转、下拉展开、键盘、弹窗嵌套、移动端与减少动态效果。
- `ui-smoke` 覆盖私聊、群聊提及、自由消息、记忆、导出和移动端布局。
- `ui-display` 在本机临时启动 SSE 模拟服务，验证分气泡、符号隐藏、流式半截符号、原文存储与显示导出，并在结束时还原设置和删除它创建的记录。
- `ui-policy` 验证配额与注册域名设置的实际保存、域名拒绝/允许注册、次数耗尽、普通群消息、个人覆盖与继承、三个窗口独立启停、群聊多角色单次计数、按用户/全站重置窗口及审计保留，并清理临时账户和还原站点设置。
- `ui-quota` 与 `ui-audit` 使用浏览器内隔离的响应数据检查配额与审计的边界状态、交互和移动端排版。
- `ui-announcements` 验证真实公告的草稿、发布、已读、更新后未读、撤回与删除，并清理其临时数据。
- `ui-users` 使用浏览器内 1005 人目录验证服务端分页、查找早期用户、权限与状态操作、重置用户检索、过期请求及错误恢复；写请求由测试响应拦截，不改动数据库。
- `ui-metadata` 验证日期/时间/历法字段选择、时区、未保存配置预览和移动端排版，结束时恢复原始设置。历法单元测试另覆盖春节、中秋、节气交接、跨日与夏令时。

测试凭据、浏览器登录状态和截图都写入已忽略的 `test-results/`。不要提交或公开这些文件。浏览器测试会改变同一 QA 数据库，按上面顺序执行，避免并行变更站点配置。

完整只读页面检查请在生产构建运行。停止开发 QA 服务器后，在一个终端启动相同的专用 QA 数据库：

```powershell
bun run build
bun run start --port 3211 --hostname 127.0.0.1 --database-path data/verification/chatpony.sqlite
```

在第二个终端运行：

```powershell
$env:CHATPONY_QA_URL = 'http://127.0.0.1:3211'
.\.venv\Scripts\python.exe tests/inspect-ui.py
Remove-Item Env:CHATPONY_QA_URL
```

当前 Next.js 16.3.8 / React 19.3.0 的开发模式，在匿名页面重定向时可触发框架内部 `flushComponentPerformance` 的负时间戳异常；页面权限控制仍正确。原测试保留严格的浏览器错误检查，不屏蔽这个异常。相同的全部交互在 standalone 生产模式已实测通过，且没有该异常。因此这里使用生产模式验收页面交互。

结束后停止 QA 服务器，在启动终端清除覆盖，再启动应用：

```powershell
Remove-Item Env:DATABASE_PATH
bun run dev --port 3210
```

默认 `data/chatpony.sqlite` 与测试数据库隔离；未创建过账号时，会从首位管理员注册开始。

## 需要自己的服务配置才能验证的项目

真实 API 连通性、模型回复质量、邮件送达和公网 HTTPS/反向代理应使用部署方自己的配置验收。Docker 构建与容器运行需要装有 Docker 的环境；本地 Next.js 构建通过不等同于容器已验收。

## 本次交付验证

2026-10-05：格式、ESLint、TypeScript、76 项自动测试及生产构建通过；自动测试另包含 484 项在独立 Node.js/SQLite 中执行的集成断言。浏览器覆盖账号、私聊与群聊、消息显示、可选配额与重置、域名限制、审计、公告、用户分页以及时间元数据。生产启动另完成 26 项 HTTP/资源/数据库路径检查，并验证浏览器真实登录、Secure Cookie、后台、公告和移动端；完整只读界面回归在生产模式通过，零浏览器脚本错误。
