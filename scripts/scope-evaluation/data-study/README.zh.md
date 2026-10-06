# 普通 Agent JSON 工作试验

[English](README.md) | 中文

## 摘要

本文定义可选试验 `payment-json-work-v1`：普通接收 Agent 自主产生 JSON 产物，由独立判分器验收。[驱动入口](../data-cli.ts) 分离准备、静态预检与显式执行。本机 HTTP 校准经过生产 provider adapter，但记录零次真实模型委派。完成注册或校准不能证明产品收益。

## 目录

- [任务与对照](#task-and-comparisons)
- [产物访问与评分](#artifact-access-and-grading)
- [注册与运行](#register-and-run)
- [证据与限制](#evidence-and-limits)

<a id="task-and-comparisons"></a>
## 任务与对照

源 Agent 写入支付策略，成功更正重试次数，再尝试一次找不到原文的编辑。生产原生文件工具与贡献采集将观察结果通过认证传输发布到拥有独立身份的 owner。源轨迹完成后才启动两个接收方。失败编辑只证明尝试发生，不代表策略已应用。

B 维护客户端策略 JSON；C 编写包含完整预期请求轨迹的验收用例。各条件中的接收方拥有相同初始公开文件、目标、模型路由和预算。B、C 按顺序运行，工具无法读取对方产物。N 不接收共享更新，E 接收已准入的原始报告，R 接收按职责生成的语义投影。驱动固定按 N、E、R 顺序运行，不实现共享摘要 S、随机化、重复试验，或存活接收 Session 内的持续更正与撤回。

N 的任务要求不编造缺失更新。因此，保留初始策略可以是合理行为，即使隐藏评分拒绝该策略。N 与 E 比较衡量已准入更新的可用性；E 与 R 才是投影行为的对应比较。单个合成任务和固定顺序不能证明一般模型能力或某后端更优。

<a id="artifact-access-and-grading"></a>
## 产物访问与评分

接收方只有受限文件读取、文件写入和公开诊断工具。精确文件清单由[注册项目](../data-study.ts) 持有，不暴露 shell、任意代码执行、目录枚举、同伴项目或隐藏评分工具。独立工作目录本身不是安全沙箱；访问限制针对这些模型工具，不约束同一操作系统用户运行的其他程序。

公开 schema 描述固定支付解释器。必填字段必须存在、非 null 且非空字符串；零和 false 有效。每次重试保留完整原始 body，未知外部错误绝不重试。公开文件是冻结的初始基线，C 的当前验收用例可以有意在旧基线上失败；公开诊断不披露隐藏成绩或更正后的策略。

每个 Session 结束后，父进程封存完整产物字节与摘要。[数据判分器](../data-artifacts.ts) 解析有上限且字段封闭的 JSON，由固定解释器计算请求。B 对私有输入验收；C 必须接受独立参考策略，并以实际轨迹差异区分所有注册的错误策略。无效、空、缺失或始终失败的用例不能算有效检出，C 的评分独立于 B 是否成功。既有 JavaScript [oracle](../oracle.ts) 保留受控源码限制；本试验不执行生成程序。

参考策略、私有输入和错误策略由父进程持有，不进入接收目标、公开文件或工具结果。模型产物、格式失败和行为失败与运行故障、受控校准结果分别记录。

<a id="register-and-run"></a>
## 注册与运行

使用仓库支持的 Node 版本与已构建公开包。提供符合 [parseDataStudyConfig](../data-study.ts) 的显式 JSON 配置：分别指定普通模型与语义模型路由、凭据引用，以及有限的调用、输入、输出、操作、清理和总时限。驱动只接受凭据环境变量名或绝对凭据文件路径，不接受凭据值。每条路由必须声明 `endpointSource`：`{ "kind": "deepseek-official" }` 选择官方 DeepSeek HTTPS endpoint；`{ "kind": "openai-compatible-gateway", "name": "服务名称" }` 显式标识兼容 HTTPS 网关。`provider: "deepseek-official"` 命名生产适配器，不代表实际接收请求的服务。Endpoint URL 不得包含凭据、查询参数或 fragment。传输校准仅接受显式本机回环 HTTP endpoint，且凭据文件引用必须为 null。

每条路由还必须选择 `network: { "kind": "direct" }` 或 `{ "kind": "env-proxy", "urlEnv": "https_proxy" }`。代理模式只在执行时解析该环境引用，要求 Node 支持 `--use-env-proxy`，并让 localhost 协调保持直连。代理缺失或无效时，在启动 Host 或预留模型调用前失败；代理值不写入注册记录。校准必须使用直连模式。

注册将服务声明、endpoint 和请求模型名冻结到 manifest。分享结果时应附带该文件：适配器记录用量与完成状态，但不保留成功响应的上游模型身份。因此，请求模型名不能验证网关实际使用的上游模型。

在仓库根目录运行，结果目录必须尚不存在：

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts prepare --run /tmp/payment-json-study --seed 20261004 --config /absolute/study-config.json --execution live
pnpm exec tsx scripts/scope-evaluation/data-cli.ts preflight --run /tmp/payment-json-study
```

准备阶段冻结任务与 oracle 身份、Node 身份、评测源码、解析出的公开 JS 入口、解析器依赖清单及 CLI 入口，不冻结完整传递依赖图。预检只核对这些字节，不加载凭据、启动 Host 或检查 provider 可用性。既有阶段不能静默重跑并重置预算；冻结输入变化时必须重新注册。

以下独立命令会委派模型，要求操作者选定模型账户和配置：

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts execute --run /tmp/payment-json-study
```

`ordinary.maxCalls` 约束每个条件中的每个 B/C；`semantic.maxCalls` 约束 R 的 owner。整个试验最多预留 `6 × ordinary.maxCalls + semantic.maxCalls` 次 provider 调用，源受控步骤另记。请求串行，先登记预留再委派，provider 自动重试关闭。用量缺失时停止后续委派和条件。运行器记录用量，不假设金额硬上限，也不把缺失用量当零成本。产物失败保留为结果；运行故障停止试验并使 CLI 非零退出。

<a id="evidence-and-limits"></a>
## 证据与限制

[原生运行器](../native-data-run.ts) 保存源工具结果、owner 收据与 revision、接收实际请求、恢复后的 Session 证据、公开诊断、委派记账、封存产物和 Host 清理结果。共享条件要求接收方的首次实际请求携带注册的 owner revision 与 backend。同一 HTTP provider 入口可以用本机服务校准；服务返回受控答案字节不构成模型推理评测。

可选[原生校准](../native-data-run.spec.ts) 要求 `DSH_NATIVE_DATA_EVALUATION=1`；[注册检查](../data-cli.spec.ts) 要求 `DSH_NATIVE_EVALUATION=1`；纯[产物检查](../data-artifacts.spec.ts) 和[任务检查](../data-study.spec.ts) 不需要 provider。这些检查不证明双人接入、跨设备连接、需求、真实工作延迟或语义质量。[决策记录](../../../.agents/notes/implemented/testing/2026-10-04-scope-data-artifact-study.zh.md) 说明受限产物格式的原因。

## 开发备注

无。
