# ChatPony

以 My Little Pony 为主题的 RP 智能体对话平台，使用 **Next.js 16 + TypeScript + Bun + SQLite**。界面采用纸张、胶带、网格与柔和配色构成的手账视觉，支持桌面与移动端、键盘操作和减少动态效果设置。

系统初始不包含用户、角色、供应商或模型配置。管理员配置平台角色与模型服务；登录用户可在分配的槽位内创建仅自己可用的角色。项目不包含原创小马插画。

## 已实现的功能

- 单角色私聊、角色开场白、用户隔离的长期记忆与向量语义召回。
- 多角色群聊：普通消息只保存，`@角色标识` 或 `@角色名称` 触发回复；角色可以继续邀请其他角色，总回复数受会话与平台双重上限约束。
- 公开注册、可选注册邮箱验证与域名规则、密码登录、持久会话、个人资料、时区、修改密码、管理员角色和账号停用。
- 角色、供应商、多模型、公告、用户、限额与平台设置的管理界面。
- Anthropic Messages、OpenAI Completions、OpenAI Responses、Gemini Native 四种模型协议。
- 5 小时与 7 天的双重滚动调用限额、并发预占、失败返还、单用户或全员重置。
- 可配置日期、时间、星期、时区、农历、节气与节日元数据；按轮数触发上下文压缩和长期记忆总结，可选择语言模型生成语义摘要，或原文截取（不调用模型）。
- SSE 状态与消息推送、持久化幂等请求、失败重试、会话锁、请求取消及超时处理。
- 管理员统一设置气泡分隔符和仅在显示时隐藏的符号，保持原始消息与调用计数完整。
- 用户自设卡、头像上传与外链头像，自设卡可按需启用并作为用户的 RP 身份参考。
- 用户私有角色、角色头像上传、停用草稿，以及管理员配置的全局和单用户角色槽位。
- 管理员请求审查日志，覆盖角色调用、Embedding 与模型连接测试，可配置正文记录和保留时间。
- Argon2id 密码散列、HttpOnly 会话、JSON 写入与浏览器跨站请求检查、持久化请求频率限制及 AES-256-GCM 密钥加密。

## 本地启动

使用 **Bun 1.3.14** 或兼容版本。数据库依赖 `bun:sqlite`，服务端须由 Bun 运行；`package.json` 的开发、构建、生产命令已包含 `--bun`。

```sh
bun install --frozen-lockfile
```

复制环境配置。PowerShell：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

macOS / Linux：

```sh
cp .env.example .env
```

默认无需填写 `ENCRYPTION_KEY`，首次保存凭据时会在数据库旁生成持久密钥，开发和生产共用。仅在首次部署需要显式管理密钥时，可以生成并填入 `.env`：

```sh
bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```sh
bun run dev
```

打开 <http://localhost:3000>。另开一个终端创建管理员：

若 3000 端口已被其他应用使用，可使用 `bun run dev --port 3217`，访问 <http://localhost:3217>。

局域网开发可执行 `bun run dev:lan`，监听 `0.0.0.0:3218`，其他设备通过 `http://本机局域网IP:3218` 访问。开发资源会自动允许本机网卡地址，无需手动维护来源列表。普通 HTTP 下的消息编号与复制操作也提供了兼容处理。此命令不会修改系统防火墙。

```sh
bun run admin:create --email admin@example.com --name 管理员
```

脚本会安全地提示输入并确认密码，输入内容不会显示。密码长度为 10–128 个字符。已有邮箱不会被覆盖，也不会因为注册顺序自动获得管理员权限。

在非交互环境中，通过进程环境变量 `CHATPONY_ADMIN_PASSWORD` 提供密码，再执行同一命令；不要将密码放入命令行参数。该变量只供此脚本使用，不要保存在项目文件或容器镜像中。

首次登录管理员账号后：

1. 在「供应商与模型」添加供应商，配置 API 协议、基础地址和访问密钥，再为该供应商添加一个或多个模型，填写模型 ID 和生成参数，并进行连接测试。
2. 创建角色，填写人设、角色标识，关联已启用的模型并上架。
3. 在供应商下添加「向量模型」，再在长期记忆配置中选择该模型，启用向量检索。
4. 按需发布公告、调整注册开关和全局限额。

## 环境变量

| 变量                      | 用途                                  | 默认值 / 要求                                  |
| ------------------------- | ------------------------------------- | ---------------------------------------------- |
| `DATABASE_PATH`           | SQLite 数据库路径                     | `./data/chatpony.db`                           |
| `ENCRYPTION_KEY`          | 加密供应商、Embedding 与邮件凭据      | 可选；32 字节，支持 64 位十六进制或 Base64     |
| `TRUST_PROXY`             | 信任代理的客户端 IP 与 HTTPS 转发信息 | 默认 `false`；只在可信代理覆盖转发请求头时启用 |
| `CHATPONY_ADMIN_PASSWORD` | 非交互创建管理员的密码                | 只供管理员创建命令使用                         |
| `PORT`                    | Compose 暴露在宿主机回环地址上的端口  | `3000`                                         |

未设置 `ENCRYPTION_KEY` 时，所有运行模式均使用数据库所在目录的 `.encryption-key`，缺失时原子创建。开发切换到生产或进程重启不会更换密钥。请将它与数据库一起迁移和备份；已有文件损坏时会报错，不会覆盖。若改用环境变量，必须填入同一密钥的十六进制 / Base64 表示，随意更换会使已保存的凭据无法解密。

会话 Cookie 根据实际访问协议设置 `Secure`：HTTPS 使用安全 Cookie，HTTP 局域网访问也能保留会话。仅在 `TRUST_PROXY=true` 时接受代理的 `X-Forwarded-Proto: https`。无需配置固定访问域名：写入接口统一要求 `Content-Type: application/json`，并拒绝浏览器标记的 `Sec-Fetch-Site: cross-site` 请求；不要求或匹配 `Origin`。服务不会将 API 密钥、人设的私有配置或上游错误正文返回给普通用户。

## 用户自设卡与头像

每位用户可以在账户中保存一张自设卡，填写 RP 名称、种族、称谓、外观、性格与背景。卡片默认关闭，启用后作为用户扮演身份的参考资料进入对话；平台角色的人设和模型仍由管理员配置。名称与种族各最多 60 字，称谓最多 40 字，外观和性格各最多 1,500 字，背景最多 3,000 字，全文合计最多 6,000 字。模型提示词会按照可用上下文预算选取这些资料。

用户可以上传 JPEG、PNG、WebP 头像，原图不超过 2 MiB、1,600 万像素。服务端验证文件内容、裁切为 256×256、重新编码为 WebP，并移除 EXIF 等原始元数据。也可保存 HTTP / HTTPS 外链头像或清空头像。上传文件保存在数据库目录旁的 `avatars/` 中，Docker 部署会随数据卷持久保存。

自设卡和头像修改仅作用于当前账号。上传头像使用带随机 ID 的公开图片地址，替换时只清理该用户自己的旧文件；上传路径由服务端生成。

管理员创建或编辑角色时也可以直接上传头像，格式和大小限制相同。图片预览随角色表单一起保存，取消编辑不会创建角色或上传文件；保存失败会回滚角色变更并清理本次文件。

## 用户私有角色与槽位

登录后从「我的角色」创建和管理私有角色，可填写名称、简介、人设、开场白、标签与头像。头像可直接上传，保存整个角色表单时才提交；取消不会上传。角色标识由系统生成且保持稳定，用于群聊中的 `@`。已有「我的自设」仍表示用户自己的 RP 身份卡，和对话角色分开管理。

私有角色只供创建者使用，不进入公共角色广场；其他用户和匿名访问均不能通过猜测角色 ID 创建会话、修改角色或访问相关记忆。普通用户只能选择管理员已经启用的语言模型，接口不提供模型服务地址或凭据。无可用模型时可以保存停用草稿；可用角色能加入自己的私聊或群聊。

管理员在平台设置配置全局用户角色槽位，默认每人 3 个，范围 0–100；也可以在用户编辑中调整个人槽位。实际修改全局值会同步所有现有用户，并成为新注册用户的默认值；同值保存不覆盖个人调整。平台角色不占用户槽位，停用草稿仍占槽位，删除私有角色会释放槽位。降低上限不删除已有角色或历史，只限制新建；已有角色仍可编辑、删除和使用。删除角色后保留已有聊天记录，停止该角色后续响应。

## 注册邮箱验证与域名规则

邮箱验证码默认关闭，公开注册流程可直接使用。管理员可先在邮件设置保存 SMTP 主机、端口、连接方式、用户名、密码和发件信息，再在平台设置启用「注册需要邮箱验证」。SMTP 密码使用同一 `ENCRYPTION_KEY` 加密保存，接口只返回 `hasPassword`；编辑时省略 `password` 保留原值，空字符串清除。

SMTP 用户名和密码可留空，用于无需认证的内部中继。邮箱验证开启期间不能清空 SMTP 主机或发件邮箱；需要移除邮件配置时，先关闭注册邮箱验证。

SMTP 默认端口 587、`secure=false`、`requireTLS=true`，通过 STARTTLS 升级连接。使用隐式 TLS 的服务通常配置端口 465、`secure=true`。后台连接测试只验证 SMTP 连接与鉴权，不会发送测试邮件，也不保证发件地址已获服务商授权或邮件一定进入收件箱。具体连接参数见 [Nodemailer SMTP 文档](https://nodemailer.com/smtp)。

管理员可在「邮件验证」填写测试收件邮箱，点击「发送测试邮件」检查实际发信。这会发送一封不含验证码的测试邮件，不创建注册验证码。成功仅代表 SMTP 服务器已接受，请继续检查收件箱、垃圾邮件及服务商投递记录。

「邮件发送记录」分别记录连接测试、测试邮件与注册验证码操作，可按状态和参考编号查询。失败详情包括发生阶段、SMTP 返回码、增强状态码、脱敏服务器回复和处理建议；普通用户仅收到安全提示与参考编号，可提供给管理员查询。邮箱地址遮盖显示，不记录正文、密码、认证载荷或验证码。记录保留期沿用 `auditRetentionDays`（默认 7 天），超过 3 分钟仍无结果的操作标记为中断，不能据此断定未发信。该功能启用前没有保存的失败原因无法补查。

开启验证后，新用户先请求邮件中的 6 位数字验证码，再提交昵称、邮箱、密码与验证码注册。验证码有效期为 10 分钟，重发间隔至少 60 秒，每个验证码最多尝试 5 次。平台使用持久化的全局、客户端和邮箱频率限制；验证码只以带随机盐的散列保存，成功创建账号时才在同一事务消费，并将验证时间保存为 `emailVerifiedAt`。未验证注册、既有账号和 CLI 创建的管理员默认验证时间为空，既有账号登录不受新注册规则影响。

邮箱域名规则有「不限」「允许列表」「禁止列表」三种模式，默认不限。规则最多 100 项，保存时转为小写并将国际化域名规范化为 ASCII Punycode。例如 `例子.测试` 可直接输入。`example.com` 精确匹配该域；`*.example.com` 匹配其各层子域，根域需要单独添加。规则不隐式覆盖子域，不接受 URL、路径或端口。允许列表至少填写一项。发送验证码和最终提交注册都会检查当前规则。

修改注册策略不会追溯停用已注册账号。SMTP 配置、发信额度和投递结果由实际邮件服务决定；自动化测试只连接进程内的本地 SMTP fixture，不使用真实邮箱或公网邮件服务。

## 供应商与模型

模型配置分成两层：**供应商**保存 API 协议、基础地址、共享密钥和启用状态；每个供应商下可以添加**多个模型**，分别设置模型 ID、上下文窗口、输出上限、Temperature 和启用状态。角色绑定具体模型，同一供应商的模型统一使用供应商协议和连接配置。

模型注册表分为「语言模型」和「向量模型」。角色回复、上下文压缩与记忆总结只选择语言模型；语义检索只选择向量模型。语言模型可声明文本、图片、音频、文件能力，文本始终保留；这些是管理员维护的能力配置，当前聊天输入仍以文本为主，能力勾选不会自动开启附件上传功能。向量模型没有生成或思考参数。

语言模型还可配置思考等级，或为支持的协议设置 Token 思考预算，两者互斥。OpenAI 使用 `reasoning_effort` / Responses reasoning 参数；Anthropic 支持适用模型的 adaptive effort 或至少 1,024 tokens 的预算，Gemini 使用受模型版本限制的思考等级或预算。预算上限为 32,768，且必须小于最大输出；具体模型是否支持相关参数应通过连接测试确认。默认不发送额外思考配置。

模型可用须同时满足供应商和模型均启用。停用供应商会立即使其下的模型与关联角色暂不可用，恢复供应商后会沿用原模型开关。删除供应商会归档下属模型、下架关联角色，并保留已有会话历史；角色可重新绑定其他模型。删除一个模型不会删除其供应商或同级模型。

下表中的协议与基础地址都填写在供应商层：

| 后台协议           | 推荐基础地址                                       | 目标接口                          |
| ------------------ | -------------------------------------------------- | --------------------------------- |
| Anthropic Messages | `https://api.anthropic.com/v1`                     | `/messages`                       |
| OpenAI Completions | `https://api.openai.com/v1`                        | `/chat/completions`               |
| OpenAI Responses   | `https://api.openai.com/v1`                        | `/responses`                      |
| Gemini Native      | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:generateContent` |

支持兼容服务和本地服务。模型 ID 由管理员填写，不固定预置模型。OpenAI Completions 默认使用 Chat Completions；需要旧式文本 Completions 时，可将供应商地址设为以 `/completions` 结尾的完整接口地址。需要不同基础地址的连接应分别创建供应商。

地址只接受 HTTP / HTTPS，不接受内嵌用户名、密码、查询参数或片段。无须认证的本地服务可以不设置密钥。编辑供应商时留空保留已有密钥，使用清除开关可移除密钥；共享该供应商的模型会同时使用更新后的配置。模型不单独保存 URL 或 API 密钥。`temperature` 留空时不发送该参数；Anthropic 支持 0–1，其他协议可配置 0–2，最终能力取决于所用模型。

上下文窗口可配置 2,048–2,000,000 tokens，输出上限为 128–65,536，且不超过窗口的一半。Token 数通过保守估算控制，不是服务商 tokenizer 的精确计数。

连接测试会向实际配置的服务发送请求。自动化测试使用本地可控服务，不需要生产 API 密钥；仓库没有附带真实服务商凭据。

旧版数据库会自动迁移：每个旧模型配置生成一个供应商，原模型 ID、角色绑定和密文密钥保持可用，密钥随后只保存在供应商表。迁移在单个数据库事务中执行且可重复启动；后续可将多个模型调整到同一个供应商。升级前仍建议保留数据库与加密密钥备份。

如果旧版同一供应商包含不同协议的模型，升级会按协议拆分供应商并复制原连接配置，保留每个模型 ID 与角色绑定。旧的独立向量服务配置会迁移为一个供应商引用，沿用原加密密钥；空配置不会生成预置供应商。之后修改供应商协议会统一作用于其下全部模型。

旧向量配置随后会转换为注册表中的向量模型引用，即使已有语言模型使用同一个模型 ID，也会保留该语言模型和角色绑定，创建独立向量模型。将语言模型改为向量模型会下架其关联角色并清除维护模型引用；将已选向量模型改为语言模型会关闭对应向量配置。Anthropic 供应商下可保存停用的向量草稿，但不能启用。

## 对话与长期记忆

私聊的每条用户消息触发对应角色。群聊中，使用 `@标识` 或 `@名称` 邀请已加入会话的角色；建议在标识前后留空格。群聊轮数是**本次发送最多生成的角色回复条数**，包括用户首次点名和角色互相邀请，取会话上限与平台上限的较小值。平台允许 1–12 条，待响应队列会去重。

长期记忆按用户和角色隔离。Embedding 服务将保存的记忆与当前输入转换为真实向量，系统按余弦相似度选择相关内容注入角色上下文。向量保存在 SQLite 中，包含模型配置指纹与内容哈希；修改记忆或切换模型后，旧向量不会继续作为有效检索结果。

后台的 Embedding 配置选择注册表中的向量模型，并配置召回条数和相似度；模型 ID 来自该记录，协议、地址和密钥统一继承其供应商。支持连接测试与批量索引，用户只能重建自己的记忆索引。界面展示待索引、已索引、失败或未启用状态，手动笔记可编辑或删除。

| Embedding 协议    | 基础地址示例                                       | 请求方式                                              |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------- |
| OpenAI Compatible | `https://api.openai.com/v1`                        | `/embeddings`，批量发送文本，Bearer 鉴权              |
| Gemini Native     | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:embedContent`，`x-goog-api-key` 鉴权 |

Gemini 的记忆文本使用 `RETRIEVAL_DOCUMENT`，当前输入使用 `RETRIEVAL_QUERY`。须填写该服务实际支持的 **Embedding 模型 ID**，它与生成回复使用的模型配置相互独立。

向量配置复用供应商：OpenAI Completions / Responses 供应商派生为 OpenAI Compatible Embedding，Gemini 供应商派生为 Gemini Native。Anthropic 供应商不支持启用向量服务。修改供应商协议、地址或密钥会使旧向量待重新索引；停用或删除供应商会停止使用该服务发起向量请求。

默认召回相似度最高的 6 条，最低相似度为 0.3，可在后台配置。每次手动重建最多处理 16 条，接口返回 `indexed`、`failed`、`pending`；剩余记录可分批继续处理。OpenAI Compatible 会合并批量请求，Gemini Native 的批次并发最多为 4；向量请求有 12 秒总超时，索引预占会避免并发重复处理同一记忆。

自动记忆按管理员设置的间隔汇总成功回复，保存一条总结后尝试建立向量索引；完整原文始终保存在会话历史中。召回时还会顺带处理该用户与角色至多 8 条待索引记忆。Embedding 服务未启用或发生故障时，本轮跳过语义召回并展示状态，已保存的记忆可稍后重建索引，对话仍可继续。手动笔记作为有长度预算的固定参考独立提供，不依赖向量服务可用性。

若希望明确保存个人事实，可以单独发送一行：

```text
请记住：我喜欢薄荷茶。
记住：请叫我小星。
remember: my birthday is May 4
```

显式事实提取只接受有限的姓名、生日、喜好表达，每次最多 4 条；不会把普通 RP 台词推断为用户个人事实。手动记忆每位用户、每个角色最多 200 条；自动保存的对话片段不占该手动笔记上限。

### 压缩、记忆总结与元数据

`compressionTriggerRounds` 默认 24，按当前会话尚未压缩的**用户消息轮数**计算；达到阈值后整理较早历史，通常保留最近 `compressionKeepRounds` 轮（默认 8）。触发范围为 2–200，保留范围为 1–50 且须小于触发值。`compressionModelId` 留空使用原文截取；选择语言模型后，达到轮数或最终提示词接近上下文容量时均调用该模型。容量不足时可提前压缩并减少保留轮数。历史超过摘要模型单次容量时，从最早未处理消息分批总结，仅推进实际纳入的边界；单条过长时使用明确标注的首尾摘录。模型失败会提示并回退原文截取；最终请求仍受硬预算保护，临时摘录不会把尚待模型处理的历史误记为已总结，原始记录始终保留。

`automaticMemoryEnabled` 默认开启，关闭后暂停自动总结与显式事实的自动提取，已有记忆保留且仍可手动管理。`memorySummaryInterval` 默认 8、范围 1–100，按**同一用户与角色的成功回复条数**跨会话累计，开场白、失败回复不计入。达到间隔后固定这一批的事件上界；`memorySummaryModelId` 留空使用原文截取，选择语言模型则按其容量打包完整的用户与角色对话轮次，仅推进实际送入模型的游标。单轮过长时保留双方首尾并标明省略。每次成功回复最多处理一个摘要批段，尚未处理的批尾持久保留，后续成功回复会继续处理，无须重新攒满间隔；修改间隔只影响下一批，新增事件不会混入当前批。关闭开关暂停队列，重新开启后继续；删除原始对话会跳过已不存在的事件。总结失败不会推进游标，至少间隔 60 秒后可重试；进程中断后待租约失效即可续接，不会撤销已经保存的角色回复。

压缩和记忆总结使用语言模型时，会产生服务商请求，并分别记录为 `compression`、`memory-summary` 审查条目；它们不额外扣减用户的 5h / 7d 角色回复额度。删除被选模型或其供应商后，相应设置自动清空，后续使用本地摘录。

元数据可通过 `metadataEnabled` 整体关闭，或在 `metadataFields` 选择日期、时间、星期、时区、农历日期、当日节气、当前节气及节日。`metadataTimezone` 留空使用账号 IANA 时区，也可统一指定有效时区。`metadataCustom` 可附加最多 2,000 字纯文本，不执行模板表达式。日历数据来自 `lunar-javascript`，不是实时联网查询的法定调休安排。

## 限额与失败处理

### 消息展示规则

管理员可在平台设置中配置 `bubbleDelimiter` 和 `hiddenSymbols`。分隔符为空时使用默认气泡展示；配置后，界面按该字面字符串拆分消息气泡。`hiddenSymbols` 中的字面字符串仅在界面显示时被隐藏，不使用正则表达式。

分隔符最多 32 个字符；隐藏符号最多 20 项，每项 1–20 个字符。保存时保留空格等原始字符，清空分隔符和列表即可恢复默认规则。这些设置对平台用户统一生效。

气泡拆分不产生新的消息记录或模型调用。一条角色回复显示为多个气泡时仍只计一次角色调用；原始消息、发送给模型的上下文和向量索引内容保持不变。隐藏符号也不会删除存储的数据。

### 调用额度

初始全局限额为最近 **5 小时 50 次**、最近 **7 天 500 次**角色调用，两个条件须同时满足。管理员实际修改全局 5h 或 7d 限额后，系统会在同一事务中同步所有已有账号（含管理员和曾单独调整的账号）的该项限额；之后注册的用户也采用新值。只修改一项不会改变另一项。

单用户调整会持续有效，直到下一次实际修改对应的全局限额。保存其他设置或原样保存相同的全局数值，不会覆盖单用户调整。全局限额同步不清空已用次数、不修改额度重置时间，也不取消进行中的调用预占；调低限额后，已用额度达到新上限的用户须等待滚动窗口恢复，或由管理员另行重置。

- 每条成功保存的角色回复计 1 次，群聊中的多条回复分别计数。
- 发起调用时以数据库事务同时检查两个窗口并预占额度，进行中的调用同样占用额度。
- 未成功保存回复的调用释放预占；已经保存的部分群聊回复仍计数。
- 无人被 `@` 的群聊消息、开场白、摘要整理不消耗角色调用额度。
- 管理员重置会清除已完成的历史用量，保留正在进行的预占，防止并发绕过限额。
- 删除会话不会删除对应的调用记录或恢复额度。额度随每次调用离开滚动窗口逐笔恢复。

角色调用额度是平台规则。模型连接测试、Embedding 服务等实际外部请求可能产生服务商费用，请以服务商账单为准。

5h / 7d 额度只统计角色生成回复；Embedding 查询、索引、连接测试和配置为模型处理的压缩/记忆总结不计入这两个窗口，实际服务商请求可能产生费用。

每个会话同时只允许一次生成。租约包含心跳和过期恢复；崩溃遗留的预占可在后续请求中释放。模型超时、网络问题、认证失败、限流、无有效输出均会返回明确状态，用户原消息仍保留，不会生成假回复。

浏览器通过 **SSE** 接收 `user`、`status`、`message`、`error`、`done` 事件。每条角色回复完成后整体发送，当前版本不逐 token 推送。客户端取消会尝试中止上游请求；服务商可能已执行或计费的请求不由平台退款规则决定。

发送消息需带唯一 `requestId`。同一个 ID 与相同内容重复提交只会重放持久化结果，不再次扣费；同 ID 不同内容会被拒绝。真正重新生成时使用新的 `requestId` 并传入 `retryOf`：仅支持最近一条、尚未产生任何角色回复的失败消息，重用原用户消息，不重复插入。已经产生部分回复的群聊请发送新消息继续。

## 生产部署

本项目采用**单个持久服务实例 + 本地 SQLite 文件**。将数据库放在持久磁盘中，保留数据库旁的 WAL / SHM 文件；不适用于临时文件系统上的无状态函数或跨机器共享 SQLite 文件的部署方式。

非容器部署：

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

局域网生产访问可执行 `bun run start --hostname 0.0.0.0 --port 3210`，通过 `http://本机局域网IP:3210` 使用。普通 HTTP 登录可保留会话；无需更改固定 Origin 配置。

应使用进程管理器保持服务运行，并在前方配置 HTTPS 反向代理。Next.js 自托管和代理注意事项见 [Next.js 官方指南](https://nextjs.org/docs/app/guides/self-hosting)。

### Docker Compose

可在 `.env` 中配置端口与代理设置；留空加密密钥时使用数据卷中的持久密钥：

```dotenv
ENCRYPTION_KEY=
TRUST_PROXY=true
PORT=3000
```

`TRUST_PROXY=true` 的前提是入口代理覆盖 `X-Forwarded-For` 和 `X-Forwarded-Proto`，且外部无法绕过代理直接访问应用；直接访问时保持 `false`。Compose 只绑定宿主机 `127.0.0.1`，数据库和自动生成的加密密钥放在 `chatpony-data` 命名卷中，容器使用 Bun 非 root 用户。

```sh
docker compose up -d --build
docker compose exec chatpony bun scripts/create-admin.ts --email admin@example.com --name 管理员
docker compose logs -f chatpony
```

镜像固定使用 Bun 1.3.14，构建时安装锁定依赖，运行阶段仅保留生产依赖、构建产物和运维脚本。环境文件、数据库和本机依赖不会进入镜像。构建流程参考 [Bun Docker 官方指南](https://bun.com/guides/ecosystem/docker)。

Nginx 的 HTTPS `server` 块中可使用以下应用代理配置；证书由部署环境管理：

```nginx
location / {
    client_max_body_size 4m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
}
```

应用每 15 秒发送 SSE 心跳。关闭代理缓冲，让角色状态与完整消息及时送达。不要对 `/api` 缓存带会话的数据。配置外部代理时，以实际代理链为准处理客户端 IP。

### 备份与恢复

在线备份数据库：

```sh
bun scripts/backup.ts ./backups/chatpony-2026-10-11.db
```

容器中备份并导出：

```sh
docker compose exec chatpony bun scripts/backup.ts /app/data/backups/chatpony-2026-10-11.db
docker compose cp chatpony:/app/data/backups/chatpony-2026-10-11.db ./chatpony-2026-10-11.db
```

备份脚本通过 SQLite 读事务和 [Bun `serialize()`](https://bun.com/docs/runtime/sqlite#serialize) 获得包含已提交 WAL 数据的快照，保留消息 rowid，并执行完整性检查；已有目标文件不会被覆盖。序列化需要大致与数据库大小相当的额外内存。

同时备份实际使用的加密密钥：显式配置的 **`ENCRYPTION_KEY`**，或数据库目录的 **`.encryption-key`**。数据库中的 API 密钥是密文，数据库快照本身不足以恢复这些凭据。备份包含用户数据，应保存到受控位置。

数据库快照不包含头像文件。完整站点备份还需要复制数据库目录下的 **`avatars/`**（Docker 中为 `/app/data/avatars`）。为使头像与数据库引用一致，应先停止应用写入，再获取数据库快照并复制头像目录；恢复时将该目录放回数据库旁。

恢复时停止应用，将备份放到一个新的空数据目录，将 `DATABASE_PATH` 指向恢复后的文件，配置原加密密钥，再启动应用。不要把旧实例的 `-wal` / `-shm` 文件与恢复快照混合。容器恢复可使用新的命名卷或新的持久目录，确认可用后再切换入口。

不要直接复制运行中的单个 `.db` 文件作为完整备份。也不要对本项目数据库执行 `VACUUM` / `VACUUM INTO` 后直接替换原库：SQLite 可能重排未声明整数主键表的 rowid，而消息摘要边界依赖该顺序。关于 rowid 的行为见 [SQLite VACUUM 文档](https://www.sqlite.org/lang_vacuum.html)。

## 请求审查日志

后台请求审查页记录实际的角色模型请求、Embedding 请求、压缩、记忆总结与模型连接测试，展示用户、角色、供应商、模型、状态、耗时、上游返回的 Token 用量和脱敏错误。可按时间、用户、供应商和状态筛选，并查看请求详情与统计。仅管理员可访问这些接口。

默认只记录元数据。启用 `auditCaptureContent` 后，后续请求可记录经过脱敏、截断的请求与响应正文，每份最多 16 KiB；正文可能包含会话与记忆内容，管理员应按平台的实际运营需求配置。保留时间 `auditRetentionDays` 默认为 7 天，可选 1–90 天，过期记录在后续活动中分批清理。

日志按实际请求记录，重试、向量检索和索引都有各自的条目；5h / 7d 额度仍按成功保存的角色回复计算。日志写入失败不会使已完成的模型请求失败。

## 校验与项目结构

本轮生产环境问题、浏览器验收范围和复验方式见 [验收记录](VERIFICATION.md)。

```sh
bun run typecheck
bun test
bun run build
```

测试覆盖协议请求格式与错误处理、群聊队列边界、历史压缩与日历元数据、注册鉴权与数据隔离、密码验证并发竞态、真实 SQLite 限额事务、8 个独立进程争抢额度、重放/重试/取消与持久化、向量索引的用户隔离和失效处理，以及保留 rowid 的在线 WAL 备份。测试使用隔离数据库和本地测试服务，不会修改运行中的平台数据，也不会访问管理员配置的生产模型。

浏览器回归位于 `tests/browser-check.py`，使用 Python Playwright 和临时本地 HTTP 模型服务，覆盖注册、私聊/群聊、错误退款、向量记忆、Gemini Embedding、气泡分段、原文保留、导出及移动端。运行它之前，使用独立的 `DATABASE_PATH`、`NEXT_DIST_DIR` 和端口启动测试实例，并在**该测试数据库**创建管理员。通过 `CHATPONY_E2E_ADMIN_EMAIL` 和 `CHATPONY_E2E_ADMIN_PASSWORD` 提供该管理员凭据，然后执行：

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser-check.py --url http://localhost:3217
python tests/browser-mail-check.py --url http://localhost:3217
```

测试仅接受本地 URL，会临时创建供应商、模型、角色和测试用户，暂时调整测试实例的向量与展示配置并在结束后还原配置。请只对隔离测试实例运行；注册的测试用户及其记录会留在测试数据库。可用 `CHATPONY_CHROMIUM` 指定浏览器可执行文件。

`bun run format` 可统一格式，`bun run format:check` 仅检查格式。

邮箱浏览器回归会启动仅监听回环地址的 SMTP fixture，临时调整隔离实例的邮件与注册策略，验证验证码发送、域名限制、重发冷却、错误码与验证状态，不会向外部邮箱投递邮件。

```text
src/app/                    Next.js 页面与 API 路由
src/components/             用户界面与后台界面
src/lib/auth.ts             密码、会话、写入请求检查、请求频率限制
src/lib/mail.ts             SMTP 配置、连接验证与一次性注册验证码
src/lib/avatars.ts          用户头像验证、WebP 重编码与安全文件访问
src/lib/email-policy.ts     邮箱与域名规范化、注册域名规则
src/lib/audit.ts            请求审查日志、筛选与统计
src/lib/db.ts               SQLite 表结构与增量初始化
src/lib/repository.ts       权限范围内的数据操作与参数校验
src/lib/quota.ts            双窗口额度与调用预占
src/lib/chat.ts             SSE、会话租约、幂等与 RP 编排
src/lib/ai/protocols.ts     四协议适配
src/lib/ai/embeddings.ts    向量索引与语义召回
src/lib/ai/context.ts       上下文压缩与显式事实
src/lib/ai/maintenance.ts   按轮数执行历史压缩与持久化长期记忆总结
scripts/create-admin.ts    管理员创建
scripts/backup.ts          SQLite 在线快照备份
tests/                     单元及集成测试
```

## API 概览

普通接口返回 `{ "data": ... }`，错误返回 `{ "error": { "code": "...", "message": "..." } }`。所有写入接口要求 `Content-Type: application/json`，包括无请求体的退出、连接测试与重建索引；明确标记为 `Sec-Fetch-Site: cross-site` 的请求会被拒绝。接口不要求 `Origin`，也不返回跨域允许头。登录后通过 SameSite=Lax、HttpOnly 会话 Cookie 鉴权，服务端始终验证用户所有权或管理员权限。

| 路径                                                          | 方法                        | 用途                                                  |
| ------------------------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| `/api/bootstrap`                                              | GET                         | 首屏数据，允许访客                                    |
| `/api/auth/register`、`/api/auth/login`、`/api/auth/logout`   | POST                        | 注册、登录、退出                                      |
| `/api/account`                                                | PATCH                       | 修改昵称、时区、密码                                  |
| `/api/characters`、`/api/announcements`                       | GET                         | 可用角色（公共及本人私有）与已发布公告                |
| `/api/conversations`                                          | GET / POST                  | 我的会话 / 新建会话                                   |
| `/api/conversations/:id`                                      | GET / PATCH / DELETE        | 会话详情、设置、删除                                  |
| `/api/conversations/:id/messages`                             | POST                        | `{content, requestId, retryOf?}`，返回 SSE            |
| `/api/memories`、`/api/memories/:id`                          | GET / POST / PATCH / DELETE | 我的长期记忆                                          |
| `/api/memories/reindex`                                       | POST                        | 为本人记忆重新建立向量索引                            |
| `/api/quota`                                                  | GET                         | 两个滚动窗口的当前额度                                |
| `/api/admin/overview`                                         | GET                         | 平台统计                                              |
| `/api/admin/characters`、`/api/admin/announcements`           | GET / POST                  | 管理资源列表与创建                                    |
| `/api/admin/suppliers`                                        | GET / POST                  | 供应商列表与创建；协议、地址、密钥、启用状态          |
| `/api/admin/models`                                           | GET / POST                  | 模型列表与创建；所属供应商、模型 ID 和参数            |
| 上述管理资源的 `/:id`                                         | PATCH / DELETE              | 更新、删除                                            |
| `/api/admin/models/:id/test`                                  | POST                        | 使用所属供应商配置进行模型连接测试                    |
| `/api/admin/users`、`/api/admin/users/:id`                    | GET / PATCH                 | 用户列表、权限、停用、限额                            |
| `/api/admin/quotas/reset`                                     | POST                        | `{userId}` 重置个人；`{}` 重置全员                    |
| `/api/admin/settings`                                         | GET / PATCH                 | 注册开关、全局限额、轮数、简介、气泡分隔符与隐藏符号  |
| `/api/admin/embeddings`                                       | GET / PATCH                 | Embedding 供应商引用、模型 ID 与检索参数              |
| `/api/admin/embeddings/test`、`/api/admin/embeddings/reindex` | POST                        | 连接测试与全平台向量索引                              |
| `/api/auth/verification/send`                                 | POST                        | `{email}` 发送注册验证码；成功返回重发间隔及有效期    |
| `/api/admin/mail`                                             | GET / PATCH                 | SMTP 配置；密码只允许写入                             |
| `/api/admin/mail/test`                                        | POST                        | 仅验证 SMTP 连接与鉴权，不发送邮件                    |
| `/api/admin/mail/send-test`                                   | POST                        | `{email}` 向指定邮箱实际发送测试邮件                  |
| `/api/admin/mail/deliveries`                                  | GET                         | 邮件操作记录；支持 status、search、page、pageSize     |
| `/api/admin/requests`、`/api/admin/requests/:id`              | GET                         | 请求审查列表与详情                                    |
| `/api/admin/requests/stats`                                   | GET                         | 请求统计；period 支持 24h、7d、30d、all               |
| `/api/account/persona`                                        | GET / PATCH                 | 当前账号的 RP 自设卡                                  |
| `/api/account/avatar`                                         | POST                        | `{dataUrl}` 上传并替换当前账号头像，返回更新后的 User |
| `/api/account/characters`                                     | GET / POST                  | 本人角色、槽位与可选模型 / 创建私有角色               |
| `/api/account/characters/:id`                                 | PATCH / DELETE              | 编辑 / 删除本人私有角色                               |
| `/api/avatars/:filename`                                      | GET                         | 公开读取服务端重编码后的 WebP 头像                    |

开启注册邮箱验证时，`/api/auth/register` 的输入还需包含 `verificationCode`。平台设置接口同时支持 `requireEmailVerification`、`emailDomainMode`、`emailDomains`、`auditCaptureContent` 与 `auditRetentionDays`。

模型写入必须包含或保留 `supplierId`，支持 `kind`、`capabilities`、`reasoningEffort`、`thinkingBudget`；不接受 `protocol` / `baseUrl` / `apiKey`，这些连接信息都由供应商派生。`/api/admin/providers` 保留为 `/api/admin/models` 的兼容路径，使用相同输入结构。向量配置只允许写入 `enabled`、`modelId`、`topK`、`minSimilarity`，所选模型必须为 `embedding`，其余连接与模型信息只读。

头像上传使用 JSON，整个请求体上限为 3 MiB，解码后的原图上限为 2 MiB；其余 JSON 写入上限仍为 128 KiB。`PATCH /api/account` 可写外链头像或空字符串，修改昵称/时区时应省略服务端上传路径。

## 当前边界

平台包含本地账号和可选注册邮箱验证，尚未集成邮件找回密码或第三方登录。管理员创建脚本只创建新账号，不重置已有账号密码；如管理员忘记密码，可在服务器上使用另一邮箱创建新的管理员，再管理旧账号。

当前交付按单个持久 Bun 服务实例设计，向量检索在 SQLite 内保存向量并由服务端计算相似度。更大规模部署需要另行评估独立数据库、向量索引和任务队列。

真实服务商的模型兼容性与费用取决于实际配置；配置后请在后台执行连接测试。容器构建应在具有 Docker 的部署环境中执行并验证。
