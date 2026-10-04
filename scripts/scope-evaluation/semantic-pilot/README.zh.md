# 语义上下文试验

[English](README.md) | 中文

## 摘要

本参考说明生产语义上下文后端的冻结六次调用试验。它保存获准报告、实际请求、原始回复、用量和确切缓存投影，供人工审阅。传输校准使用生产 DeepSeek 适配器和本地受控 HTTP 回复，并将真实模型尝试次数记录为零。

## 目录

- [准备与运行](#prepare-and-run)
- [证据与限制](#evidence-and-limits)
- [校准](#calibration)
- [开发备注](#dev-note)

<a id="prepare-and-run"></a>
## 准备与运行

使用 checkout 已安装的依赖、已构建的公共包和受支持的 Node 24 运行时。在仓库根目录运行 [driver](driver.mjs)，并指定新的绝对输出路径。以下命令使用示例路径；请替换为已构建的 checkout 和未使用的输出目录。

```sh
node scripts/scope-evaluation/semantic-pilot/driver.mjs prepare --repo /absolute/AgentHarness --run /absolute/pilot-result
node scripts/scope-evaluation/semantic-pilot/driver.mjs preflight --run /absolute/pilot-result
node scripts/scope-evaluation/semantic-pilot/driver.mjs execute --run /absolute/pilot-result
```

准备阶段冻结[试验](fixtures.json)、[审阅标准](rubric.json)、runner、Node 身份、已解析的公共入口文件、所属 manifest（元数据清单）和 CLI（命令行界面）入口。它不冻结完整的传递依赖图。预检通过生产 Task 服务接纳四条受控工具报告，不挂载模型提供方或加载凭据。执行通过私有的具名 `dsh` profile 挂载生产语义后端和 DeepSeek 适配器。这些报告是 fixture（测试前置数据），不是独立观察到的文件变更。

执行要求启动环境中的 `DEEPSEEK_API_KEY`，或在准备时通过 `--credentials-path /absolute/credentials.yaml` 指定既有生产凭据文件。试验产物仅保存该路径和凭据可用性元数据。真实调用使用 DeepSeek 官方端点。在有凭据的运行提供已记录结果之前，真实调用保持未验证；下述本地校准验证执行路径。

每个阶段目录以独占方式创建。已有阶段、已改动的冻结文件和不支持的参数都会被拒绝。保留失败或中断的结果；新建试验是独立计数的实验，不是免费重试。不要通过修改冻结输入来恢复已部分消耗的调用预算。

<a id="evidence-and-limits"></a>
## 证据与限制

试验对两种职责与三个报告 revision 的每个组合请求一次投影。它最多预留六次调用，串行执行，禁用适配器重试，并限制输入字节、输出 token、响应字节、单次调用时间和总运行时间。缺少用量记录会停止后续调用。已知用量按冻结费率估算；停止阈值不是供应商强制执行的金额上限。

每个已完成单元保存实际请求、来源映射、耐久预留与结果、原始输出、投影，以及判断为 `unreviewed` 的审阅记录。相同缓存读取不得产生额外请求或审计事件。进入流、适配器调用、观察到响应和真实模型来源分别计数。JSON 有效且引用确切的回复仍可能颠倒否定、保留过时事实或省略相关工作；审阅标准要求检查主张，并为这些错误提供反例。

这六个单元不运行普通接收 agent（智能体），不观察下游任务质量，不覆盖 Noise 或 Claude hook，不测量跨机延迟，也不比较不共享与其他共享方式。阶段成功证明执行与结构校验，不证明语义保真、任务收益或产品成熟度。[决策记录](../../../.agents/notes/implemented/architecture/2026-10-03-audited-semantic-context.zh.md)拥有审计理由。

<a id="calibration"></a>
## 校准

需显式启用的检查要求已构建 checkout，使用私有临时 home 和动态分配的回环端口。此 fixture 负责 POSIX 进程终止，因此排除 Windows。它不向外部模型发送请求。

```sh
DSH_SEMANTIC_PILOT_CALIBRATION=1 node node_modules/vitest/vitest.mjs run scripts/scope-evaluation/semantic-pilot/calibration.spec.ts --maxWorkers=1
```

[检查](calibration.spec.ts)观察真实 HTTP 调用、六次调用完成、零调用预检、缓存复用、重复阶段拒绝、缺失用量、格式错误回复、截止时间和冻结输入拒绝。检查等候具名 profile Host 退出及 HTTP 服务关闭后才删除私有文件。校准回复是受控数据；其获准投影仍保持语义未审阅。

<a id="dev-note"></a>
## 开发备注

无。
