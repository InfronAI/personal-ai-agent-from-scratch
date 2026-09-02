# Personal Copilot 工程执行约束

本文件适用于当前项目目录下的全部变更。开始修改前，先阅读 `docs/README.md`；变更行为时必须同时维护配置、Eval 与文档。

## 1. 事实源优先级

发生冲突时按下表从上到下裁决，并在同一变更中修正所有低优先级材料。任何行为结论都必须能定位到一个明确文件、数据库字段或运行证据，不能只依赖口头约定。

| 优先级 | 事实类型 | 唯一定义位置 | 用途与约束 |
|---:|---|---|---|
| 1 | 已批准的产品目标与架构决策 | `config/product.config.json`、`docs/DECISIONS.md` | 定义产品身份、范围、不可逆决策和验收边界；新决策先记录再实现 |
| 2 | 人工确认的质量真值与发布门禁 | `evals/eval.config.json`、`evals/datasets/*.jsonl`、`evals/schemas/*.json`、`evals/evaluators/judges.v1.json`、`evals/baselines/current.json` | 定义 Dataset 目录与五类专业维度、Evaluator、Profile、阈值和基线；不得在代码中复制门禁 |
| 3 | 用户反馈与用户级运行状态 | SQLite 表 `eval_feedback_candidates`、`eval_evidence_snapshots`、`eval_golden_items`、`eval_runs`、`user_onboarding`；表结构位于 `database-migrations.mjs`；反馈实现位于 `feedback-store.mjs`、`evaluation-evidence-store.mjs`、`golden-set-store.mjs`；Eval Run 实现位于 `eval-run-store.mjs`、`eval-run-service.mjs`；统一 Dataset 目录位于 `eval-dataset-catalog.mjs`；导出规则位于 `evals/eval.config.json` 的 `goldenSet` | 原始赞踩只是 Turn 级候选；每次反馈必须保存完整目标 Trace 和截止该 Turn 的 Session 时间点快照；默认候选队列只返回 `candidate`，拒绝项仅作审计；只有 `human-reviewed` 且 `approved` 的样本才是真值；有效 Gold 可无损归档和恢复；Eval Run、重跑血缘、结果和日志按用户隔离；首次配置完成状态必须按用户和版本隔离 |
| 4 | 可执行工作流配置 | `config/workflow.config.json`、`config/routing.config.json`、`config/model-catalog.config.json`、`agents/registry.json`、`capabilities/registry.mjs` | 分别定义阶段、四层路由、可选回答模型、Agent/Prompt、能力 Schema；修改系统行为优先改这里 |
| 5 | 配置协议 | `schemas/workflow-config.schema.json`、`schemas/routing-config.schema.json`、`schemas/model-catalog.schema.json`、`schemas/agent-registry.schema.json`、`schemas/product-config.schema.json`、`evals/schemas/*.json` | 约束配置和数据的合法形状；协议变化必须升版并提供前向迁移 |
| 6 | 真实运行数据与可观测证据 | SQLite 路径由 `COPILOT_DATABASE_PATH` 定义；运行事件协议位于 `runtime-events.mjs`；Trace 导出位于 `observability.mjs`、`langfuse-client.mjs` | 用于验证实际发生了什么；不得用 Mock 或文档描述冒充真实运行事实 |
| 7 | 实现代码 | `routing/`、`agent-runtime.mjs`、`capabilities/executor.mjs`、各 Store 与 `server.mjs` | 必须执行上述配置，不得内嵌第二套路由、Agent 或 Eval 规则 |
| 8 | 说明与界面文案 | `docs/*.md`、`README.md`、`app.js`、`index.html` | 只解释或呈现系统，不得成为隐藏事实源 |

冲突处理规则：用户新验收条件高于当前仓库状态；先更新产品决策或配置，再补 Eval，最后修改代码。若运行数据与预期不一致，以运行数据定位缺陷，但不能用偶发运行结果改写产品目标。模型生成标签、Judge 输出和赞踩记录都不是天然真值，必须保留来源与审核状态。

## 2. 数据驱动与 Eval 驱动

- 行为变更先定义失败模式、目标切片和可观测证据，再增加正例与至少一个反例。
- 确定性契约优先使用代码 Evaluator；语义质量才使用版本化 Strict JSON Judge。
- 全局平均分不能掩盖高风险、实时检索、多轮、记忆、工具、副作用和用户隔离切片的回退。
- 内置 Dataset 必须覆盖通用知识、垂直能力、性能与韧性、安全合规、Agent 通用能力和产品契约，并按领域、能力、难度、交互形态与决策用途切片。
- 默认 Eval 只能使用版本化 Dataset、临时数据库和注入式依赖；不得访问真实 `.data/`。
- 真实模型、搜索或远端实验必须显式使用 `--confirm-live`。
- 所有候选改动必须通过 `npm run verify`；路由、Prompt、模型或 Deployment 变化还要生成候选结果并执行 `npm run eval:compare`。

## 3. 四层路由边界

- Intent routing 只判断任务域、任务类型、风险、约束、实时性和所需能力，定义于 `config/routing.config.json.intentRouting`。
- Agent routing 只选择 `direct`、`continue` 或一个已注册 Agent，定义于 `config/routing.config.json.agentRouting`，目标必须存在于 `agents/registry.json`。
- Model routing 只选择逻辑模型别名与推理参数，定义于 `config/routing.config.json.modelRouting`。
- Deployment routing 只把逻辑别名或工具工作负载解析到端点、实际模型和凭证引用，定义于 `config/routing.config.json.deploymentRouting`。
- 四层必须分别产生带版本的 Trace Span；任何一层不得读取或复制另一层的规则。
- 用户选择只作用于直接回答或 Specialist Generation；Intention Layer 必须使用 `intent-fast` Policy，默认物理模型由 Deployment 配置解析。`model-router` 是应用 Model Router 的默认选择模式，不得作为 Deployment Alias 或上游模型 ID。
- Model Router 的硬过滤、评分权重、观察阈值、EWMA、熔断和探索全部定义于 `config/routing.config.json.modelRouting`；运行调用结果只能通过 `routing/model-router.mjs.observe()` 更新证据，不能在 Agent 内复制选择逻辑。
- Provider 名称、物理模型 ID、Base URL 与凭证只允许出现在 Deployment 配置、服务端环境或真实 Trace 中，不能成为产品概念或前端常量。
- LLM 与 Search 必须使用独立的 Base URL 和凭证引用；Search 只允许读取 `WEB_SEARCH_API_KEY`，不得隐式回退到 `LLM_GATEWAY_API_KEY`。两者可由部署者显式填写相同值，但配置与审计边界必须分离。

## 4. 运行不变量

- 身份、会话历史、Request ID 幂等和 Session 授权由服务端维护，不信任客户端提交的用户 ID 或完整历史。
- 每次“新建对话”立即分配新的 Session ID，第一轮成功后由服务端持久化；任何请求不得漂移到旧 Session。
- Session 删除必须验证 Origin 与 Owner，并在 Session 锁内清理本地 Turn、反馈候选、评估证据快照和 Gold；长期记忆和外部 Trace 使用各自独立删除策略，UI 必须明确边界。
- `GET /api/sessions` 与 SQLite 是历史 Session 的权威来源；浏览器缓存只能保存轻量、可丢失投影。缓存读取、配额或写入失败不得阻断左栏水合或删除后的界面更新；零 Turn 的 `serverBacked` Session 仍必须调用服务端删除端点。
- 本地用户名登录是单机 MVP；所有数据表和查询必须以服务端签发的内部 `user_id` 隔离。
- 首次登录必须读取版本化 Setup 状态；只有真实模型探测通过后才能标记完成。实例配置管理员与用户完成状态不得混为一体。
- Web 保存的 API Key 只能进入权限为 `0600` 的本地运行配置，严禁进入响应、日志、SQLite、浏览器存储或 Trace；生产环境必须关闭 Web 配置。
- Agent 只能调用能力协议中存在且具备执行器的工具；`capabilities/registry.mjs` 必须保持无 I/O 的纯协议模块且不得暴露可变 Registry；未知 Agent 和非法参数必须在执行前拒绝。
- 一轮最多委派一个 Agent；工具调用受总次数、重复签名、无进展次数、超时和 Payload 上限保护。
- Tool Span 与 Agent Span 必须挂在真实父节点下；Trace 记录路由决策、模型、参数、结果与错误，但不得记录密钥。
- Langfuse/OpenTelemetry 必须由 `instrumentation.mjs` 在业务模块前初始化；首次向导只允许保存成对项目密钥、可修改 Base URL 与 Environment，并明确新配置需要重启。
- 长期记忆只保存用户来源、可复用、非敏感的信息；回答失败不能阻断在记忆旁路上。
- 上传附件必须按当前用户隔离、校验类型与大小；模型请求可短暂包含二进制内容，数据库、应用 Runtime Trace 和 HTTP 列表只能保存非敏感元数据。
- 用户赞踩必须先写入反馈、不可变评估证据快照与候选池。反馈 Subject 是具体 Turn；快照必须包含该 Turn 的完整本地 Trace 和仅截止该 Turn 的 Session 前缀，不得包含未来消息、密钥或二进制正文。拒绝后必须从默认待审队列移除但保留审计状态；重新评分会撤销原有 Gold 并重新等待审核；归档只能改变有效性，不能删除版本和证据。
- Eval Dataset 与 Eval Run 必须保持独立：Dataset 定义测试数据，Run 冻结 Profile 与 Dataset 范围并保存执行结果。Run 必须按用户隔离；真实 Profile 启动前要求明确确认；运行日志必须脱敏；重跑必须创建带父 Run ID 的新记录，不能覆盖历史结果；服务重启必须把遗留执行标记为可诊断终态。
- Web UI 固定产品文案必须使用英文，页面语言声明为 `en`；用户输入、模型输出、记忆、文件名与历史业务数据保持原始语言。中文服务端错误不得直接透传到界面。
- `.data/` 是真实状态。测试只能使用临时 SQLite、临时 Artifact 目录或注入依赖。
- 生产路径不得加入 Mock；模拟器只能位于 `test/` 或 `evals/`，并标明来源。

## 5. 模块职责

| 职责 | 允许位置 |
|---|---|
| 产品与工作流配置 | `config/` |
| 可选回答模型目录 | `config/model-catalog.config.json`、`model-catalog.mjs` |
| 四层路由算法 | `routing/` |
| Agent Prompt 与路由白名单 | `agents/registry.json`、`agents/registry.mjs` |
| 能力协议与执行 | `capabilities/registry.mjs`（纯 Schema、版本、校验）、`capabilities/executor.mjs`（I/O 适配与分发） |
| 单轮编排 | `agent-runtime.mjs`、`harness-controller.mjs` |
| LLM 与搜索协议适配 | `llm-gateway.mjs`、`web-search.mjs`、`http-client.mjs` |
| 数据持久化 | `database-migrations.mjs`、各 `*-store.mjs` |
| HTTP 与身份 | `server.mjs`、`identity.mjs`、`user-store.mjs` |
| 首次配置与运行设置 | `setup-service.mjs`、`onboarding-store.mjs`、`runtime-settings.mjs` |
| 前端网络与 Trace 协议 | `src/web/`；`app.js` 只负责产品交互与呈现 |
| Eval 配置、数据与执行 | `evals/`；服务端 Dataset 投影位于 `eval-dataset-catalog.mjs`；Run 状态与执行位于 `eval-run-store.mjs`、`eval-run-service.mjs`；Web 工作台位于 `app.js` 的 `Eval Datasets` 与 `Eval Runs` 视图 |

不得保留旧名称模块作为兼容副本。新增环境变量必须同步更新 `.env.example`；新增公开函数、数据库迁移或协议必须增加契约测试。

## 6. 中文文档与注释

- 项目文档、代码注释、配置示例注释和决策记录使用中文。
- Web UI 固定产品文案是明确例外，必须使用英文；不得为了满足中文文档约束而把中文产品文案写回前端。
- API 字段、代码标识符、模型 ID、协议名和必要技术术语保留原文。
- Prompt 是版本化运行资产，可按目标语言编写，但不得承载未进入配置或决策记录的隐藏产品规则。
- 运行 `npm run docs:check` 检查中文说明、注释、本地链接，以及 Dataset 数量、模型目录、Intention 默认模型和环境示例等派生事实。

## 7. 最低验证

| 变更 | 最低验证 |
|---|---|
| Intent 或 Agent routing | 正例、复合意图、反例、未知 Agent、Trace 关联与全量 Eval |
| Model 或 Deployment routing | 硬约束、混合评分、真实观察、熔断恢复、Policy/Profile 选择、凭证不泄漏、LLM 与 Search 执行证据、候选对比 |
| Agent Registry 或 Prompt | Schema、能力一致性、可达性、路由切片、真实小样本 Eval |
| Dataset、反馈与 Golden Set | 配置化专业维度与数量、输入脱敏、赞踩幂等、用户隔离、目标 Trace 完整性、Session 时间点边界、审核门禁、有效/归档/恢复、重新评分撤销、自包含导出可校验 |
| Eval Run 生命周期 | Draft、Queued、Running 与全部终态转换、Profile 与 Dataset 校验、用户隔离、真实调用确认、取消、重启恢复、日志脱敏、结果投影、归档恢复和重跑血缘 |
| 记忆 | 用户隔离、敏感拒绝、冲突取代、有效期、禁用、忘记与旁路故障 |
| 模型目录或用户选择 | 服务端目录、未知 ID 拒绝、能力声明、Intention 隔离、Direct 与 Specialist 解析 |
| 多模态附件 | 类型与大小、用户隔离、模型内容块、能力不匹配、Trace 脱敏与会话恢复 |
| HTTP、身份或 Session | API 集成、Origin、所有权、幂等、取消、新建、零 Turn 删除、首次水合、缓存配额失败与删除后不复活 |
| 首次配置 | 首次弹窗、向导版本、管理员认领、真实探测失败保持未完成、LLM/Search/Langfuse 密钥脱敏、Search 独立凭证引用、文件权限、重启语义和生产禁用 |
| 数据库 | 旧库前向迁移、表与索引、所有权范围、备份和回退说明 |
| 前端 | DOM 测试、真实 API 契约、无演示数据、可访问状态与错误反馈、英文固定文案静态门禁、中文后端错误不透传 |

## 8. 完成定义

只有代码、配置、Dataset、基线、中文文档和 Trace 证据一致，`npm run verify` 全部通过，且没有新增未评审诊断债务时，任务才算完成。
