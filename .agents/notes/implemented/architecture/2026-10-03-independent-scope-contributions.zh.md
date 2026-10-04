# Agent Note：独立 scope 贡献与当前证据

Status: implemented

[English](2026-10-03-independent-scope-contributions.md) | 中文

## 问题

独立协作者需要从普通工作中贡献信息，无须加入 owner 的互信 Mesh、复制其 Task 或手动发布每次更新。接收邀请不授予文件访问权或写入权。回复丢失、采集许可替换与 owner 撤销都不能造成重复证据，也不能恢复已终结的来源。

## 决策

[Claude scope](../../../../packages/collaboration/claude-scope/README.zh.md)为一个 Session 记录本地采集许可，支持的选择由[来源模式决策](2026-10-03-independent-tool-observations.zh.md)定义。不含路径的 proposal 标识贡献者 PeerId 与耐久 capture generation。Owner 独立批准该 proposal 对应的本地 Root Task、精确来源许可、到期时间、样本数和样本字节限制。独立的 [scope-access 贡献邀请](../../../../packages/collaboration/scope-access/README.zh.md)只有通过在线 owner 核验后才激活已准备的采集。读取订阅与贡献许可各自拥有生命周期。

[Task 服务](../../../../packages/collaboration/development-task/README.zh.md)在耐久队列中串行处理授权、准入和终结事件。认证来自 transport；publication 保留贡献者 PeerId，不虚构 Mesh 节点或 participant。Owner 根据获批 selector 生成出处，并在 OpenAPI 模式下生成工件身份。精确重试恢复原 receipt；既有来源的正文变化会被拒绝。Receipt 区分批准、采样和终结提交。来源端保留 outbox 或待撤回记录，直到收到匹配的 owner receipt。

只有获授权的 Write 或 Edit lease 才采集许可的来源。Hook 在等待本地队列前保留其 capture generation。替换许可不能授权较早排队的 Hook。接收的上下文和生成的投影不是采集来源。OpenAPI 采样中的无效或缺失文件产生明确的不可用证据，而不是让旧的有效字段保持当前状态。

Grant 到期、owner 撤销和贡献者离开均产生终结 Task 事件并撤下当前证据。`currentContextView` 在返回当前输入前完成 owner 到期处理；消费者也在异步投影后重新检查。持久化失败会拒绝当前交付，包括缓存文本。新提交的终结事件使捕获投影失效；普通新采样可以等待下一次请求。非 owner 的 Mesh 副本遇到有效独立同伴证据时拒绝交付，因为复制无法确立 owner 当前的授权。冻结父 revision 仍为历史记录。

[上下文后端](../../../../packages/collaboration/development-task-context/README.zh.md)区分 Peer 与 Mesh 来源身份，归约 OpenAPI 同一来源的版本，保留独立冲突，并在完整文本预算内排除已终结证据。同伴出处确立已认证的报告者，不证明其声称的文件内容或工具执行为真。为贡献终结预留的入站和出站容量，防止本 scope 服务的普通读取和采样用尽终结槽位；无关 transport 使用方不在该保证内。

## 考虑过的替代方案

**复用 Task checkout 授权。** 独立用户不必拥有复制的 Task、Mesh membership 或 owner 控制的 Session。分离采集与贡献授权可保留这些独立职责。

**在 scope access 保留第二张写权限表。** 分别提交的权限和 Task publication 可能在故障后不一致。Task 事件是唯一 owner 权威；scope access 负责认证并限制请求。

**让到期 timer 承担正确性保证。** 失败的 timer 无法证明耐久撤回。请求时检查阻止交付，直到 owner 提交到期事件。Timer 记录失败，不进行零延迟重试循环；后续操作或 Task 变化触发再次尝试。

**接受 Mesh 副本缓存的独立证据。** 副本无法知道尚未收到的 owner 撤销。在线 scope 读取提供该授权依据；历史继承快照仍明确属于历史。

## 影响

独立工作流在普通获授权工具工作后自动贡献有界来源观察，并可驱动既有原生接收和有限启动机制。配置仍需要明确的本地采集许可、owner 批准和独立接收邀请。[来源接入控件](2026-10-03-independent-contribution-controls.zh.md)管理准备、批准和恢复。通用语义提取、原生工具采集与跨机器发现仍需要各自的产品验证。

已提交的 Task 代际和既有 SQLite 表保留身份。新 Peer publication 使用规范序列化，支持上下文 hash 与恢复。终结 grant 会移除当前注入的证据，但不能撤回已经发出的字节、抹除历史请求，或证明模型已经遗忘它们。

客户端安全的 Task DTO 入口在声明事件扩展前加载 Cordis 类型。仅类型的空 export 保留在声明产物中并从 JavaScript 擦除；空的 type import 无法为声明消费者保留该顺序。NodeNext 产物检查独立编译先导入 DTO 的消费者，防止更广的服务导入掩盖 Context 扩展缺失。
