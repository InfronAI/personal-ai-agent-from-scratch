# Personal Copilot Eval 命令速查

完整设计见 [系统化 Eval](../docs/EVALUATION.md)，唯一配置位于 `eval.config.json`。

## 离线门禁

```bash
npm run eval
npm run eval:ci
npm run eval:validate
```

默认离线模式使用版本化 Script 与注入依赖，不调用外部服务。

当前固定 Dataset 共 140 个场景，分布于 18 个版本化数据集，其中 69 个不依赖离线 fixture 的 Case 允许真实调用。80 个原创 Benchmark 方法适配题覆盖 27 个公开方法族：既包含 `MMLU-Pro`、`GPQA`、`GSM8K`、`TruthfulQA`、`IFEval`、`PubMedQA`、`LegalBench`、`FinQA`、`SWE-bench`、`LongBench`、`MMMU`、`BFCL`、`GAIA`、`tau-bench`、`HarmBench` 和 `XSTest`，也扩展到 `CRAG`、`BrowseComp`、`LongMemEval`、`LoCoMo`、`Multi-IF`、`HealthBench`、`FinanceBench`、`CyberSecEval 4`、`LiveCodeBench`、`SWE-Lancer` 与 `Spider 2.0`。题目、上下文与期望结果均为项目原创，这些结果不能表述为官方 Benchmark 分数。

新增切片把行业方法映射到 Copilot 的真实请求链路：输入与上下文、Intent routing、Agent 与 Tool、最终回答、Memory 与 Safety。每个新 Case 还声明 `workflow_stage` 和 `decision_use`，使页面、报告和发布决策可以使用同一份元数据下钻。

内置 Dataset 在 Web UI 的一级 `Eval Datasets` 页面只读呈现；用户反馈经人工审核后进入独立的 Feedback Golden Set，并支持有效、归档、恢复与导出生命周期。

Web UI 的一级 `Eval Runs` 页面用于管理实际测试生命周期：创建 Draft，选择 Profile 与一个或多个 Dataset，启动或取消真实 Runner，查看聚合结果、失败信号与脱敏日志，重跑并保留父 Run 血缘，以及归档或恢复历史。页面与 CLI 使用同一份 `eval.config.json`，不会维护第二套 Profile 或门禁。

只有完整 local 离线运行且阻断、诊断和执行错误均为零时，才可显式接受为发布基线：

```bash
npm run eval:baseline:accept -- --run evals/results/<完整离线结果>.json
```

## 真实运行

```bash
npm run eval:live -- --confirm-live
npm run eval:live:traced -- --confirm-live
npm run eval:live:judged -- --confirm-live
```

真实模式调用配置的 LLM Gateway 或 Web Search；`--confirm-live` 是强制确认。
LLM-as-a-Judge 的系统预设来自 `eval.config.json`；首次配置向导保存的 `COPILOT_EVAL_JUDGE_MODEL` 会覆盖预设，命令行 `--judge-model` 仍拥有最高优先级。

## Golden Set

```bash
npm run eval:golden:export
npm run eval:golden:live -- --confirm-live
```

第一条命令只导出人工批准的有效 Gold；第二条命令执行真实工作流与语义 Judge。没有有效 Gold 时导出会失败，不生成空数据集。

## 切片

```bash
node evals/run.mjs --profile local --suite core-routing
node evals/run.mjs --profile local --dataset-id core --dataset-id multiturn
node evals/run.mjs --profile local --risk high
node evals/run.mjs --profile local --task-type document_generation
node evals/run.mjs --profile local --case core-document-pdf-001
node evals/run.mjs --profile local --case core-model-selection-isolation-001
node evals/run.mjs --profile local --case core-multimodal-image-input-001
```

`--dataset-id` 可以重复传入，只运行配置中声明的目标 Dataset；未知 ID、重复 Case ID 或当前 Profile 最小 Case 数不足都会默认拒绝。Web `Eval Runs` 使用该参数冻结每次运行的 Dataset 范围。

## 对比与校准

```bash
npm run eval:compare -- --candidate evals/results/<candidate>.json
npm run eval:calibrate -- \
  --run evals/results/<judged-run>.json \
  --annotations evals/annotations/<human-reviewed>.jsonl
```

## Langfuse Dataset 与 Experiment

```bash
npm run eval:langfuse:sync
npm run eval:langfuse:run -- --run-name candidate-001
```

同步只上传允许真实运行的输入与公开上下文，不上传离线 Script 或伪搜索答案。

## 完整验证

```bash
npm run verify
```

该命令依次执行语法、中文文档、Eval 配置与基线校验、单元/集成测试和 CI Eval。
