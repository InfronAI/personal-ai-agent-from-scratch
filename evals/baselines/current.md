# copilot Eval 报告：offline-2026-09-02T04-32-44-934Z-0aa639

- 模式：offline-scripted
- Eval Profile：local
- 有效配置指纹：5e6327a0a3d4bfb0b8fb96514aef21812550a98f8992379d588c7ea2fed3019a
- Dataset 内容指纹：96d98ec96d0483718aea147c327de658ca7228600bd07e0c620e1046211dffb0
- 数据项：140
- Evaluator 检查：4812
- 阻断失败：0
- 诊断失败：0
- 执行时长：1039 ms

## 测试套件结果

| 测试套件 | Case 数 | 阻断失败 | 诊断失败 |
|---|---:|---:|---:|
| core-routing | 6 | 0 | 0 |
| document-generation | 2 | 0 | 0 |
| memory | 2 | 0 | 0 |
| output-contract | 1 | 0 | 0 |
| memory-lifecycle | 4 | 0 | 0 |
| artifact-grounding | 1 | 0 | 0 |
| intention-counterexamples | 1 | 0 | 0 |
| model-routing | 1 | 0 | 0 |
| multimodal-input | 1 | 0 | 0 |
| multi-turn | 5 | 0 | 0 |
| harness-adversarial | 5 | 0 | 0 |
| safety-adversarial | 1 | 0 | 0 |
| intention-policy | 2 | 0 | 0 |
| recovery-adversarial | 2 | 0 | 0 |
| general-knowledge | 5 | 0 | 0 |
| vertical-capabilities | 6 | 0 | 0 |
| performance-resilience | 5 | 0 | 0 |
| safety-compliance | 5 | 0 | 0 |
| agent-capabilities | 5 | 0 | 0 |
| benchmark-knowledge-reasoning | 10 | 0 | 0 |
| benchmark-professional-domains | 12 | 0 | 0 |
| benchmark-agentic | 12 | 0 | 0 |
| benchmark-safety | 6 | 0 | 0 |
| benchmark-grounded-research | 8 | 0 | 0 |
| benchmark-memory-personalization | 8 | 0 | 0 |
| benchmark-multilingual-instruction | 6 | 0 | 0 |
| benchmark-high-stakes-professional | 6 | 0 | 0 |
| benchmark-cybersecurity | 4 | 0 | 0 |
| benchmark-software-data | 8 | 0 | 0 |
| workflow-contract | 0 | 0 | 0 |

## 未通过项

无。所有检查均通过。

## 解释

阻断失败表示已批准的工程契约被破坏；诊断失败表示已知架构债务或尚未升级为发布门禁的信号。规约推导样本验证的是产品契约，不代表真实用户分布或人工标注的回答质量。
