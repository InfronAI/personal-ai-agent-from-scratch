# Personal Copilot 文档中心

适用版本：`personal-ai-agent-from-scratch@3.0.0`  
最后核对：2026-09-01

| 文档 | 回答的问题 | 主要读者 |
|---|---|---|
| [产品与范围](PRODUCT.md) | 产品解决什么问题、服务谁、边界和体验是什么 | 产品、客户、技术负责人 |
| [技术设计](TECHNICAL_DESIGN.md) | 四层路由、运行链路、数据、API 与模块如何协同 | 架构师、开发、调试人员 |
| [系统化 Eval](EVALUATION.md) | Dataset、Golden Set、Eval Run 生命周期、Evaluator、门禁与实验如何运行 | AI 工程、数据科学、CI 维护者 |
| [工程规约](ENGINEERING.md) | 如何配置、修改、测试、迁移、发布和排障 | 开发、Review、SRE、安全 |
| [架构决策](DECISIONS.md) | 当前关键取舍、原因、代价与替代方案 | 技术负责人、后续维护者 |

快速启动见 [根 README](../README.md)，自动化 Agent 的硬约束见 [AGENTS.md](../AGENTS.md)，命令速查见 [Eval README](../evals/README.md)。

## 推荐阅读路径

- 第一次运行：根 README → 产品与范围 → 工程规约。
- 修改路由或 Agent：技术设计 → 架构决策 → 系统化 Eval → `AGENTS.md`。
- 修改记忆、上传或模型目录：产品与范围 → 技术设计对应生命周期 → 工程规约 → 专项 Eval。
- 调查线上失败：工程规约的排障顺序 → Trace DAG → 对应 Dataset 切片与候选对比。

## 文档维护规则

- 产品目标或范围变化：更新 `config/product.config.json`、`PRODUCT.md` 和必要的决策记录。
- 路由变化：先更新 `config/routing.config.json`、Schema 与正反 Eval，再更新 `TECHNICAL_DESIGN.md`。
- 模型目录或多模态输入变化：更新 `config/model-catalog.config.json`、对应 Schema、Deployment Alias、附件契约 Eval 与工程说明。
- Agent 或 Prompt 变化：先更新 `agents/registry.json`、Registry 测试和目标切片 Eval。
- Dataset、Evaluator、Profile、门禁或 Golden 流程变化：先更新 `evals/eval.config.json` 和测试，再更新 `EVALUATION.md`。
- 能力协议变化：保持 `capabilities/registry.mjs` 无 I/O 且不暴露可变 Registry，同步 Agent/Executor 一致性测试、Workflow Audit、技术设计和决策记录。
- 数据库或 API 变化：更新迁移、契约测试、`TECHNICAL_DESIGN.md` 和 `ENGINEERING.md`。
- 首次配置或运行设置变化：更新 Setup API、管理员与用户状态测试、`.env.example`、安全边界和 `first_login_setup_contract`。
- 命令变化：同步更新根 README 与 `evals/README.md`。
- 所有文档和源码注释使用中文；运行协议、代码标识符、模型 ID 与必要术语保留原文。
- `npm run docs:check` 除检查中文与相对链接外，还从 Dataset、模型目录和 `.env.example` 校验关键事实；禁止通过复制常量在检查脚本中制造第二事实源。
