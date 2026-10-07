---
description: "@deepseek-ai/dsh-development-task 负责共享上下文原子的不可变 Root、Fork 和 Merge 谱系"
kind: "package-reference"
---
# 开发 Task

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-task` 通过不可变的 Root、Fork 和 Merge 谱系共享已准入上下文。Task 包含名称、初始上下文、publication、固定父 revision 和运行时元数据，不提供任务生命周期工作流。Owner 可以批准互信 Mesh 观察，或另行授权独立 peer 贡献。每个 Task 确定性关联一个隐藏 Room，该 Room 只用于可修复的运行时 membership。

## 目录

- [语义](#semantics)
- [观察上下文准入](#observed-context-admission)
- [远端观察授权](#remote-observation-authority)
- [独立 peer 贡献](#independent-peer-contributions)
- [Owner 本地工具贡献](#owner-local-tool-contributions)
- [Remote API](#remote-api)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="semantics"></a>

## 语义

- Root 没有父节点；Fork 固定一个准确的父 revision；Merge 固定两个至十六个不重复的父 revision。父边创建后永不修改。
- Fork 和 Merge 创建独立 Task，不修改父 Task，也不改变父 Task 状态。
- 继承 block 包含每个父 Task 在所选 revision 的名称、初始上下文和已准入 publication。本 service 不采集私有 Session、工具或编辑器历史，也不采集模型推理。
- 调用方可在执行默认 256 KiB block 限制前排除部分 publication。超限返回 `LIMIT_EXCEEDED`，不会截断内容。
- 每个 Agent Session 持有一个不透明 binding id。同一 Cursor、Codex 或 Claude 身份的多个 Session 可以连接不同 Task，互不替换。
- Binding 先于 Room 协调提交。加入新 Room 与离开不再使用的旧 Room 分别报告结果；模型上下文只读取 binding。退出命令可以要求界面所显示的 checkout 代际；所有者队列会在终结本地贡献或清除新绑定前拒绝过期命令。

<a id="observed-context-admission"></a>

## 观察上下文准入

可信 Host adapter 调用 `admitObservedContext`，提交已授权的观察内容及其操作开始时捕获的 binding 区间。执行器要求 Task 由本节点拥有、参与者是本地 Agent，并且当前参与者、Task、binding 和 epoch 均匹配。过期或已清除的 binding 在去重前即被拒绝。采集授权和观察内容过滤仍由 adapter 负责；该方法不暴露 Remote endpoint。

调用方提供来源身份的小写 SHA-256 digest，其中包含 binding 区间。方法沿用显式 publication 的文本规则，去掉首尾空白并执行 `maxTextBytes` 限制。同一来源和有效内容重试返回 `reused`、原 publication，且不增加 revision；文本、发布者或观察元数据不同则以 `INVALID_REQUEST` 拒绝。新来源在既有持久化事件成功后返回 `published`。Task 日志重放即可恢复去重，不需要独立账本。即使文本相同，不同来源也保留为独立观察。[准入决策](../../../.agents/notes/implemented/architecture/2026-10-02-observed-task-context-admission.zh.md) 说明归属与重试规则。

可选的版本化 OpenAPI observation 记录支持范围内的完整 operation 采样、无效文档、不可用文件或已结束授权。Task 准入填写来源 digest、观察节点和原 binding 区间。文件授权、字节 digest、工件身份与采样序号由读取器负责；序号表达同一观察节点、工件和授权内的观察顺序，不代表操作因果。新来源必须递增序号，且不能更改发布者、operation、来源名称或 binding 区间。即使已有更新采样，已准入内容的精确重试仍可复用。把 observation JSON 复制到显式 publication 中不会生成可信元数据，Remote publication 也不能提供该元数据。

`revokeObservedArtifact` 是独立的 Host-only 终止准入。它要求先前证据的发布者、工件、授权、operation、来源名称和 binding 区间均匹配，因此可以在 binding 清除或 Agent 离开后结束本地观察链。已撤销的链不再接受新采样；新的授权需要新的 grant 身份。每条活跃本地观察链在 `maxEventsPerTask` 内预留一个事件名额，普通写入不能使用该名额。撤销使用自身的预留名额，不超出事件上限。`maxTextBytes` 分别限制完整 observation JSON，包括准入填写的字段；继承 block 的既有完整预算和 digest 也包含该元数据。

Storage 和 Mesh 保留相同的可选元数据，publication 的子对象不可变。没有元数据的记录保持原序列化内容和继承 block id。SQLite Task unit 使用版本 1。Observation 将采样归属到来源节点；另一个 Task owner 记录远端准入。Block digest 验证内容完整性。这些记录均不证明接收 Host 读取过工件。消费者决定哪些观察可作为当前证据。

<a id="remote-observation-authority"></a>

## 远端观察授权

Task owner 显式批准远端 Agent、binding 及 binding epoch 后，该来源才能提交观察。批准必须指向已知远端 Agent，但不要求其 assignment 副本已经到达。候选发现使用复制的当前 binding，因此可能延迟；候选不证明已连接 Claude，也不代表文件读取许可。本地采集授权由来源 adapter 负责。

普通观察和工件采样都需要已批准的区间。Mesh dispatcher 从已认证 peer 获取来源节点，Task 准入将其与批准记录核对。Publication 记录所属区间；工件证据另行记录观察节点。Receipt 标识原始持久 owner 事件及 revision。即使已有后续 publication 或区间已结束，精确重试仍返回该 receipt。响应仅包含结果状态、原 publication 和 receipt，因此 Task 历史不会增大每次确认的内容。Receipt 证明 Task 持久化，不证明模型收到或使用了内容。

来源或 Task owner 均可永久结束区间。一个持久 owner 事件关闭准入，为该区间每条当前工件链派生确定性的撤销记录，并为普通观察添加带类型标记的撤回通知。每个活跃区间预留一个终止事件名额，即使尚无采样。结束请求可以先于批准到达，并留下延迟批准无法重新打开的终止身份。持久化失败不改变区间；传输失败后须重试同一身份。在 owner 队列中先于终止排队的准入仍可提交；排在其后的新来源会被拒绝。

终止保留历史 publication 和冻结的继承快照。消费者选择当前上下文时使用撤回元数据；结束区间不会移除模型已经准入的文本。此协议假设 Mesh 成员互信：共享凭证和复制的 Task 数据不提供独立用户身份或逐 Task 读取隔离。

<a id="independent-peer-contributions"></a>

## 独立 peer 贡献

已认证的 Host facade 为本地 Root Task、贡献者 PeerId、capture 代际及精确来源许可调用 `openPeerContribution`：来源可以是一个 OpenAPI 操作，或明确的文件／命令观察许可。Grant 限制有效期、样本数和完整样本字节。它不授予本地采集、Task 读取、Room membership 或任意发布权限。来源适配器单独授权采集，transport 提供已认证 peer。Peer publication 记录 `peerContribution`，以及 OpenAPI 的 `peerObservation` 或有序的 `peerToolObservation`，不虚构 participant 或 Mesh node。解析公开 capture 申请不会建立授权。

批准、样本准入和终结共用 Task owner 队列与事件日志。`admitPeerContribution` 派生来源归属及规范报告正文；OpenAPI 来源还获得逻辑工件身份。新样本必须在该 grant 内递增序号；重复不消耗额度。即使终结或降低新准入字节上限后，精确样本和终结重试仍返回原 receipt，不触发新的到期写入。更改内容或授权会被拒绝。Receipt 包含原事件种类、revision、来源身份和完整 payload digest；它证明持久准入，不证明工具执行、文件真实性、模型交付或内容真相。

文件工具样本包含报告结果、根目录序号、相对路径、工具字段及明确的整字段省略。失败报告不包含被尝试的成功正文。Owner 在派生归属和规范文本前核对允许的工具及来源种类；绝对根目录和 Session 标识不属于元数据字段。工具观察按序追加，不替代文件快照。结束 grant 会撤回该区间的全部当前报告，同时保留历史。[工具观察决策](../../../.agents/notes/implemented/architecture/2026-10-03-independent-tool-observations.zh.md)说明证据限制。

已记录工作报告要求来源具有明确的第 2 版 `recorded-local-tools` 许可。其第 2 版 origin 用摘要标识冻结的选择和执行证据，规范正文将报告标为此前记录、未经重新执行或当前文件核对的操作尝试。普通工具 grant 拒绝此变体；本地报告不会获得历史来源标记。已记录与实时报告共用同一有序 grant、额度、重试和终结撤回。[已记录工作决策](../../../.agents/notes/implemented/feature/2026-10-07-recorded-work-on-scope-join.zh.md)说明来源选择及独立许可。

第 3 版工具来源明确授权 `fileContent: completed-native-file`。本地和同伴的第 3 版报告保留原工具参数，并单独包含原生操作返回的 LF 文本及 SHA-256 摘要，或明确的整字段省略（`tool-failed`、`budget` 或 `unavailable`）。这是该次操作的结果文本，并非当前磁盘快照。准入和恢复要求第 3 或第 4 版来源中相匹配的完成文件许可；普通与历史许可不能获得该能力。失败报告不能包含完成文本。Receipt 和继承块摘要覆盖完整的获准结果。

第 4 版工具来源明确授权精确的前台命令和工作目录根索引，并可同时包含 Write/Edit 与完成文件许可。文件工具集合可以为空，命令选择不能为空。命令结果分别保留退出码、信号、超时与中止字段，完整 stdout/stderr 或明确的预算省略，以及 provider 截断标记。缺少完成证据或最终工具失败标为不可用，不能推定成功。这些报告记录一次执行，不证明当前代码通过验证。准入核对精确选择与来源版本；旧文件及历史许可不能授权命令。命令 receipt、继承块与撤回保留相同的完整证据及授权区间身份。

`endPeerContribution` 允许来源退出或 owner 撤权。它记录一个终结事件，派生撤回证据和通知，并拒绝后续激活或新采样。即使 grant 尚无采样，也在 `maxEventsPerTask` 内预留该事件；先于批准到达的 end 留下永久 tombstone。历史采样与继承快照保持原样。`expirePeerContributions` 在同一队列中终结任意 origin 的本地所有 Task 的到期授权；facade 还在启动时核对到期状态。采样字节上限约束新准入；恢复保留历史字节，并拒绝无法终结活跃 grant 的容量配置。

Host 消费者在延迟投影前后调用 `currentContextView`。它先提交本地到期终结，再捕获上下文；如果 Mesh 副本包含活跃的直接 peer 或 owner 本地采集证据则拒绝，因为副本无法证明 owner 的当前授权。本地 Fork 和 Merge Task、不含活跃直接 peer 或 owner 本地采集证据的副本，以及冻结的继承历史仍可读取。新增终结通知会使捕获的投影失效；普通新采样可以等到下一次请求。`contextView`、Remote 的 `context` 方法和 `peerContributions` 只提供已存历史或状态，不执行此当前权威检查。

<a id="owner-local-tool-contributions"></a>

## Owner 本地工具贡献

Host-only 的 `openLocalContribution`、`admitLocalContribution`、`localContributionStatus` 和 `endLocalContribution` 授权 Task owner 自己的 Agent，不经过 self-peer transport。许可绑定一个本地 Root Task、参与者、binding epoch、capture 代际和明确的文件／命令选择。有效期、样本数和完整样本字节均有上限。来源消费者另行负责文件根目录同意和采集；Task 准入核对原 assignment，且新样本必须仍属于同一本地 Agent 的当前 binding。

每个 capture 预留一个终结事件。状态及当前上下文读取先提交到期或失效绑定的终结再返回；clear 和 checkout 先结束 capture 再改变 binding。Agent 离开或 binding 改变后仍可显式终结。先于打开的终结留下关闭的代际。终结后，已准入内容的精确重试仍返回原 receipt，但修改许可或新样本不能重开该代际。持久化失败时，不会把受影响的授权变更报告为已完成。

本地 publication 保留真实的 `publishedBy` 参与者、原 binding epoch 和 `localContribution` 授权；有序的 `localToolObservation` 报告保留文件路径或命令选择及整字段省略。这些标识可能派生自 Session 身份，已授权的 Task 读取者可以看到。绝对采集根目录不属于元数据字段；工具文本本身仍可能包含私有数据。报告描述观察到的操作，不代表完整当前文件。终结通过上下文后端撤回区间中的所有当前报告，同时保留存储历史与冻结的继承快照。来源消费者负责在卸载或重启时终结；Task 准入自身不采集工具，也不调度空闲 Agent。

<a id="remote-api"></a>

## Remote API

Task 投影和上下文变更使用 `developmentTasks/list`、`get`、`lineage`、`create`、`publishContext` 和 `context`；`create` 返回 `{ task, runtime }`。Session binding 使用 `developmentTaskAssignments/list`、`checkout` 和 `clear`，已交付 revision 由内部 acknowledgement endpoint 确认。`checkout` 是连接或切换单个 binding 的内部 Remote 名称，不是 Task 生命周期操作。

绑定变更通知在清除后携带 `null`，使完整事件可通过 JSON Remote 传输。本地 assignment 查询对未绑定会话仍返回 `undefined`；持久绑定日志记录 `task-cleared`。

`acknowledge` 接受可选的 `expectedBindingEpoch: { nodeId, seq }`，标识预期 binding 区间的 `task-bound` 事件。串行执行器在记录确认前以 `INVALID_REQUEST` 拒绝不匹配的区间，包括 Session 切换离开后又返回同一 Task 的情况。原生上下文消费者始终提供此校验字段。确认记录 revision 的交付，不证明模型读过每一项事实。

<a id="configuration"></a>

## 配置

所有留存和重试字段都必填。Web bundle 使用 10,000 个 Task、每 Task 2,000 个事件、16 个 Merge 父节点、256 KiB 继承 block、500 个 Task 的谱系查询上限，以及五秒隐藏 Room 重试间隔。

如果降低后的 `maxEventsPerTask` 无法容纳恢复的本地事件，以及活跃本地工件授权、活跃远端区间、独立 peer 贡献和 owner 本地采集所需的撤销名额，启动会拒绝该配置。应增大配置容量；恢复不会删除或重写记录来适配上限。

<a id="model-experience"></a>

## 模型体验

无，因为 Task service 只暴露 Host API，并把模型准入交给 context Consumer。

#### KV Cache 影响

无；本包不组装模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 不支持 Task 删除、rebase 或父边编辑。
- Merge 记录并标注来源上下文，但不自动解决语义冲突。
- 不支持任意事件 revision checkout 或完整 Session 继承。
- 观察上下文准入不采集外部工作，也不验证语义真相。独立 peer 认证、本地采集许可和 Task 读取授权分别由对应消费者负责。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
