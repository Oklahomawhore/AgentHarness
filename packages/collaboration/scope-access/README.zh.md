---
description: "授权独立 Host 读取 Root Task 上下文或贡献有界来源观察"
kind: "package-reference"
---
# 独立 scope 授权

[English](README.md) | 中文

## 概述

Owner 可以通过独立邀请或明确选择的可复用组入口，邀请多个独立 Host 接收同一个 Root Task 的上下文。接收方显式加入，并在其消费方每次请求上下文时在线验证授权。撤销和过期会停止新的授权响应；暂时断线返回未知状态，不附带缓存事实。读授权既不采集接收方文件，也不允许发布。Owner 另行批准后，一个经认证的贡献方可以从指定采集代际提交有界 OpenAPI 样本或 Write/Edit 观察。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在正常 `dsh --profile` 组合中挂载此 Cordis 插件，并配备经认证的 [scope transport](../scope-transport/README.zh.md)、storage-domain、本地 Task 与 Room 服务以及[上下文后端](../development-task-context/README.zh.md)。启动器提供应用就绪与退出处理。本包不是独立可执行程序或可安装的 profile bundle。

```yaml
- name: '@deepseek-ai/dsh-scope-access'
  config:
    maxGrants: 256
    maxSubscriptions: 256
    maxProjections: 8192
    maxContextBytes: 6000
    maxResponseBytes: 240000
    maxDecodedResponseBytes: 2097152
    requestTimeoutMs: 10000
    maxInvitationLifetimeMs: 86400000
    maxConcurrentReads: 16
    maxConcurrentContributions: 8
    maxContributionRequestBytes: 16384
    maxContributionApplications: 256
    maxApplicationRequestBytes: 16384
    maxApplicationLifetimeMs: 86400000
    waitTimeoutMs: 7000
    maxConcurrentWaits: 4
```

所有限制均为必填。授权和订阅保留终态记录；容量耗尽时拒绝新身份。不同的精确投影也消耗保留容量，相同输出则复用已有记录。撤销已有授权或离开订阅不需要空余记录。将保留或文本限制降低到已存状态以下会使初始化失败，不会丢弃证据。

`maxContextBytes` 限制后端文本；消费方另行预留自己的包装文本预算。`maxResponseBytes` 限制线路上传输的完整编码响应。`maxDecodedResponseBytes` 独立限制解码后的完整读取响应 JSON，包括归属和来源覆盖。双方 Host 的限制同时生效。应按保留的 Task 容量配置这些限制；压缩无法消除不同来源身份所携带的信息。读取压缩不改变文本额度或投影选择、省略的来源。贡献响应与管理清单页面仍使用完整未压缩 `maxResponseBytes` 限制。

Host 消费方先为自己的模型说明文字和其他上下文预留字节，再调用 `retrieveWithinBudget({ subscriptionId, maxContextBytes }, signal)`。该正安全整数额度先受接收 Host 的配置文本上限约束，再受 owner 上限约束。精确投影记录实际生效的上限，并将其纳入摘要。事实选择和明确遗漏由当前后端产生，消费方不自行截断文本。即使正文恰好可容纳，接收方也拒绝所声明上限大于本次提议的投影。`retrieve(subscriptionId, signal)` 将文本额度留给 owner 决定。

两个获取方法均使用 `/agentharness/scope-read/4`，不回退。每个请求携带接收方的 wire 与解码响应限制、可选的文本额度，以及订阅所拥有的原始 capture 关联。不支持 version 4 的 peer 返回 unavailable。Owner 也继续服务 version 1–3，严格保留各自版本的字段和完整未压缩响应限制；这些入口不获得 version-4 编码或限制。

`waitForChange(subscriptionId, cursor, signal)` 返回不含事实的变化提示。省略 cursor 时立即校准；返回的游标不透明，可传给下一次有界等待。changed 和 unchanged 提示均不授权使用缓存上下文：消费方仍须调用 `retrieve` 或 `retrieveWithinBudget`。同一订阅的新等待会取消旧等待。调用方取消会拒绝 promise；退出、撤销和过期分别以对应状态结束接收。

`maxConcurrentWaits` 共同限制 owner 与接收方正在等待的操作。读取与贡献状态查询、样本请求共享 `min(transport 入站上限, 出站上限) - maxConcurrentWaits - 1` 个槽位，加载时必须至少留有一个普通槽位；各自配置的并发上限也同时生效。另为贡献结束请求各保留一个入站和出站槽位；此保障仅约束本服务流量，不涵盖任意其他传输处理器。`waitTimeoutMs` 必须短于 `requestTimeoutMs`，后者不得超过传输截止时间。网络超时或断线返回 `unavailable`。等待既不计算后端文本，也不保留投影。

Owner 选择一个 Root Task、接收方的公开 peer 身份、已公布的 owner 地址、过期时间和职责。邀请固定双方 peer 及精确授权代际。职责用于路由后端字段，不会缩小该 scope 的读取权限。Fork 和 Merge Task 不能通过此服务共享。

加入只保存接收意图。本地 active 订阅不代表远端授权已经成立。每次获取都发送新的请求身份，并在保留精确输出前验证 owner、recipient、Task、grant、generation、响应关联、来源归属和字节预算。未知 peer 和不匹配的邀请收到拒绝，不触发 Task 查询、列表、Room 或副本。采集与写入授权保持独立。

联合消费者可以保留带有原始采集 ID 与代际的 version-2 subscription。version-4 读取显式发送该关联；owner 在选择上下文前，将它与已保留联合申请中的独立读取和贡献计划核对。后端接收完整的 owner、Task、贡献者、授权及采集身份。普通手动订阅不作这一声明，即使它在同一 peer 上复用了同一邀请。重试和路由更新不能替换订阅的原始采集。该关联允许按来源省略，不授予额外访问权；源 Host 负责选择自己的本地 Session。

贡献邀请固定 owner、贡献方、Task、采集与授权代际、来源许可、到期时间、样本数和样本字节数。来源可以是一个 OpenAPI 操作或明确的 Write/Edit 集合；传输标签不能改变该许可。贡献方发送结构化来源证据，不带本地绝对根目录、Session 标识或调用方撰写的发布文本。工具字段可以含用户撰写的正文及相对路径。Task 准入派生归属并核对来源与工具的对应关系。读邀请不能授权贡献。`maxContributionRequestBytes` 限制完整请求，`maxResponseBytes` 限制完整响应；若终结请求和收据无法容纳，批准会拒绝该邀请。

历史工具分享要求申请与批准授权中的来源显式包含 `version: 2` 和 `initialization: recorded-local-tools`。其 version-2 样本携带计划与执行摘要，使用 `/agentharness/scope-contribute/2`；version-1 入口拒绝这些样本。实时样本、状态查询与终结保持 version 1，样本协议之间不回退。两个版本共用并发、样本与完整消息额度、精确收据及撤回语义。来源消费者负责本地历史同意与执行证据；owner 对发送者的认证不验证历史文件内容。

Owner 预览带版本的贡献申请，选择不可变的期限与采样额度，无需自行构造授权标识即可批准。并发相同批准及响应丢失后的重试会恢复原 Task 授权；更改来源或额度、批准已终结的 capture 都会被拒绝，必须准备新的 capture。恢复将原授权与本次确认的 owner 公布地址组合，不复原历史邀请字节。终结授权也可重取以完成待确认的撤回；它仍保持终态，不能恢复贡献。贡献文本预览不授予任何权限。类型化管理错误区分文本无效、许可无效、批准冲突、授权已终结、选择过期、容量不足和临时存储失败。

Owner 清单按稳定授权标识顺序分页保留活跃及终结的 Task 记录。每个完整页面都符合 `maxResponseBytes`；单条记录也无法容纳时返回类型化容量错误。游标必须属于所选 Task。各页并非冻结快照：从第一页刷新才能查看新插入的授权。Peer 协议不能访问此清单。`maxContributionRequestBytes` 同时限制完整粘贴文本，批准前还会检查包含邀请和文本的完整响应预算。

Owner 创建只接受一个 capture、带明确来源模式的申请入口，并一次性交换入口文本。来源在线提交匹配的 capture 申请，以及明确的到期时间、样本数和样本字节数上限；本地根目录留在来源端。Owner 批准相同或更窄的额度。经认证的来源取回原授权及 Task 收据，无需第二次交换文本。来源适配器负责自动激活与本地采集许可。旧 OpenAPI 入口只接受 OpenAPI 申请。入口既不授予读取权限，也不允许发布。显式联合入口为一个 Session 提供被动读取与工具贡献申请；提交申请表示同意两项请求，owner 批准时仍必须单独选择读取职责。读取期限等于批准的贡献期限。普通贡献入口不能获得读取权限。

`createGroupEntry` 为同一个自有 Root Task 创建可复用的工具观察入口。每个参与 Session 提交自己的经认证 peer、capture 身份与代际以及采集上限。Owner 批准该精确申请并单独选择读取职责；来源端仍自行管理本地接收同意与自动执行许可。复用入口文本不会共享授权或自动许可。同一个 capture 在同一 Task 下只能属于一个保留申请，单人入口与组入口共同遵守此限制；重试保留原申请身份，其他 Task 仍是独立目标。

`closeGroupEntry` 永久停止新申请。已有待批准成员仍可在入口期限前获批，已批准成员保留原读取与贡献期限。来源只取消自己的申请；owner 使用 `applicationId` 和所显示的申请拒绝或结束一个成员。这些操作不会关闭入口或影响其他成员。在 apply 之前收到的取消会保留一个终态成员，即使入口已经关闭，迟到的 apply 也不能使其重新激活。保留容量不足时，取消保持未确认。

`probeContributionEntry({ entry })` 在本地采集同意前在线核对入口，只返回瞬时可用状态：`ready` 表示单人入口未被占用，或组入口开放且仍有成员容量。单人待批准申请返回 `claimed`，其终态决定返回 `closed`。已关闭组入口返回 `closed`，已满组入口返回 `capacity`。已过期、身份不匹配、容量不足与连接失败保持不同状态。预检只使用指定的直连地址并认证 owner peer，不搜索地址或读取 Task 正文，不创建申请或权限，也不持久化过期状态。成功预检不会预留入口：实际申请仍会核对原入口、来源同意与 owner 当前决定。

`maxContributionApplications` 共同计算每个单人入口、每个组入口和每个保留组成员，包括终态记录。组入口还遵守不可变的 `maxMembers`；更低的全局容量或字节容量可能使其无法达到该人数。`maxApplicationRequestBytes` 限制完整请求与保留的决策记录，包括整个组，并为所有成员最长的终态决策预留空间。终态成员不释放容量。`maxApplicationLifetimeMs` 限制新申请与批准的窗口；入口过期不妨碍取回或撤回已经批准的授权。

Owner 的单人入口、组入口与组成员清单使用各自独立的稳定游标，并对完整页面应用 `maxResponseBytes`。成员游标必须属于所选组，owner 决策须同时指定组入口及精确成员身份。提交后的变化发出 `scope-access/contribution-application-changed`，供本地观察者重新读取。入口重取只更改已确认的 owner 地址，保留原期限和成员上限。

联合批准先保留原读取邀请与贡献授权，再分别提交权限。部分失败可使用原身份重试，计划中的读取授权会预留保留容量。申请取消或拒绝会在确认前撤销其计划联合读取并结束其计划贡献。尚未选定授权的申请不能结束独立手工授权的贡献。Owner 显式批准时，只有先保留完整申请计划，才能采用该精确贡献。仅结束贡献会保留读取；仅撤销读取会保留贡献。`readState` 表示 owner 当前观察，不允许复用缓存上下文。来源消费者负责本地采用、独立文件同意以及任何自动启动许可。

Owner 不可达时返回 `unavailable`，这禁止将旧上下文复用为当前已授权内容。已撤销和过期的订阅保留终态；退出结束本地接收身份。重新加入产生新的订阅和代际。撤回不能删除已经交付给其他进程的字节或对话中已存在的信息。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Owner 在读取 Task 前验证经认证的传输 principal。它在耐久修改队列外计算，然后在返回已持久输出前复核授权、所有权、provider 身份、过期和取消。撤销不等待慢速后端。在后续发布持续到达时，已捕获的 Task 修订仍可交付；后续来源撤回会使其失效。当前读取在捕获和最终验权前通过 Task 队列提交已到期贡献的终结。下一次获取捕获新修订，因此持续到达的样本不会阻止交付。

Host 消费者可向 `ensureSubscription` 提供已经耐久预分配的身份。它只复用精确代际与读取权限，保留当前选定的地址及终态，并拒绝以同一身份改用不同权限。消费者必须保留自身的采用与取消状态；相同邀请文本不能标识一个 Session 的读取操作。

`updateSubscriptionRoute` 将 Host 消费者已经落盘、单调递增的地址变更意图应用到已有订阅。只有 `ownerAddress` 可以变化；所有授权字段及接收身份都必须相同。历史订阅省略 `routeRevision`，表示代际零。相同代际要求相同地址，较旧代际不能回退新地址，终态记录不能重开。联合申请响应使用当前确认的所有者地址，同时保留原读取授权。每次请求仍由 Noise 认证及固定 peer 的直连地址校验约束。

version-4 读取响应在符合 wire 限制时携带普通 JSON，否则按需使用 gzip 与 base64 无损编码完整读取响应 JSON。编码后的封装仍须符合 wire 限制。接收方先限制解压大小，再解析，并对完整解码值执行相同的响应、投影 schema 和摘要检查。持久化保留原投影，不保存压缩封装。编码无效、解码输出超限或归属无效时，在采用前失败；压缩或较小的模型可见正文都不允许缺失来源覆盖。

接收方将每个响应关联到其最新请求与耐久订阅代际。本地退出、更新的请求、过期或卸载会阻止迟到结果被采用。双方 Host 都保留精确投影字节和覆盖记录。`scope_access` 与 `scope_group_applications` 存储域将各自记录固定到本地传输 peer 身份；保留记录却更换密钥会导致初始化失败。严格解析器拒绝畸形耐久和线上数据，不将其当作可丢弃缓存。

普通读取投影使用 `version: 2`；带有显式关联的联合读取使用 `version: 3`，并包含 owner 验证的原始采集身份。两者都要求后端提供 `activation` 值：`exact` 或带版本的 `recipient-evidence`。精确投影 ID 包含该值以及文本、来源引用、授权和预算。因此，证据摘要相等时，精确投影 ID 和输出字节仍可能不同。[后端](../development-task-context/README.zh.md)定义相关事实与 `blocked-current`；消费者仍需在线验权、检查完整交付预算，并负责是否自动调度。证据相等不会去重持久来源记录，也不保证外部客户端输出不变。

严格解析器也能读取不含版本和 activation 元数据的已保留投影，保留原字段和投影 ID，不添加默认值或改写旧记录。不支持的版本、不完整的 activation 值、额外字段和不匹配的摘要都会被拒绝。缺少 activation 元数据不能确立接收者证据等价。

变化等待在任何 Task 查询前验权，注册监听后再次核对授权和游标。只有已授权 Task 的提交、grant 撤销、后端替换、过期、取消或等待截止时间会结束该次等待。读取和投影持久化不会发送变化提示。游标比较订阅与授权代际、Task revision、后端身份和输出预算；它不是耐久事件流，可以跳过中间版本。等待不占用变更队列，并使用独立于读取的请求身份。

Task 事件日志是贡献授权、样本与终态收据的权威。写入可能已提交但响应超时：贡献方保留精确样本，直到收到匹配收据。重试恢复原事件收据，包括终结后的重试，不重新开启授权。显式结束与过期停止准入并撤回当前证据；终结持久化失败会阻止当前交付。返回或复用投影前，交付检查 peer 与 owner 本地采集、Mesh 观察区间及 API 制品采样的撤回版本；后端计算或编码都不能恢复已撤回来源。后台到期提交失败会记录错误，等待后续 Task 变更或显式操作重试，不进行零延迟循环，也不关闭无关 Agent。

[在线申请](src/application.ts)在修改 Task 授权前保留批准或取消意图。单个 owner 队列排列这些决定；已批准记录包含完整计划贡献授权；联合入口批准还包含独立读取邀请。恢复将该授权与 Task 事件核对，即使授权开启的响应丢失或开启尚未提交，取消仍能终结它。终结提交失败仍为未确认。在尚未选择授权时取消入口，只关闭该入口，不禁止 owner 以后另行手工授权。严格的[记录与线上解析器](src/application-schema.ts)保留原 capture 与同意额度的关联。单 capture 存储域及第 1 版线上解析器只接受单人入口。可复用入口使用第 2 版 apply 与 probe 协议，并使用独立的第 1 版 `scope_group_applications` 存储域。每个原子组记录持有独立标识的成员决策；重启时校验 owner 身份、成员与计划授权关联、完整记录字节数及共享保留上限。两个存储域随服务关闭。

公开的 [`./contribution` 控制器](src/contribution-client.ts)协调来源申请、已选邀请、原始待投递样本与终结收据。来源适配器提供串行化的本地记录，并自行保有文件许可与执行证据。peer 请求在本地回调之间执行；收据采用时核对当前 capture、邀请与精确样本。控制器不产生采集许可或 Task 副本。重试调度、取消与销毁由适配器负责，适配器可以为共用记录解析器扩展本地字段。

[服务](src/index.ts)负责授权与生命周期，[类型](src/types.ts)定义消费方结果，[状态模块](src/state.ts)负责线上与耐久解析。[贡献协议](src/contribution.ts)验证经认证的 peer 与精确收据；[贡献解析器](src/contribution-schema.ts)验证有界线上消息。公开 `./schema` 入口向耐久消费方提供邀请、投影与贡献校验器。[决策记录](../../../.agents/notes/implemented/architecture/2026-10-03-independent-scope-read-grants.zh.md)说明隔离与离线取舍。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Scope transport](../scope-transport/README.zh.md)认证直连 peer。
- [Task 上下文](../development-task-context/README.zh.md)计算接收方输出。
- [Claude scope](../claude-scope/README.zh.md)准备外部会话交付。
- [存储域](../../storage/storage-domain/README.zh.md)拥有耐久记录。

<a id="model-experience"></a>
## 模型体验

本包通过接收方消费组件间接影响模型；这些组件将已获授权的精确后端上下文纳入模型请求。

#### KV Cache 影响

已授权上下文变化时，消费组件可能改变模型请求前缀；本服务不控制请求组装或缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 Root Task，不推断父级授权。
- 贡献接受明确授权的 OpenAPI 声明和 Write/Edit 报告，不接受任意发布，也不提取语义事实。认证标识报告者，不证明执行、文件当前内容或已部署服务。工具事件保持独立报告，有界后端可能省略它们。
- 每次获取都需要 owner 在线；没有离线读租约；本服务不启动空闲 Agent。
- Wire 压缩保留来源覆盖，但不提供无限历史，也不扩大模型上下文。难以压缩的响应、过大的解码覆盖以及超出文本额度的完整来源组仍可能阻止交付。
- Owner 的授权决定不能召回已发送响应；接收方拒绝本地能够识别的过时结果。
- 单人联合入口邀请一个 Session；组入口接受分别获批的成员。Root Task owner 仍掌握授权与当前上下文。可复用入口不提供无 owner 的成员管理或 peer 发现。明确更新地址不能恢复已终结的权限。
- 手工或其他未关联原始 capture 的订阅不标识某一个精确发布 capture，其后端输出可能重复接收者自身的远端发布；消费方不能将此类重复当作其他成员贡献的证据。
- 地址必须保持可达；传输连通性和接收方模型采用与读取成功是不同事项。

<a id="dev-note"></a>
### 开发备注

服务在线上数据进入和耐久状态恢复时检查授权、订阅与投影关联。本包不发布不变量伴随插件，因为这些准入检查负责验证上述关联。精确投影持久化证明输出已准备，不证明下游模型准入。
