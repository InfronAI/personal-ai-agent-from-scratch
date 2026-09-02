# Personal Copilot 系统化 Eval

## 1. 目标

Eval 不是一个总分，而是对产品契约、路由决策、任务质量和运行健康的分层验证。每次变更至少回答：

1. Intent 是否保留了任务、风险、约束、实时性和能力需求？
2. Agent 是否选择正确执行模式与合法目标？
3. Model Policy 是否适合角色和风险？
4. Deployment 是否选择正确端点且不泄漏凭证？
5. Agent、Tool、Memory、Artifact 和 Trace 是否按契约运行？
6. 最终回答是否完成用户任务？
7. 用户反馈对应的失败模式是否在候选版本中被修复，且没有造成其他切片回退？
8. 首次登录是否在真实验证前保持未完成，且密钥和实例配置权限没有越界？

## 2. 唯一配置与协议

| 内容 | 定义位置 |
|---|---|
| Dataset、Profile、Judge、门禁、Golden 导出和 Langfuse 实验 | `evals/eval.config.json` |
| Eval 配置 Schema | `evals/schemas/eval-config.schema.json` |
| 数据项 Schema | `evals/schemas/eval-item.schema.json` |
| 运行结果 Schema | `evals/schemas/eval-result.schema.json` |
| 人工标注 Schema | `evals/schemas/human-annotation.schema.json` |
| Judge Catalog | `evals/evaluators/judges.v1.json` |
| Benchmark 方法目录 | `evals/benchmarks/catalog.v1.json` |
| 当前发布基线 | `evals/baselines/current.json`、`evals/baselines/current.md` |
| 反馈、运行证据与 Gold | SQLite 表和 `feedback-store.mjs`、`evaluation-evidence-store.mjs`、`golden-set-store.mjs` |

任何阈值、Dataset 或 Evaluator 变化必须修改配置并进入版本控制，不能只通过命令行或环境变量长期漂移。

## 3. 数据集

当前仓库固定数据集共 140 个场景，分布于 18 个版本化数据集；其中 80 个场景按 27 个公开 Benchmark 的能力定义和评分思想重新设计，题目、上下文与期望结果均为项目原创。69 个不依赖离线 fixture 的 Case 标记为可真实调用：

| Dataset | 场景数 | 专业维度 | 重点 |
|---|---:|---|---|
| `evals/datasets/copilot-core.v3.jsonl` | 19 | 产品契约 | 路由、搜索、跨 Session 记忆、Artifact、多模态、模型选择、文档与输出协议 |
| `evals/datasets/copilot-multiturn.v3.jsonl` | 5 | Agent 通用能力 | History、指代、纠正、语言切换与 Session 连续性 |
| `evals/datasets/copilot-adversarial.v3.jsonl` | 10 | 安全合规 | 非法 Agent、重复副作用、无进展、预算、恢复、安全与策略覆盖 |
| `evals/datasets/copilot-general-knowledge.v1.jsonl` | 5 | 通用知识 | 数学、概率、科学、历史因果与受约束语言转换 |
| `evals/datasets/copilot-vertical-capabilities.v1.jsonl` | 6 | 垂直场景能力 | 医疗、分布式系统、金融研究、商业分析、教学与文档生成 |
| `evals/datasets/copilot-performance-resilience.v1.jsonl` | 5 | 性能与韧性 | 模型调用、Token、工具、检索、上下文与故障恢复预算 |
| `evals/datasets/copilot-safety-compliance.v1.jsonl` | 5 | 安全合规 | 系统提示泄漏、间接注入、高风险金融请求与钓鱼滥用 |
| `evals/datasets/copilot-agent-capabilities.v1.jsonl` | 5 | Agent 通用能力 | 最小澄清、记忆诚实性、来源冲突、多工具产物与多轮约束保持 |
| `evals/datasets/copilot-benchmark-knowledge-reasoning.v1.jsonl` | 10 | 通用知识 | MMLU-Pro、GPQA、GSM8K、TruthfulQA 与 IFEval 方法适配 |
| `evals/datasets/copilot-benchmark-professional-domains.v1.jsonl` | 12 | 垂直场景能力 | PubMedQA、LegalBench、FinQA、SWE-bench、LongBench 与 MMMU 方法适配 |
| `evals/datasets/copilot-benchmark-agentic.v1.jsonl` | 12 | Agent 通用能力 | BFCL、GAIA 与 tau-bench 的工具选择、多步任务、状态和 Policy 方法适配 |
| `evals/datasets/copilot-benchmark-safety.v1.jsonl` | 6 | 安全合规 | HarmBench 与 XSTest 的稳健拒绝、越狱防护和过度拒绝对照 |
| `evals/datasets/copilot-benchmark-grounded-research.v1.jsonl` | 8 | Agent 通用能力 | CRAG 与 BrowseComp 的长尾检索、时效更新、证据冲突、多跳浏览和诚实弃答 |
| `evals/datasets/copilot-benchmark-memory-personalization.v1.jsonl` | 8 | Agent 通用能力 | LongMemEval 与 LoCoMo 的跨 Session 提取、更新、时间、因果、个性化和跨语言记忆 |
| `evals/datasets/copilot-benchmark-multilingual-instruction.v1.jsonl` | 6 | Agent 通用能力 | Multi-IF 的多轮、多语言约束累积、撤销、纠正与严格结构化输出 |
| `evals/datasets/copilot-benchmark-high-stakes-professional.v1.jsonl` | 6 | 垂直场景能力 | HealthBench 与 FinanceBench 的分诊、用药不确定性、受众适配、财务证据和来源权威 |
| `evals/datasets/copilot-benchmark-cybersecurity.v1.jsonl` | 4 | 安全合规 | CyberSecEval 4 的恶意请求拒绝、良性安全协助、间接注入和防御性威胁情报 |
| `evals/datasets/copilot-benchmark-software-data.v1.jsonl` | 8 | 垂直场景能力 | LiveCodeBench、SWE-Lancer 与 Spider 2.0 的代码生成、自修复、真实功能设计和企业 Text-to-SQL |

每个数据项必须包含稳定 ID、Suite、以 User 结束的消息、Expected 和 Metadata。Metadata 必须声明 `dataset_version`、`task_type`、`risk`、`source` 与 `label_status`；专业扩展集还声明 `evaluation_dimension`、`capability`、`domain`、`difficulty`、`interaction_pattern` 和 `decision_use`。新增 Benchmark 适配题同时声明 `workflow_stage`，用于对齐“输入与上下文 → Intent routing → Agent 与 Tool → 最终回答 → Memory 与 Safety”的产品链路。Benchmark 适配题额外声明 `benchmark_family`、`benchmark_task`、`benchmark_reference_id` 与固定的 `methodology-inspired-original` 适配策略。目录只证明覆盖来源，不授权把项目结果表述为官方 Benchmark 分数。

覆盖设计同时包含目标指标、护栏指标与运行指标：任务成功和垂直能力属于目标；安全、权限和副作用属于护栏；调用数、Token、工具预算、真实 E2E 与恢复状态属于运行指标。离线 Script 只能证明确定性预算与协议，真实时延只在外部调用产生 `wallTimeMs` 时评估，禁止用模拟耗时冒充性能结论。

`npm run docs:check` 会读取 `evals/eval.config.json` 中的全部 Dataset 与对应 JSONL，校验总数和每个表格行；增加、移除或改名 Dataset 时不能只修改报告文字。

`script`、模拟搜索结果和错误注入只用于离线确定性执行，不会同步到 Langfuse 的真实 Dataset 输入。

## 4. Golden Set 生命周期

### 4.1 采集

用户在 Web UI 点击赞或踩后，服务端完成三类有明确边界的写入：

- `feedback_scores` 保存与 Trace 关联的布尔反馈，可异步同步为 Langfuse Score。
- `eval_evidence_snapshots` 保存不可变的 `copilot-eval-evidence.v1` 证据：被评价 Turn 的完整本地 Runtime Trace，以及 Session 从第一轮到该 Turn 的所有 Turn 与 Trace。
- `eval_feedback_candidates` 保存 Prompt、实际回答、路由、用户备注、证据引用和审核状态。

赞踩的 Score Subject 仍是具体 Trace/Turn，因为用户评价的是这一轮可见答案；系统不会把一次点赞误解释为整个 Session 都是好或坏。Session 上下文作为评估证据一并冻结，用于多轮一致性、记忆、状态、路由和工具链诊断。若未来需要 Session 级人工结论，应提供独立操作并生成 Session Subject 的 Score，而不是复用回答下的赞踩。

证据快照采用 `through-evaluated-turn` 边界：只包含被评价轮及其之前的历史，之后产生的消息永远不会倒灌。快照保存 SHA-256 内容标识，剔除密钥和 Base64 二进制正文；候选列表只返回 Turn、Trace Span、Session Turn/Span 数量等摘要，审核者展开时才通过 Owner 受限端点读取完整内容。

同一用户对同一 Turn 重新评分时使用稳定幂等键更新候选，同时撤销之前的有效 Gold。

### 4.2 审核

候选审核有三种状态：`candidate`、`approved`、`rejected`；进入 Golden Set 后采用 `active`、`archived` 生命周期。

- 点赞样本可以确认当前答案，也可以补充更严格的参考答案或期望路由。
- 点踩样本必须提供期望答案或至少一个规范化 Failure Code。
- 批准项写入 `eval_golden_items`，强制 `label_status=human-reviewed`。
- 默认待审候选 API 和 Web UI 只返回 `candidate`。拒绝后条目立即从候选工作集中移除，不进入数据集；`rejected` 状态仅供显式审计查询，避免丢失原始用户反馈事实。
- 已批准条目默认有效；归档不会删除数据、证据或版本，恢复后重新进入有效回归集。所有读写按 Owner 隔离。

赞踩表示用户感受，不等于可执行验收条件；这一审核层防止偏好噪声、误触和不完整负例直接污染回归真值。Web UI 通过左侧一级 `Eval Datasets` 工作台呈现 Dataset Catalog、Review inbox、有效与已归档 Gold、详情、搜索和 JSONL 导出；旧的账户菜单弹窗不再承担数据治理职责。Review inbox 在证据展开、Tab 切换和审核后的全量重绘中分别保留主列表与 Dataset Catalog 的滚动位置；候选被移除时，由相邻条目接替原条目的视觉锚点，避免连续审核回到列表开头。

### 4.3 导出与回归

```bash
npm run eval:golden:export
```

默认输出位于 `.data/evals/copilot-feedback-golden.v1.jsonl`。每项包含可执行的 `input`、人工确认的 `expected`、标签 `metadata` 和自包含的 `evidence`；运行证据不会混入期望答案。没有有效 Gold 时命令拒绝生成空快照。

Golden 数据需要真实应用和语义 Judge 才能验证：

```bash
npm run eval:golden:live -- --confirm-live
```

该命令先导出最新人工审核项，再用 `live-judged` Profile 执行。生产团队应把审核后的快照复制为新的版本化仓库 Dataset，并经过 Review 后加入默认或专项 Profile；不要让本地可变数据库直接改变 CI 覆盖。

## 5. Eval Run 生命周期

Dataset 与 Run 是两个独立对象：Dataset 管理可复用测试输入、期望与版本；Eval Run 记录一次不可覆盖的执行。Web UI 的一级 `Eval Runs` 工作台负责创建、启动、观察、查看结果、重跑、归档和恢复，不能把执行历史写回 Dataset。

### 5.1 状态模型

| 维度 | 状态 | 语义与允许操作 |
|---|---|---|
| 执行 | `draft` | 已保存名称、Profile 和 Dataset ID 范围；可以启动或归档 |
| 执行 | `queued` | 已生成输出路径和可变 Feedback Golden 快照，等待 Runner；可以取消 |
| 执行 | `running` | 真实子进程正在执行 `evals/run.mjs`；可以取消并轮询详情 |
| 执行 | `completed` | Runner 产出合法报告；Gate 另以 `passed` 或 `failed` 表示，失败门禁不等于基础设施失败 |
| 执行 | `failed` | Runner 未启动、异常退出、报告损坏或服务重启中断；保留错误与脱敏日志 |
| 执行 | `cancelled` | 用户取消且没有 Gate 结论；可基于相同范围创建重跑 |
| 生命周期 | `active` / `archived` | 归档只改变默认可见性，不删除定义、结果、日志或血缘；运行中的 Run 不可归档 |

重跑不会复用或覆盖原记录，而是创建新的 Run，并把 `parent_run_id` 指向来源 Run。普通创建 API 不接受客户端指定血缘，防止跨用户伪造关系。服务启动时会将遗留的 `queued` 或 `running` 记录标记为 `failed`，避免页面永久显示不存在的执行。

### 5.2 配置冻结与真实执行

- Profile 必须来自 `evals/eval.config.json`；页面显示执行模式、Judge 模型、最小 Case 数和是否需要额度确认。
- Run 创建时持久化 Profile 与 Dataset ID 范围。版本化 Dataset 由稳定 ID 和版本定义；实际执行报告继续保存配置与 Dataset Fingerprint，作为结果复现证据。
- 用户级 Feedback Golden Set 在进入队列时导出为该 Run 独享的 JSONL 快照，之后的审核或归档不会改变正在运行的输入。
- `live`、`live-traced` 与 `live-judged` 必须显式确认，服务端仍向 CLI 传入 `--confirm-live`，不能只依赖前端勾选。
- Runner 使用独立 Node.js 子进程调用真实 `evals/run.mjs`，通过重复的 `--dataset-id` 精确选择内置 Dataset；stdout 与 stderr 进入有长度上限的脱敏日志。
- 子进程退出码 `0` 或门禁失败码 `1` 且报告有效时都属于 `completed`；报告中的阻断失败决定 Gate `passed` 或 `failed`。无法产生可信报告才属于执行 `failed`。

### 5.3 API、持久化与界面

`eval_runs` 表是用户级执行历史的事实源，保存定义、执行状态、Gate、摘要、结果投影、错误、日志、时间戳和父 Run。报告文件保存在数据库同级的私有 `eval-runs/` 目录，内部路径不向前端公开。

| API | 用途 |
|---|---|
| `GET /api/eval/runs?lifecycle=active` | 返回当前用户的 Run 目录、统计、可用 Profile 与 Dataset |
| `POST /api/eval/runs` | 保存 Draft，或在同一请求中创建并启动 |
| `GET /api/eval/runs/:runId` | 返回 Owner 受限的完整结果与脱敏 Runner 日志 |
| `PATCH /api/eval/runs/:runId` | 执行 `start`、`cancel`、`rerun`、`archive` 或 `restore` |

页面左侧保留紧凑 Run 历史，右侧展示状态、冻结范围、运行时长、Suite 聚合、失败 Evaluator 信号和调试日志；`queued` 与 `running` 状态自动轮询，页面重绘保持列表和详情滚动位置。新建表单按当前 Profile 和本地时间预填可编辑名称，并直接展示全部 Profile 的外部调用、Trace、Judge 和最小 Case 语义。界面只展示服务端状态，不在浏览器模拟进度或结果。

## 6. Evaluator 分层

### 6.1 确定性契约

确定性 Evaluator 位于 `evals/lib/evaluators.mjs` 和 `evals/lib/workflow-audit.mjs`，覆盖：

- 四层路由阶段和独立版本。
- 每次 Generation 与 Model Route、LLM Deployment Route 的关联。
- 每次搜索 Tool 与 Search Deployment Route 的关联。
- 路由模式与 Agent 目标。
- Tool 存在、禁止、成功、错误、参数、Tool Call ID 与去重。
- Trace 父子关系、终态、事件 Schema 与 History 保留。
- 模型 Policy、记忆决策、Artifact 数量、语言、格式和错误协议。
- Intent 的领域、任务类型、风险、新鲜度、格式和所需能力精确断言。
- 模型调用、工具提议、工具执行、搜索、Token、上下文消息和真实 E2E 预算。
- 用户选择回答模型与 Intention 模型隔离、`Auto` 本地解析、混合评分与运行证据、服务端模型目录数量与逻辑别名。
- 多模态内容块、输入附件元数据边界与 Runtime Trace Base64 脱敏。
- Agent Registry 可达性、能力执行器一致性和动态 Prompt 上下文。
- 首次配置向导版本、Web 配置开关、管理员认领、真实验证与密钥脱敏。

确定性失败默认可作为 `blocking` 门禁。

### 6.2 语义 Judge

Judge Catalog 当前包含 Intent 语义适配与答案任务成功两类定义。Judge 必须：

- 使用 Strict JSON Schema，禁止额外字段。
- 固定模型、温度、Prompt、Schema 与定义版本。
- 把证据与 Failure Code 分开输出。
- 在人工校准前只产生 `diagnostic` 信号。
- 按任务和风险切片报告混淆矩阵，不能只看整体准确率。

Judge 默认逻辑模型由 `evals/eval.config.json.defaults.judge.model` 唯一定义。首次配置向导同时显示当前生效值和这一系统预设；管理员保存的模型写入 `COPILOT_RUNTIME_CONFIG_PATH` 中的 `COPILOT_EVAL_JUDGE_MODEL`，真实 Eval CLI 启动时读取并覆盖预设。显式 `--judge-model` 拥有最高优先级。Judge 复用 LLM Gateway 的端点与凭证，但与 Intention、回答模型和应用 Model routing 完全独立。

### 6.3 用户反馈

用户反馈是观察信号，不直接参与阻断。只有经过人工审核并进入版本化 Dataset 后，才通过同一套确定性和语义 Evaluator 参与发布门禁。

`feedback_rejection_queue_contract` 是阻断型确定性 Evaluator：它要求默认审核队列状态为 `candidate`，并要求拒绝项采用 `audit-only` 策略。`feedback_trace_session_evidence_contract` 要求反馈 Subject 保持 Turn 级、目标 Trace 完整捕获、Session 边界截止被评价 Turn、排除未来消息且 Golden 导出自包含。Store、HTTP 与 DOM 测试进一步验证用户隔离、密钥与二进制脱敏、拒绝后默认列表为空、显式 `status=rejected` 仍可审计且不会生成 Gold。

### 6.4 模型选择与多模态专项契约

| Case | 主要输入 | 必须证明的结果 |
|---|---|---|
| `core-model-selection-isolation-001` | 显式回答模型 ID | Direct 或 Specialist 使用所选逻辑模型；`intent-routing` 仍使用 `intention-fast`；两次 Generation 均能关联各自 Model 与 Deployment Route |
| `core-direct-stable-qa-001` | `Auto` 与普通 Direct | Model Router 解析为 `gemini-3-1-flash-lite`，Route 不含未解析的 `model-router` |
| `core-medical-symptom-001` | `Auto` 与高风险 Specialist | 高风险 Policy 解析为 `gpt-5-4`，同时保留候选排名、分数和运行证据 |
| `core-software-debug-001` | `Auto` 与 Coding Specialist | 软件工程 Policy 解析为已通过真实工具调用验证的 `gpt-5-4` |
| `core-multimodal-image-input-001` | 用户消息与图像 Artifact | 模型请求含 `image_url`；输入附件元数据可追溯；应用 Runtime Trace 不含 Base64；不支持图像的显式模型在外部调用前失败 |

记忆回归由 `core-memory-cross-session-identity-001` 与 `test/memory-store.test.mjs` 双层覆盖：前者验证产品工作流会查询已有姓名、回答命中姓名且当前疑问句产生 `question_not_memory`；后者使用真实临时 SQLite 验证英文姓名可以被 `user identity` 和“用户名字”跨 Session、跨语言召回，并且召回问题不会覆盖原事实。

服务端模型目录还必须验证：默认项是唯一 `selection-mode`、公开目录总计为 `Auto` 加 15 个显式选项、内部 `control-model` 不对用户开放、`model-router` 没有 Deployment Alias、其余逻辑别名均可解析到 Deployment、前端不维护目录副本。路由单测还要验证真实延迟可以在证据充分时改变排序、连续失败触发熔断、冷却结束后候选恢复。附件契约必须验证：跨用户文件不可见、缺失文件可诊断、单轮最多 10 个、总大小受限，显式模型模态不匹配返回 `model_modality_mismatch`，`Auto` 无兼容候选返回 `model_route_unavailable`。

Web UI 语言使用确定性契约而不是语义 Judge：`test/web-ui-copy.test.mjs` 扫描静态 HTML、前端交互代码、样式、API Client 和模型展示目录，固定产品文案出现中文即失败，并校验页面语言声明为英文；`test/web-api-client.test.mjs` 验证中文服务端错误不会透传到界面；`test/web-ui.test.mjs` 验证登录、首次配置、反馈审核、模型选择、记忆和上传等关键流程的英文文案。动态用户与模型内容不参与语言门禁。

### 6.5 首次配置专项契约

| 层 | 正例 | 必须包含的反例 | 证据 |
|---|---|---|---|
| Workflow | 声明 `core-configuration.v4`、明确 Web 配置开关、Judge 覆盖键与独立 Search 凭证引用 | 缺少版本、Judge 与回答路由混用、隐式启用 Web 写配置、Search 复用 LLM Key | `first_login_setup_contract`、`search_deployment_uses_dedicated_credential` |
| HTTP | 首个本地保存者认领管理员，返回当前 Judge 与系统预设，真实 Completion 后完成 | 未登录、跨 Origin、非法 Judge 模型、非管理员写入、401 或空 Completion | `test/server-api.test.mjs` |
| 存储 | 用户完成状态隔离，运行配置原子写入且权限为 `0600` | API Key 出现在响应、SQLite 或其他用户状态 | 迁移测试与 HTTP 契约测试 |
| Web UI | 未完成用户首次登录自动弹窗，显示当前非敏感配置、Judge 当前值与系统预设，账户菜单可再次进入 | 已录入配置不可见、Judge 未提交、密钥回显或写入 Local Storage、中文固定文案或中文错误透传 | `test/web-ui.test.mjs`、`test/web-ui-copy.test.mjs`、`test/web-api-client.test.mjs` |

Search 只验证独立 API Key、Base URL、运行配置文件权限、HTTP 脱敏和 Deployment 凭证引用，不在首次向导中主动发起计费检索；Langfuse 校验成对密钥、Base URL、Environment、脱敏与启动状态，不在保存动作中伪造 Processor 热重载。两者不能与已真实验证的 LLM Gateway 使用同一个“验证通过”含义。

### 6.6 Session 水合与删除专项契约

| 正例 | 必须包含的反例 | 证据 |
|---|---|---|
| `GET /api/sessions` 返回后无需额外交互即可显示左侧历史 | `localStorage` 触发 `QuotaExceededError` 导致历史不重绘 | `test/web-ui.test.mjs` 的缓存配额场景 |
| 服务端零 Turn Session 仍调用真实删除端点 | 仅按 Prompt 或 Request ID 判断为本地草稿，刷新后复活 | `test/web-ui.test.mjs` 的零 Turn 删除场景、`test/server-api.test.mjs` |
| 本地缓存只保存轻量目录投影 | 完整回答、Runtime 或 Trace 重复写入浏览器缓存 | `conversation-cache.v3` 断言 |

浏览器缓存不是 Eval 真值或会话事实源；缓存写入失败只允许产生诊断日志，不能改变历史列表、删除结果或服务端授权语义。

## 7. 四层路由 Eval

| 路由层 | 关键正例 | 必须包含的反例 | 运行证据 |
|---|---|---|---|
| Intent | 单一意图、复合意图、风险与实时性 | 文档请求包含医疗或实时信号时不得丢失风险 | `classify-intent` Span |
| Agent | 强制专业路由、直接回答、合法模型提议 | 未注册 Agent、格式请求错误直答 | `select-agent` Span |
| Model | 固定 Intention、`Auto` 具体解析、显式 Direct、显式 Specialist、模态候选回退、运行证据改序与熔断 | 未知 ID、未解析 `model-router`、角色不匹配、候选证据缺失、回答选择覆盖 Intention | `select-model` Span |
| Deployment | LLM 与 Search Profile、各自环境覆盖和独立凭证引用 | 缺少 Profile、无路由、Search 隐式复用 LLM Key、密钥泄漏 | `select-deployment` Span |

配置单测位于 `test/routing-layers.test.mjs`；端到端关联由全量 Dataset 检查。

## 8. Profile 与命令

| Profile | 执行 | Trace | Judge | 用途 |
|---|---|---|---|---|
| `local` | 离线 Script，不调用外部服务 | 关闭 | 关闭 | 开发过程中的快速确定性契约检查；允许选择较小 Dataset 切片 |
| `ci` | 离线 Script，不调用外部服务 | 关闭 | 关闭 | 全量发布门禁，并对照已接受基线拒绝新增诊断债务 |
| `live` | 真实模型与 Tool，仅运行 `live_eligible` Case | 关闭 | 关闭 | 验证应用真实工作流，不产生远端 Trace 或语义评分 |
| `live-traced` | 真实模型与 Tool，仅运行 `live_eligible` Case | Langfuse 开启 | 关闭 | 在真实工作流基础上保存可下钻的运行 Trace |
| `live-judged` | 真实模型与 Tool，仅运行 `live_eligible` Case | Langfuse 开启 | 当前配置的 LLM-as-a-Judge | 同时获得真实执行证据与语义质量信号；Judge 仍需人工校准 |

三个 Live Profile 都要求显式确认额度消耗。Profile 只决定“怎样执行和评分”，Dataset 决定“测哪些样本”，两者不能合并成一个模糊选项。

常用命令：

```bash
npm run eval
npm run eval:ci
npm run eval:validate
npm run eval:live -- --confirm-live
npm run eval:live:traced -- --confirm-live
npm run eval:live:judged -- --confirm-live
```

按切片执行：

```bash
node evals/run.mjs --profile local --suite core-routing
node evals/run.mjs --profile live --task-type current_information_retrieval --confirm-live
node evals/run.mjs --profile local --case core-document-pdf-001
```

## 9. 候选对比与校准

先生成候选运行，再与当前基线比较：

```bash
npm run eval:compare -- --candidate evals/results/<candidate>.json
```

比较默认拒绝：Case 覆盖变化、候选新增阻断失败和未经审查的诊断债务。模型或 Router 对比还应统一记录重复次数、质量、E2E、TTFT、Token、错误率和实际成本。

Judge 校准：

```bash
npm run eval:calibrate -- \
  --run evals/results/<judged-run>.json \
  --annotations evals/annotations/<human-reviewed>.jsonl
```

人工标注必须与同一运行中的 Judge 结果完整匹配。未匹配样本、非 `human-reviewed` 标签或缺少 Reviewer 时默认拒绝输出结论。

## 10. Langfuse 映射

Langfuse Dataset Item 使用三块独立语义：

- `input`：真实运行所需消息和公开上下文。
- `expectedOutput`：路由、工具、格式、参考答案等期望。
- `metadata`：Case ID、版本、任务、风险、来源与审核状态。

一轮聊天对应一个稳定 Trace，Session 用于分组多轮；模型调用使用 Generation，工具和路由使用 Span，Agent 使用 Agent Observation。多模态内容只交给模型调用与 Langfuse SDK，应用 Runtime Trace 使用脱敏附件提示。用户赞踩以 BOOLEAN Score 关联 Trace。

同步与实验：

```bash
npm run eval:langfuse:sync
npm run eval:langfuse:run -- --run-name candidate-001
```

同步只选择 `live_eligible=true` 的版本化样本，并校验 Dataset Schema Fingerprint，避免覆盖不兼容协议。

外部语义参考：[用户反馈](https://langfuse.com/docs/observability/features/user-feedback)、[Dataset 与 Experiment](https://langfuse.com/docs/evaluation/experiments/datasets)、[多模态观测](https://langfuse.com/docs/observability/features/multi-modality)、[可观测最佳实践](https://langfuse.com/docs/observability/best-practices)。本仓库的发布门禁仍以本地版本化配置与人工审核为准。

## 11. 变更工作流

1. 描述失败模式和受影响切片。
2. 新增最小正例与反例，或从人工审核 Golden Set 提升一个真实 Case。
3. 运行旧版本并保留基线证据。
4. 修改 Routing、Agent Registry、Prompt、Harness、Tool 或代码。
5. 运行 `npm run verify`。
6. 对候选结果执行比较；语义变化执行真实与 Judge Eval。
7. 只有满足阻断门禁且无未解释回退时，才更新基线。
8. 在决策记录中写明证据、代价和剩余风险。

基线更新必须通过受保护命令完成；命令会验证 local Profile、完整覆盖、配置与 Dataset 指纹，并拒绝包含任何阻断、诊断或执行错误的结果：

```bash
npm run eval:baseline:accept -- --run evals/results/<完整离线结果>.json
```

禁止为单个样本硬编码答案、静默减少 Case、降低阈值或把 Judge 自评结果标为人工真值。
