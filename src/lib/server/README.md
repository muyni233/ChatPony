# ChatPony 服务端

运行时为 Node.js 24，Bun 负责依赖、构建命令和测试入口。Next Route Handler 位于 `src/app/api/[...path]/route.ts`，数据库使用 Node 原生 `node:sqlite`。首次访问自动建表，不写入角色、模型、用户或聊天示例。

## 初始化与持久化

- 首个成功注册的用户在 `BEGIN IMMEDIATE` 事务中成为管理员；并发注册不会产生第二个初始管理员。该账号直接通过邮箱验证。
- 后续注册默认需要验证邮箱。管理员先配置站点地址和 SMTP，或明确关闭邮箱验证；邮件未配置时注册会返回 `MAIL_NOT_CONFIGURED`，不会伪造发送成功。
- `allowedEmailDomains` 默认空数组，表示不限制注册邮箱域名。后台最多配置 64 个域名，规范化为小写 ASCII（支持 IDN）并去重，精确匹配，不自动允许子域名。不接受 `@`、通配符、协议、端口、路径、末尾点或 IP。首位管理员初始化豁免；只在后续注册时校验，既有登录、找回密码、邮箱修改与验证不受影响。域名策略在密码派生完成后的注册事务中重新读取。
- 所有业务配置保存于 `settings` 表，通过后台修改。无需配置环境变量中的模型、SMTP 或加密密钥。
- 默认数据位于 `data/chatpony.sqlite`。`DATABASE_PATH` 仅作为测试及特殊部署的数据目录覆盖选项。密码使用加盐 scrypt，数据库仅保存会话和邮件令牌的 SHA-256 摘要。
- 第一次保存服务密钥时，系统以独占写入方式创建同目录的 `application.key`；SMTP 密码与模型密钥使用 AES-256-GCM 加密。备份和恢复必须同时保留数据库及此主密钥，并限制目录读取权限。Windows 使用所在目录的访问控制；POSIX 创建文件权限为 `0600`。
- SQLite WAL 适用于持久本地磁盘。请勿把数据文件暴露为静态资源或放在无持久卷的临时文件系统中。生产站点使用 HTTPS，Cookie 在 production 模式附加 `Secure`。
- 可选的本地 `scripts/create-admin.ts` 用于管理员账号恢复；普通部署不需要运行。该工具要求交互式确认和隐藏密码输入，不预置密码。

## HTTP 约定

请求与响应为 JSON，SSE 消息接口除外。所有修改请求校验 `Origin`；后台配置的 `siteUrl` 为权威来源，尚未配置时按浏览器 `Host` 校验。错误为 `{ "error": { "message": "中文说明", "code": "STABLE_CODE" } }`。

公开读取：

| 接口                  | 返回                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/session`    | `{user, bootstrapRequired, site:{name,description,registrationEnabled,requireEmailVerification,allowedEmailDomains,bubbleSeparator,hiddenOutputMarkers}}` |
| `GET /api/characters` | `{characters}`，仅已发布角色                                                                                                                              |
| `GET /api/providers`  | `{providers}`，仅启用服务，`baseUrl` 为空、密钥从不返回                                                                                                   |

认证：

| 接口                                 | 请求与行为                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`            | `{username,email,password}`；直接登录返回 `{user}`，待验证返回 `{user:null,verificationRequired:true,message}` |
| `POST /api/auth/login`               | `{email,password}` → `{user}`                                                                                  |
| `POST /api/auth/logout`              | 注销当前会话并清理 Cookie                                                                                      |
| `PATCH /api/profile`                 | `{username?,email?,currentPassword?}`；改邮箱需要当前密码，验证新地址前旧邮箱继续有效                          |
| `POST /api/auth/password`            | `{currentPassword,newPassword}`；撤销所有旧会话及旧邮件令牌，为当前浏览器签发新会话                            |
| `POST /api/auth/forgot-password`     | `{email}`；通过 SMTP 发送 30 分钟有效重置链接                                                                  |
| `POST /api/auth/reset-password`      | `{token,password}`；一次性消费令牌并撤销会话和其他邮件令牌                                                     |
| `POST /api/auth/resend-verification` | `{email}`；重新发送 24 小时有效验证链接                                                                        |
| `POST /api/auth/verify-email`        | `{token}` → `{user}`；验证邮箱并签发会话，改邮箱时同时废除旧邮箱的重置令牌                                     |
| `DELETE /api/profile`                | `{password}`；删除普通用户及其个人数据，管理员须先由另一管理员调整权限                                         |

兼容别名：`PATCH /api/auth/profile`、`POST /api/auth/forgot`、`POST /api/auth/reset`。

账号相关资源全部按当前用户限定，不接受客户端传入 `userId`：

| 接口                                 | 请求或返回                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GET /api/quota`                     | `{fiveHour,oneDay,sevenDay}`；每个窗口包含 `{enabled,limit,used,reserved,remaining,resetsAt}` |
| `GET /api/conversations`             | `{conversations}`                                                                             |
| `POST /api/conversations`            | `{kind:'direct'                                                                               | 'group',characterIds,title?,scene?,providerId?}`→`{conversation}` |
| `GET /api/conversations/:id`         | `{conversation,messages,characters}`                                                          |
| `PATCH /api/conversations/:id`       | `{title?,scene?,providerId?}` → `{conversation}`；生成中不允许编辑                            |
| `DELETE /api/conversations/:id`      | `{ok:true}`；生成中不允许删除                                                                 |
| `GET /api/memories?characterId=...`  | `{memories}`，查询参数可省略                                                                  |
| `POST /api/memories`                 | `{characterId,content}` → `{memory}`                                                          |
| `PATCH /api/memories/:id`            | `{content}` → `{memory}`                                                                      |
| `DELETE /api/memories/:id`           | `{ok:true}`                                                                                   |
| `GET /api/favorites`                 | `{characterIds}`                                                                              |
| `POST /api/favorites`                | `{characterId}` → `{ok:true}`                                                                 |
| `DELETE /api/favorites/:characterId` | `{ok:true}`                                                                                   |

私聊包含 1 个角色，群聊包含 2–6 个角色。场景最多 4000 字符，单条记忆最多 2000 字符，每位用户对每个角色最多 50 条记忆。记忆显式保存、可编辑、跨会话保留；注入模型时按更新时间优先，并受上下文预算限制，不自动推断用户事实。

## 流式回复与群聊

`POST /api/conversations/:id/messages` 接受 `{content,characterId?,requestId?}`，返回 `text/event-stream`。`requestId` 建议由客户端生成并在重试时复用，长度 8–100，字符范围为字母、数字、`_` 和 `-`。

- 私聊正常触发唯一角色。群聊未指定角色、未 `@` 成员时，只持久化用户消息并发送 `user`、`done`，无需模型服务。
- 群聊 `@角色全名` 按出现顺序触发；名称前后需为空白、标点或文本边界，英文大小写不敏感。创建群聊与发言时均拒绝有歧义的同名成员。
- `characterId` 显式指定一个起始发言者。已有对话可用空 `content` 和指定角色续写，不保存虚构的用户消息。
- 角色回复中的 `@` 会把其他未安排的成员加入队列。每个角色每轮最多回复一次；后台的 `maxGroupReplies` 与 `maxGroupDepth` 分别限制总回复数和接力深度。不会无限互相触发。
- `user`、`start`、`delta`、`message`、`status` 为流式过程事件。只有 `done` 表示回合已原子持久化；`error` 或客户端中止时不保存本轮任何用户消息或角色残片。客户端应回滚本轮临时显示，并允许复用同一 `requestId` 重试。
- 已成功请求的相同 `requestId` 和输入直接重放结果；更换输入复用该标识返回 409。持久会话锁阻止并发生成，锁后重读上下文并再次检查幂等记录。
- 较早历史由 AI 模块按预算生成摘要，最近消息保持完整。摘要仅在回合成功时与消息一同提交，用户显式长期记忆单独保存。
- `bubbleSeparator` 默认 `|||`，用于提示模型在适当时把一次回复拆成多条即时聊天消息；空字符串关闭。分隔符最多 40 个输入字符，字面 `\n` 转换为真实换行，空格与换行原样保留，其他控制字符禁止。前端按此分隔符显示多个气泡；服务端仍把整条角色回复原文作为一条消息保存，SSE、幂等、回合事务及摘要逻辑不拆分。
- `hiddenOutputMarkers` 默认空数组，最多 16 个不同的纯文本标记，每个 1–80 字符且不含控制字符。标记按字面精确匹配，不支持正则；只在客户端显示时隐藏，不改写服务端输出、数据库或摘要输入，也不增加模型提示。
- 默认不开启演示回复；后台 `localDemoMode` 仅在非生产模式可启用，结果始终明确标注为未调用 AI 的固定模板。

## 滚动额度

- 默认启用 5 小时内 50 次、7 天内 500 次；可选的 1 天内 100 次默认停用。三个窗口通过 `quota5hEnabled` / `quota1dEnabled` / `quota7dEnabled` 独立启停，全部关闭时不限次数。窗口独立滚动，并非定时整体清零。一次用户触发的私聊回复、指定角色续写或整个群聊角色接力都只计一次；上下文压缩不额外计数。普通未提及角色的群聊消息不计数。
- `GET /api/quota` 只读取当前用户。`used` 是当前窗口及重置版本内成功提交的回合数，`reserved` 是正在处理的回合数。启用窗口的 `remaining = max(0, limit - used - reserved)`，停用窗口的 `remaining` / `resetsAt` 为 `null`，其历史和在途数量仍返回。`resetsAt` 是下一次额度释放的预计时间；窗口已阻塞时，表示足够接纳下一回合所需的释放时间，降额后可能晚于第一条记录的过期时间。没有用量或限额为 0 时为 `null`。在途回合完成后会更新这项预计时间。
- 开始生成前在 `BEGIN IMMEDIATE` 事务中检查全部已启用窗口并预留同一个额度，防止并行会话超额。成功额度与消息、摘要、幂等记录一起原子提交；失败或中止释放预留，不保存部分回合。已成功的幂等请求只重放，不重复扣额度。生成最多 10 分钟，进程崩溃后的预留 11 分钟失效，迟到回复不能再提交。
- 全局 `quota5h` / `quota1d` / `quota7d` 与用户同名覆盖均允许 0–1,000,000 的整数。用户的限额及 enabled 覆盖为 `null` 时继承全局值；只有启用且限额为 0 的窗口才暂停新 AI 回合，普通群聊消息仍可发送。修改限额、停用配额和删除聊天不会清除用量；全部停用时成功回合仍写账本以供重新启用后统计，审计 `quotaCharged` 为 0。已分配且未过期的预留可以正常完成；删除账号会删除其个人用量记录。
- `POST /api/admin/quotas/reset` 接受 `{scope:'all'|'user',userId?,window:'5h'|'1d'|'7d'|'all'}`，返回 `{windows,resetUsers,resetAt}`。事务内只递增所选用户和窗口的 epoch，不删除历史账本/请求审计，不清除其他窗口。活跃预留不会释放，成功提交时记录最新 epoch；重置前已完成的幂等请求仍仅重放，不重新记账。
- 超额在启动 SSE 前返回 HTTP 429 / `QUOTA_EXCEEDED`，并附中文说明。原 `maxDailyTurns` 不再生效；每用户每分钟最多 60 条消息、20 次 AI 尝试的防滥用限制继续保留。

## 管理接口

所有 `/api/admin/*` 接口均校验管理员角色；修改请求读完请求体后再次检查会话权限。

- `GET/POST /api/admin/characters`：`{characters}` / `{character}`；`PATCH/DELETE /api/admin/characters/:id`。已有会话的角色禁止物理删除，可取消发布。头像为可选站内静态路径，默认空。
- `GET/POST /api/admin/providers`：`{providers}` / `{provider}`；`PATCH/DELETE /api/admin/providers/:id`。协议值为 `anthropic`、`openai-chat`、`openai-responses`、`gemini`。`apiKey` 仅写，留空保留原密钥，读取只有 `hasApiKey`。
- `POST /api/admin/providers/:id/test`：发送小型实际模型请求并返回 `{ok,message}`，可能产生调用费用。
- `GET /api/admin/users?query=&page=1&pageSize=50`：`{users,total,page,pageSize}`，按昵称、邮箱或 ID 搜索，服务端分页，每页最多 100 人。用户包含 `emailVerified`、三种 `quota5h/quota1d/quota7d:number|null` 及同名 `Enabled:boolean|null` 覆盖；`PATCH /api/admin/users/:id` 接受上述限额/开关、`disabled` 和 `role`，省略字段保留现值。不能停用自己、撤销自己权限或移除最后一位管理员。
- `GET /api/admin/stats`：`{users,characters,conversations,messages,providers}` 数量。
- `GET /api/admin/audit`：仅管理员可读的 AI 请求元数据与统计。查询参数 `days`（1–365，默认 7）、`status`（六种状态之一或 `all`）、`query`（最多 100 字符）、`page`、`pageSize`（1–100，默认 20）。返回 `{entries:{items,total,page,pageSize},stats,filters,retentionDays}`；分页列表和统计使用相同筛选条件。
- `GET/PATCH /api/admin/settings`：`{settings}`；SMTP 密码只接受写入，读取为 `smtpHasPassword`。
- `POST /api/admin/settings/test-email`：使用已保存 SMTP 配置向当前管理员的邮箱发送测试邮件。

后台设置包括站点名称、说明、地址、公开注册、邮箱验证、SMTP 主机/端口/TLS/用户名/密码/发件人、私网 API 开关、开发演示开关，以及访问限制：

| 设置                                                   | 默认                | 范围                                                 |
| ------------------------------------------------------ | ------------------- | ---------------------------------------------------- |
| `quota5h`                                              | 50                  | 0–1000000；每用户 5 小时滚动额度，0 暂停             |
| `quota1d`                                              | 100                 | 0–1000000；每用户 24 小时滚动额度，启用且为 0 时暂停 |
| `quota7d`                                              | 500                 | 0–1000000；每用户 7 天滚动额度，0 暂停               |
| `quota5hEnabled` / `quota1dEnabled` / `quota7dEnabled` | true / false / true | 各窗口独立开关；用户可覆盖或继承                     |
| `maxMessagesPerConversation`                           | 2000                | 10–10000                                             |
| `maxConversationsPerUser`                              | 200                 | 1–1000                                               |
| `maxGroupReplies`                                      | 6                   | 1–12；每轮角色数仍受群聊实际成员限制                 |
| `maxGroupDepth`                                        | 3                   | 1–6                                                  |
| `auditRetentionDays`                                   | 90                  | 7–365；请求审计记录的保留天数                        |
| `trustProxy`                                           | false               | 仅当反向代理覆盖 `X-Forwarded-For` 时开启            |

未启用可信代理时，匿名端点采用较宽的全站桶与严格账号桶，避免低额度共享桶阻断公开注册；登录后另有按用户的发送频率与用量限制。SMTP 强制使用 TLS 或 STARTTLS，并验证证书；不提供跳过证书校验的开关。

## 请求审计与统计

- 只记录已认证、通过会话所有权校验的 AI 回合尝试，普通群聊消息不计入。状态为 `pending`、`success`、`error`、`cancelled`、`rejected`、`replayed`。额度不足、正在生成等启动前拒绝也会记录；重放不重复计算回复数、输出字符数或扣额。
- 元数据包含时间、用户 ID/名称、会话 ID/名称及类型、实际服务/协议/模型、参与角色、耗时、已完成回复数、输出字符数量、是否扣额、错误码及安全说明。没有邮箱、消息正文、人设、长期记忆、API 密钥或原始上游错误内容。字符数以 JavaScript 字符串长度计，不能据此推算模型令牌或费用。
- 成功审计与回合内容、额度在同一事务中提交，事务失败不能留下成功审计。失败条目可以包含已生成片段的字符数量，但不保存这些片段。统计中的回复总数只计成功请求，`chargedTurns` 只计实际成功扣额。
- 历史元数据按管理员配置保留，删除会话或账号不会连带删除审计快照。写入及查询审计时清理超期记录；超过 15 分钟仍为 `pending` 的遗留记录归为 `GENERATION_INTERRUPTED`，避免进程中断留下永久处理状态。每日统计按 UTC 日界线汇总，接口明确返回 `timeZone:'UTC'`。

## 验证

`bun test` 将路由编译后在独立 Node 24 进程和临时 SQLite 数据库内运行，覆盖首管理员并发初始化、来源校验、权限与数据隔离、加密密钥、角色提及接力上限、SSE 幂等与中止、邮件令牌的一次性消费及密码/邮箱变更的权限撤销，以及数据库迁移、三窗口启停组合、并发预留、重置范围及在途计数、失败退款、迟到回合拒绝、会话删除后的用量保留、注册域名策略、审计统计和公告权限/版本。测试中的模型为本机协议模拟服务；没有调用真实付费模型或声称验证 SMTP 实际投递。

## 公告接口

- `GET /api/announcements?page=1&pageSize=12`：需登录，仅返回已发布内容 `{items,total,page,pageSize,unreadCount}`；置顶优先，随后按发布时间倒序。每页最多 50 条。
- `GET /api/announcements/unread`：当前用户 `{unreadCount}`；`GET /api/announcements/:id` 返回 `{announcement}`。草稿、撤回与删除均返回 404。
- `POST /api/announcements/:id/read`：`{revision}`，仅可将自己读到的当前发布版本标已读；若版本变化返回 409。已读状态存储在数据库，跨设备有效。
- `GET/POST /api/admin/announcements`：管理员列表 / 新增。`PATCH/DELETE /api/admin/announcements/:id` 编辑 / 删除。字段为 `{title,body,status:'draft'|'published',pinned}`，PATCH 还必须提交读取到的 `revision`，避免覆盖其他管理员的新版本。
- 标题 1–120 字符，正文 1–12000 字符，最多 1000 条。纯文本换行，不执行 HTML；无默认公告。正文或发布状态等发生变化时递增版本，用户需要阅读新版本；无变化的保存不打扰已读用户。删除公告或账号时级联清理相应已读记录。

## 提示词元数据

站点设置 `promptMetadataEnabled` 默认 `false`，`promptTimezone` 默认 `Asia/Shanghai`。`promptIncludeDate`、`promptIncludeTime`、`promptIncludeWeekday`、`promptIncludeSolarTerm`、`promptIncludeHolidays` 默认 `true`，`promptIncludeLunarDate` 默认 `false`；它们仅在总开关开启时生效。时区需为运行环境支持的 IANA 名称，保存与预览使用同一校验。

`POST /api/admin/settings/preview-metadata` 接受上述设置子集，返回 `{text,generatedAt}`。仅管理员可用，读完请求体后再次验证会话，不保存设置、不调用模型。所有选项关闭或总开关关闭时 `text` 为空。

实际模型回合在开始时固定一个时间快照，计算一次片段并交给所有角色；日期、时间、星期使用指定时区，中国历法部分明确使用北京时间。片段仅拼入角色 system prompt，参与上下文预算，不直接写入消息、记忆或摘要请求。节日不代表法定假期与调休安排；角色扮演中明确设定的时间优先。
