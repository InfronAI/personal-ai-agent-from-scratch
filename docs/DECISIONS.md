# Personal Copilot 架构决策

本文件记录当前仍有效的长期决策。每项决策变化时必须同步修改配置、实现、Eval 和文档。

## ADR-001：产品使用供应商中立身份

状态：已接受。  
决策：产品、变量、模块和 UI 使用 Personal Copilot、LLM Gateway、Web Search、Model Policy 与 Deployment Profile 等通用概念。具体供应商、物理模型和端点只存在于 Deployment 配置、服务端环境或真实 Trace。  
原因：避免业务语义与基础设施绑定，使模型和端点能独立比较、切换与回滚。  
代价：Trace 和配置必须同时区分逻辑别名与实际模型。

## ADR-002：Intention Layer 拆为四层路由

状态：已接受。  
决策：Intent、Agent、Model、Deployment 分别拥有配置、模块、版本和 Trace Span。  
原因：四类决策的输入、责任、变化频率和评测方法不同；合并后无法解释质量回退究竟来自语义、工作流、模型还是基础设施。  
代价：一次请求会产生更多结构化事件，配置引用必须严格校验。

## ADR-003：语义模型提议与确定性策略协同

状态：已接受。  
决策：Root Agent 模型可提出直接回答、工具或 Agent 委派；配置驱动 Router 负责稳定分类、白名单和高风险覆盖。  
原因：纯规则缺少语义覆盖，纯模型又无法保证合法 Agent、格式和高风险边界。  
代价：必须评估模型提议和最终决策两份证据，防止把规则命中率误当成端到端任务成功率。

## ADR-004：复合 Intent 聚合信号但只选择一个主 Agent

状态：已接受。  
决策：Intent 同时保留全部命中规则，聚合最高风险、能力并集和实时性；当前仍以最高优先级主任务与模型提议选择一个 Agent。  
原因：先防止风险与能力信号丢失，同时保持单轮执行、成本和副作用可控。  
代价：跨领域复合任务不能自动形成多 Agent 计划；只有 Eval 证明净收益后才引入 Planning 和多 Agent 协作。

## ADR-005：Agent 与能力使用显式注册表

状态：已接受。  
决策：Agent、Prompt、能力和路由白名单由 `agents/registry.json` 与 `capabilities/registry.mjs` 定义。模型不能构造未注册 Agent 或 Tool。  
原因：消除不存在 Agent、工具名漂移和 Prompt/执行器不一致。  
代价：新增能力需要同步 Registry、执行器、Schema、Trace 和 Eval。

## ADR-006：用户反馈先进入候选池

状态：已接受。  
决策：赞与踩都写入候选；只有人工批准的 `human-reviewed` 数据才能成为 Golden Set。点踩必须补充期望行为；重新评分撤销旧 Gold。  
原因：显式反馈有价值，但包含误触、偏好差异和缺少正确答案的负例，不能直接作为训练或发布真值。  
代价：需要审核 UI、状态机和数据治理；反馈到回归之间存在延迟。

## ADR-007：版本化仓库 Dataset 与可变本地 Gold 分离

状态：已接受。  
决策：CI 使用经 Review 的版本化 JSONL；SQLite Gold 通过显式命令导出，审核后再提升为仓库 Dataset。  
原因：本地运行状态不能隐式改变 CI 覆盖和发布门禁。  
代价：Golden 提升多一步，但可获得变更历史、Review 和稳定指纹。

## ADR-008：本地用户名身份是 MVP，不是生产认证

状态：已接受。  
决策：开发模式允许用户名登录并签发签名 Cookie；生产使用可信身份代理 Header。所有数据仍以内部用户 ID 隔离。  
原因：快速获得用户空间与会话隔离，又不在参考项目内实现完整身份平台。  
代价：本地模式不能用于不可信多用户网络；生产必须正确配置代理和 Header 剥离。

## ADR-009：SQLite 是单实例状态存储

状态：已接受。  
决策：会话、记忆、Artifact 元数据、反馈和 Golden Set 使用 SQLite 前向迁移。  
原因：本地独立、事务简单、便于测试和迁移。  
代价：不支持无协调多副本；横向扩展前需迁移共享数据库。

## ADR-010：长期记忆采用保守写入

状态：已接受。  
决策：只保存用户来源、稳定、可复用且非敏感的信息；类型化有效期、相关性检索、冲突取代和用户删除均为强制能力。  
原因：错误记忆比漏记更难发现，会持续污染后续对话。  
代价：部分隐含偏好不会自动记住，需要用户明确表达。

## ADR-011：Langfuse 作为可替换的 Trace 与实验协议

状态：已接受。  
决策：使用稳定 Trace/Session/Observation 与 Dataset/Experiment 语义，但业务状态与发布门禁仍保存在本地配置和数据库。  
原因：获得成熟可观测和实验能力，同时避免远端服务成为应用可用性或事实源单点。  
代价：需要本地与远端 ID、Score 和同步状态的一致性处理。

## ADR-012：不提供 Dockerfile

状态：已接受。  
决策：项目只定义进程、配置、健康检查和持久化要求，不封装容器镜像。  
原因：当前使用方明确不需要 Dockerfile。  
代价：部署平台负责 Node.js 运行时、进程管理、Secret、持久卷和优雅停止。

## ADR-013：Intention 模型与回答模型独立

状态：已接受。  
决策：Intention Layer 使用独立 `intent-fast` Policy，默认由 `intention-fast` 映射到 `google/gemini-3.1-flash-lite`；用户在 Web UI 的模型选择只作用于 `direct-response` 或 `specialist-response`。可选回答模型由服务端版本化目录发布。  
原因：意图与路由需要低延迟、稳定和可统一校准，而最终答案需要让用户按质量、成本、时延和模态主动选择；把两者绑定会让 UI 操作改变控制面行为。  
代价：直接回答会产生两次职责不同的模型调用，增加少量延迟和成本；Trace 与 Eval 必须分别验证两次 Generation。
实现与证据：`config/model-catalog.config.json` 定义逻辑目录，`config/routing.config.json` 定义 Policy 与 Deployment Alias，`model-catalog.mjs` 和 `routing/model-router.mjs` 执行边界，`core-model-selection-isolation-001` 提供回归证据。

## ADR-014：多模态内容瞬时传输，持久层只保存 Artifact

状态：已接受。  
决策：上传文件按用户保存为 Artifact；执行时临时转换为 OpenAI-compatible 多模态内容块。会话、HTTP 列表和应用 Runtime Trace 只保存 ID、文件名、MIME、大小、Hash 与引用，不保存 Base64。  
原因：既要让模型获得真实输入，也要避免二进制膨胀数据库、前端状态和调试日志，并保持用户隔离和可删除性。  
代价：执行时需要再次读取文件；生产化还需对象存储、恶意文件扫描、保留策略和更强的内容验证。
实现与证据：`artifacts/artifact-store.mjs` 定义上传与内容块转换，`server.mjs` 定义用户范围 API，`core-multimodal-image-input-001` 与 Artifact 相关测试验证模态传递和 Runtime Trace 脱敏。

## ADR-015：首次配置分离实例设置与用户完成状态

状态：已接受。  
决策：每个用户首次登录都进入版本化核心配置向导；模型和搜索属于实例级运行配置，首个成功保存者成为本地配置管理员。用户完成状态按用户保存，且只有真实最小模型调用通过后才能完成。Trace 配置保持启动时初始化，不伪造热更新能力。  
原因：仅在首次 Prompt 失败时提示缺少 Key 太晚；把全局凭证按用户复制又会制造冲突和泄漏。实例配置、管理权限、用户确认与真实可用性是四个不同事实。  
代价：本地实现新增一份权限为 `0600` 的明文运行配置和配置管理员概念；生产环境必须关闭 Web 写配置并接入正式身份、权限和 Secret Manager。  
实现与证据：`runtime-settings.mjs`、`setup-service.mjs`、`onboarding-store.mjs` 与数据库迁移 11 定义运行协议；HTTP、Web UI、迁移测试和 `first_login_setup_contract` 验证权限、脱敏与完成门禁。

## ADR-016：能力协议保持独立纯模块

状态：已接受。  
决策：保留 `capabilities/registry.mjs` 作为无 I/O 的能力协议边界，不并入 Agent Registry 或 Executor。内部 `Map` 不对外暴露；调用方只能读取版本、能力名称、不可变 Spec、模型 Tool Schema 和参数校验结果。  
原因：Agent Registry 定义“谁可以用什么”，能力协议定义“工具是什么”，Executor 定义“工具如何执行”。合并前两者会让共享能力归属错误；合并后两者会使 Agent、Workflow 与 Eval 的纯配置加载隐式初始化数据库、网络和文件适配器。  
代价：保留一个独立文件和跨模块一致性测试；新增能力仍需同时实现协议、执行器、Agent 授权、Trace 与 Eval。  
实现与证据：`capabilities/registry.mjs` 隐藏可变 Registry，`test/capability-registry.test.mjs` 检查只读边界，`tool_executor_parity` 检查模型可见 Tool 与执行器一致。

## ADR-017：拒绝反馈移出工作队列但保留审计记录

状态：已接受。  
决策：默认候选集合只包含 `review_status=candidate`。人工拒绝把记录标记为 `rejected` 并立即从默认 API 与 Web UI 移除；原始反馈、Reviewer 和时间继续保存在 SQLite，可通过显式状态查询审计，但不得生成有效 Gold。  
原因：Reviewer 的工作列表不应被已处理项目污染，同时用户反馈是生产质量事实，物理删除会破坏可追溯性、误判分析和后续治理。  
代价：候选工作集与审核历史成为两个查询视图；运维界面若需要审核历史，必须显式请求状态。  
实现与证据：`golden-set-store.mjs` 定义 `candidate` 队列与 `audit-only` 拒绝策略；Store、HTTP、DOM 测试和 `feedback_rejection_queue_contract` 验证移除、审计与非 Gold 语义。

## ADR-018：默认模型选择归属应用 Model Router

状态：已接受。  
决策：Web UI 的默认项命名为 `Auto`，内部稳定 ID 为 `model-router`。它是 `selection-mode`，不是模型或 Deployment Alias。应用 Model Router 输出具体逻辑模型，Deployment Router 只接受有物理映射的具体别名；核心配置不再暴露回答默认模型或网关级动态模型字段。网关仅在已选模型内部执行 provider fallback。  
原因：应用侧拥有任务、业务风险、Agent 能力和用户反馈，能够解释、回归和持续校准模型选择；网关更适合处理供应商可用性、地域、吞吐和容灾。两层都做任务到模型的选择会形成重复路由，隐藏真实决策归因。  
代价：初始候选顺序来自配置与现有能力声明，不等同于已经证明的最优策略；需要用 Golden Set、真实质量、时延和成本对候选顺序持续做实验。应用还必须维护模型模态能力，Deployment 必须拒绝未映射别名。  
实现与证据：`config/model-catalog.config.json` 区分 `selection-mode`、`answer-model` 与 `control-model`；`config/routing.config.json.modelRouting` 定义候选；`routing/model-router.mjs` 生成 `copilot-model-route.v3` 证据；`model_router_mode_owned_by_application`、`model_route_resolves_concrete_alias`、`model_route_decision_evidence` 与路由单测提供回归门禁。

## ADR-019：Model Router 采用约束过滤与在线证据混合评分

状态：已接受。  
决策：Model Router 使用 `hybrid-score`，执行顺序为“Deployment 与模态硬过滤 → Intent/Agent Policy 候选 → Policy 优先级、运行成功率与 EWMA 延迟加权排序 → 熔断与可选探索 → 具体逻辑模型”。运行证据以进程内观察值起步；样本不足时回退到中性分，不把偶发请求伪装成训练完成的学习型 Router。连续失败达到阈值后进入有限冷却，探索开关默认关闭。  
参考依据：选取五个具有不同路线的代表性开源项目，而不是声称按单一 Star 指标做绝对排名：[RouteLLM](https://github.com/lm-sys/RouteLLM) 提供偏好数据训练与阈值校准，[vLLM Semantic Router](https://github.com/vllm-project/semantic-router) 强调语义、复杂度、模态、安全和反馈等多信号，[TensorZero](https://github.com/tensorzero/tensorzero) 把 Variant、实验和反馈闭环纳入路由，[LiteLLM](https://github.com/BerriAI/litellm) 提供延迟、成本、负载、重试与冷却策略，[Portkey Gateway](https://github.com/Portkey-AI/gateway) 提供条件路由、负载均衡、Fallback 与 Guardrail。当前实现吸收可解释且数据量要求低的共同部分；积累足够人工审核偏好对后，再增加离线训练的 Learned Ranker，不让其绕过硬约束。  
原因：纯规则排序无法根据实际健康和尾延迟自适应；直接引入黑盒分类器又缺少足量本地标签和安全边界。混合评分能保留 Policy 可解释性，同时让真实成功率和延迟产生受控影响。  
代价：进程内证据重启后清零，尚未包含持久化成本、质量和用户级偏好特征；权重必须用 Eval 与生产观测校准。  
实现与证据：`config/routing.config.json.modelRouting.scoring` 定义全部权重与阈值；`routing/model-router.mjs.observe()` 接收真实调用结果；`select-model` Span 输出候选排名、分数拆解、运行证据与稳定原因码；路由单测覆盖延迟翻转、连续失败熔断和冷却恢复。

## ADR-020：Langfuse 插桩默认加载，凭证通过首次向导配置

状态：已接受。  
决策：启动命令通过 `--import ./instrumentation.mjs` 在业务模块之前初始化 OpenTelemetry 与 `LangfuseSpanProcessor`。首次向导允许配置成对的 Public/Secret Key、Environment 和 Base URL；Base URL 默认 `https://cloud.langfuse.com`，可改为其他 Region 或自托管实例。密钥不回显，保存到权限为 `0600` 的服务端运行配置；Processor 仅在进程启动时创建，因此保存后明确提示重启。  
原因：预初始化保证业务 Span 被同一个 Provider 捕获；把配置入口前置到首次体验可以避免用户完成对话后才发现没有 Trace，同时保持后端可替换。  
代价：首次配置多出一个推荐区块；密钥或端点变更不能热切换。  
实现与证据：`instrumentation.mjs`、`observability.mjs`、`setup-service.mjs`、`runtime-settings.mjs`、首次向导 DOM 与 HTTP 测试共同定义边界。

## ADR-021：会话删除与长期记忆、外部 Trace 解耦

状态：已接受。  
决策：会话 Owner 可从左侧历史列表删除 Session。服务端在 Session 锁内事务删除本地反馈并级联删除 Turn、反馈候选和 Gold；长期记忆作为用户级独立资产保留，已导出的远端 Langfuse Trace 不由本地删除操作代删。  
原因：会话清理必须真实落到服务端并遵守用户隔离，但长期记忆有独立管理入口，外部 Trace 也具有独立保留与治理策略，不能通过一个模糊按钮跨系统破坏证据。  
代价：用户若要删除长期记忆或远端 Trace，需要进入各自管理面完成。  
实现与证据：`DELETE /api/sessions/:sessionId`、`conversation-store.mjs`、左侧删除交互，以及 Store、HTTP、API Client 和 DOM 测试。

## ADR-022：Search 使用独立连接与凭证边界

状态：已接受。  
决策：Tavily-compatible Search 使用 `WEB_SEARCH_BASE_URL` 和 `WEB_SEARCH_API_KEY`，Deployment Profile 只暴露 `WEB_SEARCH_API_KEY` 凭证引用，不再回退到 `LLM_GATEWAY_API_KEY`。首次配置向导允许分别编辑 Search Base URL 与 API Key；密钥只写入权限为 `0600` 的服务端运行配置，空输入保留已有值且任何响应都不回显。部署者可以为两项显式填写相同的实际 Key，但协议、校验和审计仍保持独立。  
原因：模型网关与搜索服务的端点、权限、轮换周期和故障域可能不同。隐式共享凭证会让 Search 状态产生假阳性，也无法单独轮换、撤销或定位认证故障。  
代价：本地首次配置增加一个密钥字段；向导保存不会主动调用计费搜索，因此“已配置”只代表凭证与端点存在，不代表真实检索验证通过。当前向导协议已由后续决策升级为 `core-configuration.v4`。  
实现与证据：`runtime-settings.mjs` 定义允许字段，`setup-service.mjs` 定义 `copilot-setup-state.v5`、校验与脱敏，`config/routing.config.json` 定义 `deployment-routing.v2` 的独立凭证引用，`web-search.mjs` 移除 LLM Key 回退；HTTP、DOM、路由单测与 `search_deployment_uses_dedicated_credential` 提供回归门禁。

## ADR-023：Web UI 固定产品文案统一使用英文

状态：已接受。  
决策：Web UI 的静态 HTML、导航、按钮、弹窗、Toast、Trace 标签、模型展示元数据和公开错误兜底统一使用英文，页面声明 `lang="en"`。用户输入、模型输出、记忆、文件名和历史业务数据保持原始语言，不做隐式翻译；工程文档与代码注释继续使用中文。前端按稳定错误码映射英文消息，中文服务端错误不得直接透传到界面。  
原因：界面语言必须一致且可自动验收，同时动态业务内容的语言属于用户和模型上下文，强制翻译会破坏证据、语义与可追溯性。  
代价：服务端新增公开错误码时必须同步维护前端映射；产品文案变更需通过静态语言门禁，动态内容不能用同一规则粗暴扫描。  
实现与证据：`index.html`、`app.js`、`src/web/api-client.mjs` 和 `config/model-catalog.config.json` 定义英文展示；`test/web-ui-copy.test.mjs`、`test/web-api-client.test.mjs` 与 `test/web-ui.test.mjs` 提供静态、异常路径和交互回归证据。

## ADR-024：服务端会话历史权威，浏览器仅保存轻量缓存

状态：已接受。  
决策：SQLite 与 `GET /api/sessions` 是历史 Session 的唯一权威来源。浏览器 `conversation-cache.v3` 仅保存目录字段和必要的未同步本地状态，不保存完整回答、Runtime 或 Trace；服务端返回对象显式标记 `serverBacked`。左栏在收到服务端数据后先重绘再写缓存，缓存失败不得改变界面状态。删除所有 `serverBacked` Session 时均调用服务端端点，不以 Turn、Prompt 或 Request ID 是否存在作替代判断。  
原因：完整 Trace 重复进入 `localStorage` 会触发配额异常并让水合流程在 render 前中断；同时模型调用失败可能留下零 Turn 的合法服务端 Session，仅根据内容判断会把它误当成本地草稿并在刷新后复活。  
代价：浏览器离线时只能恢复轻量目录和未同步草稿，完整历史必须等待服务端；缓存不再承担离线数据库职责。  
实现与证据：`app.js` 的 `serverConversation`、`persistConversationCache`、服务端对账和删除逻辑定义边界；`test/web-ui.test.mjs` 注入 `QuotaExceededError` 并覆盖零 Turn Session 删除，HTTP 与 Store 测试继续验证 Owner 和级联清理。

## ADR-025：回答反馈冻结目标 Trace 与 Session 时间点证据

状态：已接受。  
决策：回答下的赞踩仍以具体 Turn/Trace 为 Score Subject；保存反馈时，服务端同步创建不可变 `copilot-eval-evidence.v1` 快照，包含目标 Turn 的完整本地 Runtime Trace，以及 Session 从第一轮到目标 Turn 的全部 Turn 与 Trace。快照明确排除后续消息，保存内容 Hash，并在落库前移除密钥与 Base64 二进制正文。候选列表只返回覆盖摘要，完整证据按需读取；人工批准后的 Golden JSONL 自包含完整证据，但 `input`、`expected` 和 `evidence` 保持独立。  
原因：单独保存 Prompt、回答与路由摘要无法诊断多轮状态、Agent/Model/Deployment routing、工具调用和记忆链路；直接把一次回答赞踩升级为 Session Score 又会扩大标签语义，造成误标。时间点 Session 快照既保留上下文，又避免后续消息倒灌和标签泄漏。  
代价：反馈会增加 SQLite 存储，复杂 Session 的 Golden 导出也会变大；因此列表 API 必须只传摘要，完整快照采用延迟读取。若需要对整个 Session 给出人工结论，后续必须增加独立 Session 级反馈入口，而不能复用回答按钮。  
实现与证据：数据库迁移 12、`evaluation-evidence-store.mjs`、`golden-set-store.mjs` 与证据详情 API 定义协议；Store、迁移、HTTP、API Client、DOM 测试和 `feedback_trace_session_evidence_contract` 验证时间边界、用户隔离、脱敏、自包含导出与界面可读性。

## ADR-026：专业 Eval 覆盖矩阵与一级 Dataset 生命周期工作台

状态：已接受。  
决策：内置 Eval 从产品契约扩展为通用知识、垂直场景能力、性能与韧性、安全合规、Agent 通用能力五类专业维度，并保留既有核心、多轮和对抗数据；进一步以 27 个公开 Domain Benchmark 的能力定义和评分思想设计 80 个原创样本，最终形成 18 个版本化 Dataset、140 个 Case，其中 69 个不依赖离线 fixture、允许真实调用。每个专业 Case 声明能力、领域、难度、交互形态和决策用途；新增 Benchmark 适配题还声明工作流阶段，并额外声明来源、任务形态与固定适配策略。Web UI 用统一目录管理只读内置基准和用户级 Feedback Golden Set，并按 Copilot 请求链路展示覆盖。  
原因：单纯扩大样本数不能回答模型、路由或 Agent 在什么切片上变好；账户弹窗也不足以承载数据审核、版本和生命周期治理。专业元数据让报告能从总分下钻到业务决策，一级工作台让真实反馈在不污染真值的前提下持续进入回归体系。  
代价：CI 固定覆盖增至 140，真实可运行样本增至 69，配置、文档和基线必须同步维护，真实全量 Judge 成本同步增长。方法适配结果不得冒充官方 Benchmark 分数，内置数据也不替代生产分布采样与人工校准。离线 `search_results` fixture 不得标记为可在线运行。  
实现与证据：`evals/benchmarks/catalog.v1.json`、`evals/eval.config.json`、18 份 JSONL、`evals/lib/benchmark-catalog.mjs`、`evals/lib/evaluators.mjs`、`eval-dataset-catalog.mjs`、Dataset API、一级视图和相关测试共同定义协议。

## ADR-027：首次配置显式管理 LLM-as-a-Judge

状态：已接受。  
决策：`core-configuration.v4` 首次向导增加独立的 LLM-as-a-Judge 模型字段，并通过 `copilot-setup-state.v5` 同时返回当前生效值、`evals/eval.config.json` 中的系统预设和覆盖来源。Web 管理员保存值写入 `copilot-runtime-settings.v2` 的 `COPILOT_EVAL_JUDGE_MODEL`；真实 Eval CLI 在解析 Profile 前加载同一运行配置，命令行 `--judge-model` 保持最高优先级。界面增加 `Current configuration` 摘要，公开全部非敏感值和凭证状态，但不回显任何密钥。  
原因：只在 Eval 配置文件中声明模型，会让应用管理员无法在初始化时确认 Judge 与业务模型的职责和当前取值；如果 Web 只保存但 Eval 进程不读取，又会形成不可执行的“装饰性配置”。同时系统预设与显式覆盖必须分开展示，才能解释一次评测实际用了哪个模型。  
代价：新增一个实例级非敏感设置，既有用户会因向导版本升级重新确认配置；Judge 仍复用 LLM Gateway 的端点和凭证，向导的最小探测只验证 Intention 模型，不等同于 Judge 已完成校准或生产可信度验证。  
实现与证据：`setup-service.mjs`、`runtime-settings.mjs`、`evals/lib/eval-config.mjs`、`app.js` 和 `styles.css` 定义读取、保存与呈现；Workflow Audit、HTTP 正反例、运行配置迁移、Eval 配置优先级和 DOM 测试提供回归证据。

## ADR-028：Eval Dataset 与 Eval Run 分离并持久化执行生命周期

状态：已接受。  
决策：新增用户级 `Eval Runs` 工作台和 `eval_runs` 持久化状态机。Dataset 继续只定义可复用测试数据；Run 保存名称、Profile、Dataset ID 范围、执行与 Gate 状态、结果、脱敏日志、时间戳及重跑血缘。执行状态固定为 `draft → queued → running → completed | failed | cancelled`，归档状态与执行状态独立。真实 Profile 必须在服务端再次确认；重跑创建新记录，普通创建接口不得自行指定父 Run。  
原因：只有 CLI 文件无法让用户观察和治理一次评测从定义到结论的全过程；把执行状态写入 Dataset 又会混淆测试输入和实验结果。独立 Run 模型可以保留可复现范围、失败归因、审计历史和候选版本间血缘，同时使门禁失败与 Runner 基础设施失败保持不同语义。  
代价：服务端需要管理子进程、报告文件、轮询、日志上限和重启恢复；当前本地 Runner 不提供分布式队列、并发配额或跨实例接管。历史 Run 不做破坏性删除，只允许归档；生产部署后应把 Runner 替换为持久任务队列，但保持同一状态协议。  
实现与证据：数据库迁移 13、`eval-run-store.mjs`、`eval-run-service.mjs`、`evals/run.mjs --dataset-id`、Eval Run HTTP API、`app.js` 一级工作台和对应 Store、CLI、HTTP、API Client、DOM 测试定义完整协议；`docs/EVALUATION.md` 记录状态、真实执行与恢复边界。

## ADR-029：内部命名使用领域术语，界面采用低噪声工作台结构

状态：已接受。  
决策：实现层统一使用 `application`、`agent runtime`、`root agent`、`session`、`trace`、`span`、`dataset`、`evaluation run`、`model route` 与 `deployment route` 等行业术语。单轮编排入口命名为 `agent-runtime.mjs` 和 `runAgentTurn`，HTTP 组合入口命名为 `createApplicationServer`；前端使用 `application shell`、`product mark`、`primary navigation` 和共享 `section page` 结构。项目源码、配置、文档和测试禁止出现客户、供应商或基础设施品牌作为产品概念，检查由 `scripts/check-chinese-docs.mjs` 执行。第三方名称只允许出现在真实集成边界，例如 Langfuse 协议、模型供应方目录和外部 Benchmark 来源。  
兼容边界：`copilot-*.vN` Schema、Dataset 版本和 `COPILOT_*` 环境变量是已经发布的协议命名空间，不是运行实现变量；本次不做无版本迁移。浏览器历史缓存从旧键迁移到 `chat.sessions.cache.v3`，读取后立即删除旧键。后续若要修改公开协议命名，必须升版并提供数据迁移。  
界面规则：保留 General Sans、Gelasio、蓝色操作色和蓝灰中性色；导航只展示一级目的，不在每个入口重复解释；页面统一为“固定标题栏、主要操作、主内容”三层；说明性内容默认折叠；减少嵌套卡片、过大圆角、重复状态和装饰性文案；Trace、Memory、Dataset 与 Eval Run 仍保留可下钻证据。  
原因：产品专有名进入变量会把通用运行时错误绑定到单一客户，重复说明和卡片墙则降低信息密度。领域术语能使 Agent、可观测性和 Eval 边界更容易被工程团队理解，低噪声结构让用户更快完成对话、诊断和评测任务。  
代价：稳定协议中会暂时保留历史命名空间；前端视觉回归仍主要依赖 DOM、可访问性和响应式契约，后续应增加经过人工登录校验的截图基线。  
实现与证据：`agent-runtime.mjs`、`workflow.mjs`、`server.mjs`、`app.js` 与 `styles.css` 定义新命名和共享页面结构；`test/agent-runtime.test.mjs`、Web UI 测试、品牌词静态门禁和 `npm run verify` 提供回归证据。
