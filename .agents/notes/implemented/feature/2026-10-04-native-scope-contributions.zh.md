# Agent Note：原生 scope 贡献采用实际工具执行与独立来源许可

Status: implemented

[English](2026-10-04-native-scope-contributions.md) | 中文

## Problem

读取邀请和本地目标允许接收上下文与有限执行。两者均不授权将原生 Session 的文件工作发送给其他所有者。根据工具名称或回调正文猜测效果的来源，可能误归属被覆盖的同名工具、合成取消结果，或原始 Session 记录尚未持久化的完成。

## Decision

[原生贡献 Consumer](../../../../packages/collaboration/scope-agent-contribution/README.zh.md) 接受一次显式的当前 Session 选择：文件根、write/edit 操作、owner 入口与来源限额。Owner 批准可以缩小这些限额。服务在审批和地址重试期间保留同一个不可变 proposal；本地读取与来源选择必须指向相同 owner 和 Task。其他 Agent 实例、fork 和委派 Agent 不继承此许可。

[文件工具](../../../../packages/fs/tool-fs/README.zh.md) 在策略和意图检查之后发出实际归一化修改尝试，并提供执行操作的 filesystem provider 和已解析目标。来源检查该 provider 的身份与规范路径包含关系，再将尝试关联到普通工具日志或 PTC 子调用日志。最终日志中的失败仍作为失败报告。Session 持久化检查点先于来源序号和样本的原子持久化。不需要扫描聊天、重新采样文件或传输原始错误正文。

有界完成队列在 Session 刷盘或 domain 写入暂时失败时保留原始尝试和结果。同一个后台任务先重试本地持久化，再发送精确 outbox 记录，无需新工具调用或管理操作。未改变的来源申请保留未完成观察与原始 live Agent 关联。停止、Agent 释放、读取目标冲突及恢复的来源记录都会终结采集。终态回执使其报告退出 owner 的当前证据，历史日志仍然保留。

[共享贡献控制器](../../../../packages/collaboration/scope-access/README.zh.md) 统一负责原生与 Claude adapter 的批准、精确重试、回执检查及终结。各 adapter 自行负责本地许可、来源归属、存储记录与后台任务生命周期。Peer IO 在本地状态串行提交之外执行。抽取保留 Claude 的耐久数据表示和现有工具授权规则。

## Alternatives considered

**把读取或自动执行许可当作来源许可。** 来源用户没有选择外发文件或工具，读取权限不授权发布。

**采集所有工具结果正文。** 渲染和迟到取消可能与实际文件操作不同。真实修改尝试和已记录的最终结果能说明报告含义，无需复制无关工具输出。

**存储失败时丢弃完成记录。** 文件可能已经修改。保留有界原始证据可在恢复后继续处理，无需从已经变化的文件制造新观察。

**复制外部 adapter 的 owner 协议。** 两套实现容易在 grant、精确回执或撤回上偏离。共享控制器保留协议权威，同时让各来源自行负责文件授权。

## Consequences

重试需要运行中的来源 Host 和保留的 owner 地址。尚未进入耐久来源存储的内存完成记录不能跨进程崩溃保留；重启会结束原采集。同 Host 的 Task assignment 需要另行授权的[本地采集路径](2026-10-04-owner-local-scope-contributions.zh.md)；绑定本身不授予来源许可。整字段省略在字节限额下保留报告归属；工具报告不证明当前完整文件内容或模型理解。

真实 Loader 场景覆盖普通与 PTC 文件工作、耐久来源坐标、owner 发布、接收方请求、撤回与本地存储故障恢复。Keyless 模型流证明请求组装和回放，不证明语义任务质量或相对单 Agent 的收益。
