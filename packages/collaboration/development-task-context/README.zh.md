---
description: "通过可替换后端为原生 Agent 已连接的 Task 选择有界上下文，记录耐久来源覆盖信息，并在断开连接后撤回注入内容"
kind: "package-reference"
---
# 已连接 Task 上下文

[English](README.md) | 中文

## 概述

原生 Harness Agent 在下一次获准进入的请求中接收其已连接 Task 的上下文。每个 Session 获得由显式挂载的后端按 participant 选择的有界投影。修改或清除 binding 会更新注入的 Task 消息；Session 日志保留此前请求使用的上下文。

## 目录

- [配置](#configuration)
- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="configuration"></a>

## 配置

在 Agent 与 Task 服务之后挂载一个后端及其消费者。文本后端不需要配置；必填的 `maxContextBytesPerStep` 限制交付文本的完整大小，包括包裹文本。

```yaml
- name: '@deepseek-ai/dsh-development-task-context/text'
- name: '@deepseek-ai/dsh-development-task-context'
  config:
    maxContextBytesPerStep: 65536
```

将 `/text` 换成 `/reported`，即可在不调用模型的情况下重建满足条件的文件报告组。这两个提供方都不需要配置。Web profile 挂载 `/configured`，默认选择 `/reported`；`/text` 保留原始 publication。

要交付采样得到的 OpenAPI 声明，将 `/facts` 挂载为后端。其 `routes` 精确匹配接收者完整的 Session 标签；`unmatchedFields` 显式指定标签缺失或未匹配时选择的字段。这两个数组都必填。字段名属于闭合集合；重复字段、重复或空白职责标签会使配置失败。空字段集合仍保留状态与出处；冲突组始终保留全部声明字段，并报告额外选择的字段。标签不授予访问权限，也不确立事实真伪。

```yaml
- name: '@deepseek-ai/dsh-development-task-context/facts'
  config:
    routes:
      - responsibility: frontend
        fields: [requiredRequestFields]
    unmatchedFields: [operationId, requestBodyRequired, requiredRequestFields, responseStatuses, deprecated]
- name: '@deepseek-ai/dsh-development-task-context'
  config:
    maxContextBytesPerStep: 65536
```

<a id="semantic-backend"></a>

### 语义后端

将 `/semantic` 与既有 LLM 和 Session 服务组合，即可按 Task 目标及接收者职责总结普通 publication 和获授权的 Write/Edit 报告。选择已安装的 provider/model 路由，并明确设置执行限额。`temperature` 与 `reasoningEffort` 可选；预备调用会记录实际生效的适配器配置。ScopeAccess 与传输超时须容纳配置的计算时间和交付时间。

将其 JSONL 持久化放在独立目录与隔离的 `sessionPersistence` group 中。prepared Session 不进入活跃 store，但普通 Session 查询仍会发现其持久化目录中的日志。后端仍可在 group 外使用；审计服务不会替换普通 Session 持久化。每个部署预算保持稳定的 `auditSessionId`，重启后也不更换。持久化隔离改变的是普通查询的可见性；获授权的来源文本仍会发送给配置的模型提供方。

```yaml
- name: cordis:group
  group: true
  isolate:
    sessionPersistence: true
  config:
    - name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('context-audit')
        compression: none
    - name: '@deepseek-ai/dsh-development-task-context/semantic'
      config:
        auditSessionId: shared-work-audit
        provider: my-provider
        model: my-model
        maxInputBytes: 131072
        maxCapturedInputBytes: 1048576
        maxOutputTokens: 4096
        maxOutputBytes: 65536
        timeoutMs: 20000
        maxConcurrentCalls: 2
        maxCalls: 100
```

后端在模型发出请求前记录并 flush 请求，在返回前记录并 flush 有界响应、提供方报告的用量及确切投影。已经完成的相同请求复用审计结果；并发的相同请求共享一次计算。`maxCalls` 统计同一审计 Session 下所有配置版本的持久调用预留。明确失败的尝试可以在剩余额度内重试。中断后没有结果记录的请求保持未知状态，不会静默重发；其预留仍计入已用额度。提供方未报告的用量是未知值，不是零。这些限额不构成精确的输入 token 或金额上限。

请求版本 2 将完整捕获证据与实际模型消息分别保存。模型覆盖信息中只有已替代的 publication 身份改为按精确 Task 修订号计数；当前证据、其他省略和来源归属均保持精确。`maxInputBytes` 限制 UTF-8 系统及用户文本；`maxCapturedInputBytes` 在新计算前独立限制完整规范化捕获 JSON。两者都不是整条审计事件的大小，因为事件同时保存这两种表示。没有可摘要来源时，计算检查捕获与交付限额，不准备或预留模型调用。恢复按记录版本校验每条保留请求，包括失败和未完成预留，拒绝不一致的捕获或模型文本；新部署限额不追溯拒绝原先有效的记录。

### Web 后端设置

`/configured` 注册重启生效的 `scope-context` 命名空间，包含 `mode`、`provider`、`model` 和累计 `maxCalls`。通过身份验证的 Host 管理页在**插件 → 协作摘要**中提供这些字段。保存选择下次启动的后端，不替换运行中的 provider，也不改变普通 Session 的模型。打开设置、保存和启动 Host 都不会预备摘要调用。语义模式要求非空路由；计算需要路由或凭据时若不可用，会明确失败，不回退到报告模式。

Web 部署默认交付报告，调用上限为100次。审计保存在 `dshHomePath('scope-context-audit')`，Session ID 为 `scope-context-audit`，与普通 Session 查询隔离。更换路由或停用后重新启用摘要都会保留累计预留。审计身份与执行限额由部署配置负责，不属于设置表单。调整自定义部署时保留原目录与 Session ID；插件不会发现或迁移其他审计日志。[用户指南](../../../docs/user/guide/collaboration-semantic.zh.md)说明设置与恢复步骤；[决策记录](../../../.agents/notes/implemented/feature/2026-10-07-configured-collaboration-backend.zh.md)解释为何由重启应用选择。

<a id="behavior"></a>

## 行为

文本后端保留 Task 的 objective、scope、谱系和继承来源的 objective 与 scope。它在剩余预算内选择完整 publication，优先保留较新内容，并省略接收者自己发布的内容。对类型化 OpenAPI 观察，后端先按工件和来源链保留最大的采样序号；即使最新记录无效、不可用或过大而放不下，旧记录仍标为 `superseded`。相同序号的最新记录仍作为独立候选。每份当前或冻结快照分别执行选择。

对于同伴和 owner 本地的通用工具报告，文本、报告重建与语义后端分别按授权区间、来源、根目录索引和相对路径选择历史。包含完整 `content` 的最新成功 Write（空字符串也有效）将同链中序号严格更小的报告标为 `superseded`。其后的 Edit、失败及省略正文的报告仍保留为独立记录。失败 Write、省略正文的 Write 和 Edit 都不替代早先历史。不同授权、文件和冻结快照不能互相替代。这一共享选择规则识别报告区间；只有 `/reported` 能按下文规则重建满足条件的区间。任何后端都不能确立未报告的变化或已核实的当前磁盘内容。

`/reported` 后端仅依据完整且成功的实时 Write 及其后续完整、成功的字面 Edit 重建文件文本。它保持文件组不可拆分，并采用与文本后端相同的撤回和接收者排除规则。重建要求从该 Write 到最新已观察报告的采集序号连续；其他文件的已知报告可以占据中间序号。同一采集中的命令尝试会中断文件重建，即使该命令报告已被替代；后续完整 Write 或独立完整的原生操作结果可建立新检查点。每个文件组保持同一作者与授权。序号缺失或重复、历史工作报告、回车字符、不完整 Unicode、不成功或不完整的操作、无法匹配或有歧义的编辑，以及 publication 附带的额外文字或 URI，都会保留原始报告组。没有完整 Write 就不重建文件。分配内存前，每个中间 UTF-8 值都必须能放入传入的上下文预算。

报告选择先尝试终结通知，再在同一轮中跨来源轮流尝试当前命令和答复报告。两种报告互无优先级；每个来源成功放入一组或队列耗尽后，让下一个来源尝试。每个已有命令被选中的来源先获得一次文件组选择机会，然后其余组跨来源轮转。一次选择会跳过超大组，直到一组放入预算或队列耗尽。组按新鲜度排序，时间相同则按采集顺序处理。来源区分冻结快照和精确授权区间；无授权区间的 publication 按作者分组。输出保留采集顺序。这种分配不推断语义相关性，也不证明命令验证了同来源文件；终结通知仍可能超出预算。

重复的完整 grant 仅在完整转义后 UTF-8 表示更小时使用 version-1 `grantReferences`。其中 `entries` 通过从零开始的 `publicationIndex` 和 `grantIndex` 指向 grant 行；行的 `kind` 标识 `localContribution`、`peerContribution` 或 `authority`，`value` 用于还原该字段的完整 `grant`。

规范的同伴报告原文还可使用 version-1 `observationReferences`。每项保留顺序不变的完整结果、序号和来源 ID，引用原有警示文字，并且只复用与该 publication 的 peer grant 精确相等的归属字段。消息内的说明在 grant 展开后逐字节还原原文。未知或不规范的 publication 保持字面内容。后端比较原始、仅 grant 引用及组合表示的完整转义 JSON（包括说明），只选择严格更小的表示。`reported-files` revision `6` 将这一编码与命令、已完成答复来源之间的分配结合；已存的早期投影保留确切原文。[分配策略](../../../.agents/notes/implemented/feature/2026-10-14-source-fair-reported-context.zh.md)与[原文无损表示](../../../.agents/notes/implemented/bug-fix/2026-10-14-lossless-peer-report-text.zh.md)分别说明两项决策。

重建记录明确标识其内容来自报告，并非已核实的当前磁盘状态。模型文本包含授权、文件标识、依赖数量、有序依赖摘要及首尾引用。投影保留每条已选 publication 的引用，包括恢复到早先值的操作。冻结父快照保持独立。完整包裹文本和重建内容必须一起放入预算，否则省略整个组，不退回旧基底。后端不读文件、不导出私有工具执行结果，也不调用模型。精确覆盖信息与已存报告仍随历史增长。`/semantic` 保持其自身的原始报告输入与摘要限制。

明确授权完成文件内容后，`/reported` 还可将成功的原生 Edit 或 Write 结果作为独立的完整检查点。`completed-native-file` 记录标识原 publication、序号、grant、相对文件、完整 LF 正文及摘要；警示文字区分操作完成结果与当前磁盘核验。它无需先前共享的 Write，也不推断历史连续性。同文件、同授权中序号严格更小的报告标为 `superseded`。后续失败或省略完成正文的报告保留在同一原子组内，阻止单独呈现早先完成结果。额外来源文字或 URI 会保留原始 publication。整组仍须连同完整包裹文本一起满足输出预算。`/text` 和 `/semantic` 保留原有工具报告选择规则。

已记录工作工具报告在文本后端的完整 publication 中保留历史来源，语义后端也在每条已接纳摘要引文旁保留该来源归属。摘要不能移除这项归属。其序号与后续实时报告属于同一获准工具链；较晚分享旧操作不代表核对过当前文件。

明确授权的前台命令报告按来源区间、来源名称、精确命令文本及工作目录根索引选择最大序号。后续非零退出、信号、超时、中止、完成结果不可用或输出省略都替代早先尝试，不会恢复早先成功。独立授权与冻结快照保持分离。文本和报告重建后端将每条选中命令作为完整 publication 交付，或按 `budget` 省略。语义交付把完整类型化命令 publication 保留为必需证据，包括输出截断、省略与授权；摘要模型不能将其判为无关，也不能抹去退出状态。报告只记录一次执行，不证明当前代码已通过验证。精确自身来源排除与区间撤回在交付前生效。

文本后端将每条完整的保留工具报告链作为一个预算单元，尚无完整 Write 的链也如此。它交付整组，或将整组按 `budget` 省略；不会只发送旧基础而丢弃后续更正，也不会在替代记录放不下时恢复早先 Write。组按其中最新的发布时间排序，交付记录保持来源顺序。其他文件组仍可能放得下。覆盖记录保留精确来源引用，因此排除被替代正文不代表历史元数据增长有界。已保存的 Task publication 和早先记录的 Session 投影保持完整。

Owner 已终结的区间在选择前将早先正文按 `withdrawn` 排除。带有出处的终结通知优先于普通 publication 分配预算，即使接收者就是通知作者；通知放不下时，旧正文仍保持排除。每份冻结父快照在其捕获的 revision 内判断终结。交付的 JSON 说明省略数量。文本后端保留源文本，不执行语义摘要。其中只包含已准入的 publication；获授权的工具报告不授予私聊、完整 Session 或完整工具历史的访问权。

对于类型化的同伴或 owner 本地报告，只有原文以换行及完整观察逐字节序列化后的 JSON 结尾时，文本后端才省去重复的 `peerToolObservation`、`localToolObservation`、`peerTurnOutcome` 或 `localTurnOutcome` 属性。原文、可信性说明、来源引用和授权元数据保持不变。自定义前缀保留；原文不匹配或附加了尾部内容时，仍保留两种表示。这减少交付字节，不截断内容、不合并工具事件，也不修改已保存的 Task publication。

事实后端接收由 Host Task 服务准入的类型化 OpenAPI 观察。普通发布文本和工具观察，包括模仿 OpenAPI 观察的 JSON，都按不支持的来源省略。对于每个观察方、工件和授权组合，后端选择最大的持久采样序号，包含接收者自己发布的观察。已撤销的链不提供有效事实；无效或不可用的最新记录不会恢复旧的有效采样。独立授权中的有效声明不一致，或有效声明旁存在不可用的同伴证据时，仍保留为冲突。发布时间先后永远不能解决这种冲突。父 Task 的观察保持为单独归因的冻结快照，不能确立子 Task 的当前事实。

即使 Task 事件由另一 Host 持有，远端观察仍保留采样 Host 及其 binding epoch。Task owner 的区间终结事件会投影为已撤销观察，并在下一次准入请求中经同一事实后端交付。带有出处的终结通知作为完整记录，优先于工件组分配预算；省略的通知标为 `budget`，该终结区间早先的非类型化观察标为 `withdrawn`。该撤回从这份注入投影中移除有效事实，但不能抹去更早的模型请求或冻结继承快照。[Task 准入](../development-task/README.zh.md)负责互信 Mesh 授权与耐久 receipt。

独立同伴报告保留已认证贡献者、owner grant generation 和 capture generation，不冒充 Mesh 节点或 Task participant。其事实链使用独立身份命名空间，因此字面相同的 Mesh 与 Peer 标识不能互相替代。`authenticated-peer-report` 表示声明的发送者，不表示 owner 验证过文件或工具执行。终结的 Peer grant 通过相同的文本与事实预算撤下当前证据。

对于带有已验证原始采集身份的联合接收者，文本、报告重建与语义后端也将精确匹配 owner、Task、贡献 peer、贡献授权代际及采集代际的普通同伴工具与答复报告按 `self-published` 省略。仅 peer、路径或正文相同，不能省略另一 Session 的报告。消费者提供这一关联；没有关联的普通手动读取仍保留这些报告。替代和撤回优先判定，终态通知仍可被选中。事实后端保持其类型化 OpenAPI 选择。

Owner 本地报告在每个后端中使用同一区间撤回选择。文本后端将保留的操作分别作为记录；事实后端将活跃工具报告标为不支持；语义输入携带本地授权与报告工具元数据。文本、报告重建和语义后端省略接收者自己的报告，但保留终结通知。

这些事实表示采样时的声明：必填字段名不代表完整的请求验证，响应状态码键保留原始字符串，采样也不证明部署后的行为。职责规则在完整证据归约后选择字段；操作身份、状态、版本和出处始终可见。每条链最多保留紧邻前一版的来源、序号和状态，不保留旧字段值；`supersededCount` 统计全部已替代采样。更早采样按 `superseded` 省略并计入覆盖统计，因此反复修订不会持续向交付文本追加来源引用。每个工件的最新记录、冲突、已撤销的链和保留的前序引用组成一个预算单元。整组无法放入预算时，这个完整单元按 `budget` 省略；更早采样仍标为 `superseded`。字段省略与来源省略分别报告。提供方身份包含归一化选择规则的摘要，因此配置变化会使新请求的缓存失效，而已记录投影保持原文。

语义后端在推理前排除已撤回和已替代来源的正文，使用与文本后端相同的完整 Write 选择规则。终结通知、当前结构化 OpenAPI 证据与选中的命令结果保持为确定性的必需记录，不交给模型裁定其冲突。对于其他来源，模型逐项给出相关性判断，以及带原文摘录的简短更新。未知或重复引用、缺失判断，或相关来源没有被更新引用，都会使结果被拒绝。交付的出处只包含来源身份与报告元数据，不重新附带每条工具正文。`recipient-irrelevant` 表示模型的相关性判断，不是访问限制。摘录确立与源文本的引用关系，不证明语义正确。完整的相关更新与必需记录必须能放入交付预算；失败不会恢复旧摘要。

语义结果版本 7 使用消息内的来源表与授权表呈现当前证据。更新、选中覆盖，以及已替代或已撤回 publication 之外的省略仍保留精确的 Task 修订号和 publication 身份。显式标记的必需同伴命令记录可复用既有来源行及完全匹配的授权身份；展开这些引用可恢复完整来源、publication 身份与授权。其余授权字段、操作结果、publication 文本、更新文本及引文保持逐字不变。无法识别的记录、引用字段冲突和不匹配的授权保留原始表示。包含表格与消息包裹文字的完整 UTF-8 输出必须放入传入预算。审计恢复仍按结果版本 1–6 各自记录的表示重建。

已替代及已撤回的 publication 省略分别按精确 Task 修订号显示数量，不逐条增加 publication 来源行。终结撤回记录仍作为完整的必需证据。交付文本不能重建这些历史身份。完整来源处理结果仍保留在投影元数据和耐久捕获证据中；计数不改变授权、来源选择或激活。反复替换同一命令或文件的最新记录因此不会逐条增加显示引用，终结来源区间也不会重新添加这些历史行。当前证据、其他省略原因及完整捕获证据仍受各自字节限额约束；这不保证所有持续增长的历史都有界。

Task 上下文变化时清除自有的先前节点，并在此前工作之后追加当前快照。清除最后一个 binding 后，下次准入 pre-step 按相同顺序追加中性断开标记；重新连接采用选中的 Task。空替换事件保留回放链接，不进入模型请求。Room 成员关系不能选择上下文。 注入器只接受所注入注册表中精确匹配的存活 Agent，并且只确认其精确注册 Session 中的快照。在另一个服务隔离范围中复用 ID 不会选中此 Task。 原生被动接收采用 Task 服务的[最后保留绑定](../development-task/README.zh.md#remote-api)。受管理的 `/local` 读取按调用者提供的精确参与者和绑定 ID 查找，再核对 Task 和代际。

如果投影中的必需上下文无法放入预算，`maxContextBytesPerStep` 会拒绝该投影。消费者也会在采纳前检查后端的完整输出。后端失败或采纳前取消不会增加 Task 消息或确认。读取、计算或检查上下文失败时保留尚未提交的输入并报告错误；后续明确继续时读取当前上下文，只提交一次保留的输入。计算期间 binding 变化会丢弃过期结果，并在同一次 pre-step 中按当前 binding 重新计算，保留用户请求。

Provider 继承本包 `/backend` 入口的 `DevelopmentTaskContextBackend`。它接收获授权的 Task 视图、接收者 participant 与职责标签、字节预算和取消信号。消费者负责授权与交付身份；这些路由输入不授予访问权。外部适配器保留自己的耐久投影记录。消费者在 Session 中记录确切输出文本、后端身份、被选择与省略的来源引用以及 binding 区间。后端身份和字节预算未变时，已采纳且未变化的上下文直接复用；替换任一项会在下一次请求中重新计算上下文。配置变化可能影响输出时，Provider 必须改变其身份。消息记入日志后，后台确认会记录 Task revision 已投影，不证明模型使用了每一项事实。确认失败会被记录，不会拒绝用户请求。

每个提供方的输出都包含 `activation`：`/text` 与 `/reported` 使用 `exact`，`/facts` 与 `/semantic` 则提供带版本、摘要和覆盖状态的 `recipient-evidence`。消费者可在决定是否需要再启动自动轮次时比较这些证据；它不授予权限，也不替代确切文本、来源引用或完整字节预算检查。本包的原生 Task 消费组件仍在准入请求时更新上下文；[原生 scope 接收](../scope-agent-context/README.zh.md)负责自动调度和已完成请求的证据。

事实摘要覆盖当前 Task 的目标与范围、选定声明、来源授权身份、冲突和终结。在同一授权链中推进未变声明的采样、在不存在冲突时修改未选字段，或加入不支持的原始文本，都不会改变它。来源 ID、采样序号和历史引用仍可能改变确切输出。冲突会在比较中保留全部声明字段。`complete` 表示选择字段后每个当前工件组和终结通知都能放入预算，不表示已知全部 Task 内容或现实事实。预算省略任一当前单元时会产生 `blocked-current`，不能据此建立已完成的比较基线。省略冻结历史不会将当前证据标为受阻。这种确定性比较不确立任意语义等价，也不证明实测的模型成本收益。

语义证据摘要保留逐字摘要文本和引文、相关来源的完整正文与归属、必需证据、冻结父修订、接收方路由，以及 Task 的身份、目标、范围和起源。结果版本 3–7 排除当前 Task 修订号，以及按 `recipient-irrelevant`、`self-published` 或 `superseded` 省略的引用；其他省略仍参与比较。新增或替换无关报告可以保持激活证据不变，同时改变精确交付覆盖。相关来源发生变化或变为无关时，比较的证据仍会改变。措辞、相关来源身份或授权不同，不会仅因引文相似而判为相等。返回证据前，完整文本必须放入预算。记录的版本 2 在保守比较中保留已替代引用；版本 1 使用精确激活。来源表和授权表的编号不参与证据摘要。这种比较不能纠正相关性判断，也不能免除摘要计算成本。

消费者在复用缓存前和计算后等待 `currentContextView`。到期 grant 必须先持久终结，才能交付当前证据；持久化失败会拒绝准入。新提交的终结通知会丢弃慢投影并触发重算。非 owner 的 Mesh 副本无法确立独立同伴或 owner 本地采集当前的授权。冻结父快照仍属于历史。

受管理的 owner 本地接收通过 `/local` 捕获确切的 Root Task assignment，并计算有界上下文。替换 Task 服务会使未完成的读取失效，即使新实例恢复了同一 assignment。读取要求自身隔离域内的 Room 身份。结果记录 Task binding epoch、owner 节点、提供方、完整文本、覆盖情况及激活证据，不使用远端邀请或 subscription。消费者将这些投影记录为 version-3 Task 快照；现有 version-1 与 version-2 快照仍可读取。匹配的已记录快照通过相同的 Task assignment 检查确认其捕获 revision。受管理的撤回会记录当前事实不可用的原因，不声称 Task assignment 已被清除。本地快照与撤回构造函数返回一个文本块。

`development-task-context/admit` waterfall 委托完整上下文准入。本地接收者负责 Task 计算；纯远端接收者先等待 `next()`，再与被动 Task 上下文组合。Task 消费者在委托返回后复核被动 assignment、后端与来源有效期。输入将真实 inbox claim 与添加的上下文分开；`retainInput` 选择失败或注入器卸载时应恢复的普通未提交输入，排除受管自动 pulse。消费者只在注入器安装期间提供 `developmentTaskContextAdmission`。`signalFor(agent)` 只为其注册表中精确匹配、且属于监听作用域的 Agent 返回生命周期信号；卸载会永久中止已发出的信号。自动接收者必须要求这一能力，在异步工作前后复核，并保证该 Session 只有一个 Task 注入器。 委托返回后，注入器先处理自身取消，再处理委托返回的拒绝。卸载只在原 Agent 请求仍存活时恢复保留输入；明确取消不会恢复已丢弃的输入。

计算期间到达的普通 publication 不会使捕获的 revision 失效；下一次请求会选择较新的 revision。切换离开后再返回会创建新的 binding 区间，因此切换前开始的计算不能发布其结果。模型重试使用日志中记录的确切文本。

组合原生工作许可在报告授权引用及语义来源归属中保留完整类别选择。文件与命令样本保持各自既有证据形式，完整答复保留逐字报告。

在 Text 与 Reported 后端中，完整最终答复与 Claude Stop 报告保持为独立 publication：新答复本身不会取代旧答复。Stop 报告不证明 Claude 轮次已结束。原来源授权、警示及完整正文继续保留；同采集身份选择会省略接收者自己的报告。语义后端保留明确的未核实报告归属。仅支持 OpenAPI 的事实后端将这些当前答复报告标为不支持，并阻止将其视为完整自动执行依据。

Claude-work 报告保留完整的来源选择。文件报告沿用 Write/Edit 选择规则。同一采集内，精确命令和根目录的最新报告替代较早的尝试，即使其输出中断、不可用或被省略。Text 与 Reported 保留原始 Hook 字段；Semantic 将选中的命令保留为必含的逐字证据，不推断进程退出码。结束采集会撤回其当前报告，冻结的父快照仍保持历史含义。

<a id="model-experience"></a>

## 模型体验

### 已连接 Task 快照

#### 模型看到什么

文本与报告重建后端输出一条以 `## Connected Task context` 开头的 user-role 消息，后接经过标签转义的 JSON，其中包含选定的 Task 上下文和省略数量。消息明确说明 Task 上下文不能覆盖 system 或当前用户指令，且不能假定已知被省略的事实。断开连接后，`## Disconnected Task context` 会说明注入的上下文已撤回，且当前没有连接 Task。受管理的本地读取在绑定可能仍存在时使用 `## Task context withdrawn`，并明确说明当前事实不可用的原因。事实后端输出 `## OpenAPI declarations as sampled`，随后是经过标签转义的 JSON，区分当前 Task 证据与冻结的父快照。消息明确将内容限定为采样声明，并提醒独立冲突仍未解决。省略一个工件组不表示其证据一致或已知其事实。 语义后端输出 `## Relevant shared work updates`，包含摘要更新、引用来源、必需证据，以及确切的选中／省略范围。其辅助请求使用 `purpose: context-summary`，没有工具，并将来源文本视为数据。辅助审计记录与接收方对话分开保存。

#### Token 影响

按条件产生。每次未命中缓存的语义请求都会额外消耗输入和输出 token；复用确切审计结果不会再次调用模型。原生 Agent Session 连接后只有一份当前快照可见；Task 或 revision 变化会替换可见快照，耐久事件仍留在 Session log 中。断开连接会用简短标记替换 Task 详情，后续请求和回放不会重复追加该标记。

#### KV Cache 影响

Binding 变化、断开连接或 Task revision 变化会清除先前的 Task context 节点，并在此前工作之后追加当前上下文，使首个清除节点之后的请求后缀失效。上下文未变且已确认时不增加内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 自身发布省略只识别报告来源，不能证明模型在压缩后仍保留原本地操作。它本身不会抑制 Task 修订、评估或自动激活。
- 外部 MCP Agent 通过 MCP 调用获得 context delta，不经过此原生 pre-step 路径。
- 报告重建不能检测外部写入者，也不能重建仅通过 Edit 分享的既有文件。不受支持的组仍可能耗尽文本预算。它不定义语义等价，也不会因内容等价而抑制自动轮次。
- 语义来源元数据仍随保留的历史增长；去重不能将其规模固定，也不保证每份摘要都能放入预算。后端不证明摘要保真、真实模型任务质量或费用收益。Embedding 与 latent-state 后端尚未实现。
- 事实后端不读取工件，也不从自由文本提取主张。可信采样方负责授权、支持的 OpenAPI 字段、采样完整性和失效处理；后端无法自行检测之后发生的外部变化。
- 此消费者本身不会唤醒空闲 Agent；上下文在因其他原因获准进入的下一次请求中生效。[原生 scope 接收](../scope-agent-context/README.zh.md) 可通过准入 waterfall 管理明确授权的本地自动轮次。
- 撤回只移除此插件注入的上下文，不会抹除普通对话消息中引用的 Task 详情。

<a id="dev-note"></a>

### 开发备注

本包不发布不变量伴随插件，因为 Agent-loop 拥有请求准入和 Session 事件顺序；消费者在采纳投影时检查当前 binding 和字节预算。语义审计在打开独占写入器时验证请求与结果的对应关系，并从其记录的输入和原始输出重建缓存投影。审计恢复不针对当前 Task 历史重新选择来源。后端身份变化将新计算与早先缓存投影分开，但不重置审计累计调用预留。维护说明以本包源码、测试与上级架构文档为准。
