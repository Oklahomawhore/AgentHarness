# Agent Note: 获授权的 Claude 观察与外部上下文准备

Status: implemented

[English](2026-10-02-claude-scope-adapter.md) | 中文

## Problem

独立 Claude 会话没有共享的原生 Session 日志，也没有共同的准入点。会话切换 Task 后 hook 才可能完成，也可能因响应丢失而重试，或来自 subagent。自动复制会话历史会绕过来源授权；把 stdout 成功记为模型准入则夸大了 Host 能观察的事实。

## Decision

[Claude scope 适配器](../../../../packages/collaboration/claude-scope/README.zh.md) 只有在经认证的本地加入操作选择职责、Task、允许目录根和精确 Bash 命令后，才连接已观察到的主会话。稳定的本地会话身份由安装身份与 Claude session id 组合而成，不使用工作目录。Task 成员身份和采集授权共享一个耐久区间。SessionEnd 清除授权；恢复会话不会静默恢复采集权限。

PreToolUse 保留摘要和起始 Task 区间，不持久化完整工具输入。完成时先独立重新授权规范路径与精确输入，再调用[观察式 Task 准入](2026-10-02-observed-task-context-admission.zh.md)。A-to-B-to-A 重新绑定、输入变化、符号链接目标变化和撤销策略都不能把迟到结果改投新任务。Subagent 和不支持的工具不在本适配器的采集策略内。

Write 和 Edit 发布有界的原始请求字段及 Claude 报告的结果。前台 Bash 只发布支持的原始输出字段。这些是来源观察，不是经独立验证的事实。整字段省略在完整 UTF-8 预算内保留原始内容与归属。终结结果和正文摘要拒绝矛盾重试；Task publication 仍是提交与去重权威，因此准入失败后可以重试。

会话变化、采集和最终投影准入通过适配器变更队列串行处理。后端计算在队列外运行，最终检查拒绝过期授权及已替换的 provider。退出完成意味着 binding 已清除。更早被接受的 publication 保留在 Task 历史中，已返回的输出可能仍留在外部进程或会话里。

共享[上下文后端](2026-10-02-recipient-task-context-backend.zh.md) 准备接收者文本和来源覆盖情况。本适配器先持久化确切输出，再通过 UserPromptSubmit 或 PostToolBatch 返回。Claude 的只追加 hook 交付接收前驱标记，断开后收到明确的撤回通知。外部准备输出记录不伪造原生 Session id、原生日志事件、Task 投影确认或模型采用证据。

命令只通过常规 `dsh --profile` 应用运行。它等待应用就绪、读取有界 stdin、通过 Connection 认证、检查 Host generation，并在退出前完整输出一份有界 Hook JSON。EOF 结束输入采集，不结束请求。私有描述符和生命周期 OS 锁防止 Host 同时拥有描述符；取消处理负责等待传输与输出结束。

## Alternatives considered

**使用 room 聊天记录作为共享上下文。** 这要求 agent 或人选择消息，并给每个接收者重复同样的内容。工具观察与后端选择让来源和交付策略独立，不需要聊天界面。

**使用工作目录作为会话身份。** 两个独立拥有的会话可以在同一目录工作。身份必须在重启后保持稳定，同时不能合并它们的权限或职责。

**在 Task publication 之前将适配器 lease 标记为已提交。** 崩溃或存储失败会抑制从未提交的结果。Lease 只约束重试身份，Task 的耐久 publication 决定准入是否发生。

**把 stdout 视为模型确认。** 命令无法观察 Claude 的最终请求或推理。准备输出和真实模型采用实验分别提供证据，无须伪造原生回执。

## Consequences

对于受支持的工具活动，显式加入取代了逐条决定发布内容。[API 采样决策](2026-10-03-sampled-api-context.zh.md) 拥有独立授权的文件证据及其受支持的事实投影。远程 Task 要求[观察 Task 准入](2026-10-02-observed-task-context-admission.zh.md)定义的显式来源区间。适配器不唤醒空闲 agent、不建立独立 peer 身份或 Task 读取权限、不调和任意语义主张、不在缺少显式配置操作时安装用户设置，也不实现 latent 通信。[Scope 产品提案](../../proposed/architecture/2026-10-02-scope-context-backends.zh.md) 继续覆盖这些更广的要求；后端和观察准入决策保留各自的归属与理由。

验证需要真实 Loader 组合覆盖持久成员身份与来源准入、真实 profile 子进程覆盖认证及 EOF/输出结束，还需要单独的外部模型实验验证采用。竞态回归覆盖撤销/重入和终结重试身份。采集检查覆盖解析后的路径、精确输入、不支持的载荷、报告失败和整字段字节预算。传输成功本身不能完成产品验收。

当源 patch 附近没有对应包时，SDK 回放通过[快照支持包](../../../../packages/test-support/session-snapshot/README.zh.md)已声明的依赖解析模型 fixture provider。源 patch 的解析结果仍优先。隔离 profile 的验证因此不依赖未声明的仓库根目录别名，也不改变生产 SDK 启动或搜索无关工作区包。
