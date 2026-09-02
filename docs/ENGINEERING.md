# Personal Copilot 工程与生产规约

## 1. 开发环境

要求 Node.js 24 或更高版本。项目不提供 Dockerfile。

```bash
npm install
cp .env.example .env
npm start
```

默认监听 `127.0.0.1:9093`。开发服务器使用 `.data/copilot.sqlite`、`.data/artifacts/` 与 `.data/copilot-session.secret`。不要把 `.data/` 用作测试 Fixture，也不要提交密钥。

## 2. 配置分层

| 配置 | 位置 | 是否可含供应商信息 |
|---|---|---|
| 产品身份 | `config/product.config.json` | 否 |
| Workflow 阶段 | `config/workflow.config.json` | 否 |
| 逻辑模型能力目录 | `config/model-catalog.config.json` | 否，只含选择模式、逻辑 ID、展示信息和能力 |
| Intent、Agent、Model Policy | `config/routing.config.json` 对应前三部分 | 否，使用逻辑 ID 与别名 |
| Deployment Profile | `config/routing.config.json.deploymentRouting` | 可以，属于基础设施边界 |
| Agent 与 Prompt | `agents/registry.json` | 不应绑定供应商 |
| 运行密钥与实际模型覆盖 | `.env` 或生产 Secret | 可以，不进入源码和浏览器 |
| 本地 Web 运行配置 | `.data/runtime-settings.json` | 可以，仅限受信任开发环境，权限必须为 `0600` |
| Eval | `evals/eval.config.json` | Judge 模型可显式声明 |

新增环境变量必须以职责前缀命名：`COPILOT_*`、`LLM_GATEWAY_*`、`WEB_SEARCH_*` 或标准 `LANGFUSE_*`，并同步 `.env.example`。

### 2.1 当前关键默认值

| 配置 | 默认值 | 说明 |
|---|---:|---|
| `COPILOT_HISTORY_TURNS` | 12 | 注入模型的最近会话轮数上限 |
| `COPILOT_MEMORY_RETENTION_DAYS` | 365 天 | 偏好、约束和明确记忆的默认有效期 |
| `COPILOT_MEMORY_PROFILE_RETENTION_DAYS` | 730 天 | 用户资料的默认有效期 |
| `COPILOT_MAX_ARTIFACT_BYTES` | 20 MiB | 单个上传文件上限 |
| `COPILOT_MAX_TURN_ATTACHMENT_BYTES` | 30 MiB | 单轮选中附件总量上限 |
| 单轮附件数量 | 10 | HTTP 契约固定值，Dataset 与测试同步约束 |
| `LLM_GATEWAY_INTENTION_MODEL` | `google/gemini-3.1-flash-lite` | Intention 独立默认模型 |
| `COPILOT_EVAL_JUDGE_MODEL` | `openai/gpt-4o` | 真实语义 Eval 的默认 Judge 覆盖；系统预设来自 `evals/eval.config.json` |
| `WEB_SEARCH_API_KEY` | 无 | Search 独立服务端凭证，不得回退到 LLM Gateway Key |
| `WEB_SEARCH_BASE_URL` | `https://search.onerouter.pro/v1/tavily` | Tavily-compatible Search 端点 |
| 回答模型目录 | `Auto` 与 15 个显式模型 | `model-router` 由应用 Router 解析，不映射到 Deployment |
| `COPILOT_ALLOW_WEB_CONFIGURATION` | 本地用户名开发模式开启 | 生产环境默认关闭 |

字节类环境变量使用十进制字符串表达字节数，文档中的 MiB 按 `1024 × 1024` 换算。改变默认值时应同步配置边界测试、`.env.example` 和产品说明。

## 3. 本地身份与生产身份

开发默认 `COPILOT_AUTH_MODE=local-username`：用户名经过 Unicode 归一化后映射为稳定内部用户 ID，签名 Cookie 只保存可验证身份声明。该模式无密码，只用于单机 MVP。

生产使用 `trusted-header`：

```dotenv
NODE_ENV=production
COPILOT_AUTH_MODE=trusted-header
COPILOT_TRUSTED_USER_HEADER=x-authenticated-user
COPILOT_TRUSTED_TENANT_HEADER=x-authenticated-tenant
COPILOT_SESSION_SECRET=at-least-32-random-characters
```

可信 Header 必须由同机反向代理或受控网关注入，并剥离客户端同名 Header。服务不得直接暴露到不可信网络。

### 3.1 首次配置与管理员边界

- 每个用户的首次向导状态按 `user_id + onboarding_version` 保存，升级向导版本可以重新触发必要配置确认。
- 实例配置是全局基础设施状态，不按用户复制。首个成功保存者通过事务认领本地配置管理员，避免任意用户互相覆盖凭证。
- `COPILOT_ALLOW_WEB_CONFIGURATION=true` 只允许用于受信任的本地用户名模式；生产必须设为 `false`，并通过环境或 Secret Manager 注入。
- Web 提交的 LLM、Judge、Search 与 Langfuse 设置只允许写入 `COPILOT_RUNTIME_CONFIG_PATH`；密钥不得进入 HTTP 响应、日志、Runtime Event、Trace、SQLite 或浏览器存储。
- 本地文件使用明文 JSON 和操作系统 `0600` 权限，不提供静态加密；共享主机或生产环境不能依赖这一机制。
- LLM、Judge 与 Search 可以在后续调用或 Eval 进程中生效；Langfuse Processor 需要重启。UI 必须呈现当前非敏感配置、系统预设和真实生效边界，不能显示虚假的“立即生效”。
- 完成向导必须通过真实最小 Completion；只检查字符串非空或 `/readyz` 不足以证明 Key、端点和模型组合可用。

## 4. 数据库与迁移

`database-migrations.mjs` 是 Schema 唯一事实源，迁移只允许前向、幂等且保留旧数据。启动时自动执行未应用迁移并记录到 `schema_migrations`。

变更步骤：

1. 增加新的顺序迁移，不修改已发布迁移内容。
2. 所有用户数据表包含明确所有权字段与索引。
3. 在 `test/database-migrations.test.mjs` 从旧 Schema 升级并检查旧表和数据。
4. 在生产执行前备份 SQLite 主文件；先优雅停机，确保 WAL 已收敛。
5. 不允许通过 UI 或测试访问另一用户的数据。

单实例可使用 SQLite WAL。多实例前必须迁移到共享事务数据库，并保持 Store API 与用户范围语义不变。

### 4.1 Eval Runner 进程边界

Web `Eval Runs` 通过 `eval-run-service.mjs` 启动独立 Node.js 子进程执行 `evals/run.mjs`，不得在 HTTP 请求栈内重新实现 Evaluator。子进程继承服务端运行配置，但命令行只接受经过服务端校验的 Profile、Dataset ID、输出路径和 Live 确认；用户输入不得拼接为 Shell 命令。stdout 与 stderr 必须先脱敏再保存，并限制累计长度。

优雅停止时先把本进程拥有的活动 Run 标记为取消，再终止子进程；下次启动把数据库中残留的 `queued`、`running` 转成明确失败。当前设计只适用于单实例本地 Runner。生产多实例必须使用带租约、重试与并发配额的持久任务队列，并保持 `eval_runs` 状态、用户隔离和重跑血缘语义不变。

## 5. HTTP 与外部请求

- 所有状态变更验证 Origin。
- 请求体、Prompt、并发、每分钟请求数和总执行时间均有限制。
- 附件上传使用原始二进制请求，必须校验登录用户、扩展名、MIME、请求大小和单轮总大小；文件内容不得出现在列表响应或应用日志。
- 外部请求必须带 `User-Agent`、`Accept`、`Connection` 与 Request ID。
- 上游重试只用于明确的瞬时失败；工具副作用不得盲目重试。
- 浏览器只可加载白名单静态文件，不能访问服务端源码或配置。
- 错误使用 `AppError`，HTTP 只返回安全消息、Code 和 Request ID。
- 凭证不得出现在日志、Trace、Runtime Event、JSON 响应或前端 Bundle。
- Setup 探测必须携带标准 `User-Agent`、`Accept`、`Connection` 和 Request ID，响应正文不得写入日志。

多模态上传进入生产环境前还必须补齐：文件 Magic Number 校验、恶意内容扫描、对象存储加密、保留与删除策略、下载审计和按租户容量配额。当前本地实现只验证扩展名、声明 MIME、大小和文本空字节，不应被描述成完整内容安全网关。

## 6. 路由与 Agent 变更

### 6.1 Routing

先修改 `config/routing.config.json` 和 `schemas/routing-config.schema.json`。Router 模块只实现通用选择算法，不能加入某个业务任务或 Provider 的硬编码判断。

每次变更至少增加：目标正例、容易混淆的反例、复合意图例和 Trace 关联断言。Model 与 Deployment 变化需要真实候选对比。

可选回答模型的增删先修改 `config/model-catalog.config.json` 与 `schemas/model-catalog.schema.json`，再补齐 Deployment Alias。前端不得增加同名常量。`selection-mode` 不得出现在 Deployment Alias；所有 `answer-model` 与 `control-model` 必须有映射。Intention 默认模型由 `LLM_GATEWAY_INTENTION_MODEL` 覆盖，未配置时使用 Deployment 中的 `intention-fast` 映射；用户选择不得传入 `role=intent`。

模型目录变更按以下顺序完成：

1. 在 Catalog 增删逻辑 ID、展示名称、供应方标签、模态和适用任务。
2. 在 Deployment Profile 中补齐逻辑别名到物理模型的映射；物理模型 ID 不进入前端。
3. 对新增模态补充请求内容块、上游兼容性和错误协议测试。
4. 更新 `core-model-selection-isolation-001` 或新增同等强度的正反 Case。
5. 运行真实小样本，分别观察 Intention Generation 与回答 Generation，禁止只验证最终文本。

`Auto` 策略变更还必须满足：Model Route 输出具体 `modelAlias`，候选排名、分数拆解、运行证据与选择原因可追溯，输入模态不兼容时只能在 Policy 候选内回退。对评分权重、最小观察数、EWMA、熔断或探索的修改必须新增正反单测、生成候选 Eval 并执行 `npm run eval:compare`。LLM Gateway 的 provider fallback 属于选定模型之后的基础设施容灾，不能代替应用侧模型选择。

### 6.2 Agent Registry

Agent ID 使用稳定小写蛇形命名。新增 Agent 必须同时满足：

- `agents/registry.json` 中有 Prompt 和能力。
- Root Agent 的 `routableAgentIds` 显式包含该 ID。
- Agent routing 只引用存在的 ID。
- 每个能力存在于 `capabilities/registry.mjs` 并有本地执行器。
- 能力协议模块不得导入数据库、网络、Store 或 Executor，也不得向调用方暴露可变 `Map`；Agent Registry 和 Executor 只通过只读查询接口消费协议。
- 有路由正反例、工具契约和真实小样本 Eval。

删除 Agent 时先删除所有路由、Dataset 和 Prompt 引用，禁止保留不可达配置。

## 7. 反馈与 Golden Set 运维

- 赞踩写入失败应向用户显示错误，不能只改变按钮样式。
- 反馈候选和 Gold 查询必须按当前 `user_id` 隔离。
- 点赞或点踩成功后必须同时存在 `eval_evidence_snapshots` 记录；其 Session 边界必须截止 `request_id` 对应 Turn，不能因后续对话变化。
- 候选列表只读取证据摘要；完整 Trace/Session 通过独立 Owner 受限端点延迟加载，避免大 Session 放大常规 API Payload。
- Golden JSONL 导出必须包含可校验的 `evidence`、内容 Hash 和来源 ID；密钥与 Base64 正文不得进入快照。
- 服务启动时会以有界批次补齐旧候选缺失的证据，`captured_at` 沿用原候选时间；该过程幂等，不改变反馈、审核状态或 Gold 标签。
- 候选列表默认只返回 `candidate`；拒绝后 UI 必须立即移除，`rejected` 仅能通过显式状态查询用于审计，且不得生成有效 Gold。
- 点踩批准必须有期望输出或 Failure Code。
- 重新评分必须撤销旧 Gold，避免陈旧真值继续参与回归。
- `.data/evals/` 是可变导出，不直接作为 CI 唯一输入。
- 进入长期 CI 的 Golden 快照必须分配新版本、代码 Review 并补充来源和审核信息。
- 生产环境应将审核 API 限制给 Reviewer；本地 MVP 的自审核不能直接照搬。

## 8. 可观测性

一轮对话使用一个稳定 Trace，`userId` 与 `sessionId` 用于归属和分组。Observation 名称保持低基数；实际模型、Profile、Policy 与错误放入结构化字段。

必须能从 Trace 回答：

- 输入属于哪个用户、Session 与 Request。
- 四层路由分别选择了什么，使用哪个配置版本。
- 调用了哪个模型、实际解析为哪个模型、Token 和完成原因是什么。
- 哪个 Agent 发起哪个 Tool，参数、结果和错误是什么。
- 是否触发重复、预算、无进展或超时保护。
- 长期记忆是写入、跳过、忘记还是失败。
- 本轮使用了哪些附件元数据，Runtime Trace 是否保持二进制脱敏。
- 最终回答和用户反馈对应哪条 Trace。

Tracing 是旁路能力。观测后端不可用不应破坏主回答，但必须留下本地诊断日志和同步状态。

## 9. 测试与发布

本地快速验证：

```bash
npm run check
npm test
npm run eval
```

提交前完整验证：

```bash
npm run verify
```

发布候选流程：

1. 固定代码、Routing、Registry、Dataset 与环境指纹。
2. 运行离线 CI Profile。
3. 对路由、Prompt 或模型变化运行真实代表性切片。
4. 需要语义判断时启用 Judge，并确认校准状态。
5. 与当前基线比较覆盖、阻断失败和诊断债务。
6. 完成人工 Spot Check 与 Web UI 登录、首次配置向导、账户配置入口、对话、记忆 CRUD、附件上传、模型切换、Trace、赞踩和 Golden 审核。
7. 优雅停止旧进程，备份数据库，启动候选并检查 `/healthz` 与 `/api/health/tracing`。
8. 通过后再更新发布基线。

## 10. 排障顺序

1. `/healthz` 的进程状态，以及 `/api/health/tracing` 的 Database、Tracing 与 Golden 状态。
2. 服务端 Request ID 对应日志。
3. 当前 Turn 的 Trace DAG 与四层路由 Span。
4. SQLite 中当前用户的 Session、Turn、反馈候选和 Gold 状态。
5. Deployment Profile 的 Base URL、实际模型和凭证是否配置。
6. 对应 Dataset 切片和候选 Eval 结果。

不得通过修改生产数据来“修复”代码缺陷，也不得用放宽 Eval 门禁代替根因修复。
