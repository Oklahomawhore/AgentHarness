---
description: "在原生 Agent 会话中接收独立授权的 scope 上下文，以显式预算约束空闲启动，并保存可重放的精确文本"
kind: "package-reference"
---
# 原生 Agent scope 上下文

[English](README.md) | 中文

## 概述

把正在运行的原生 Agent 会话连接到 owner 本地 Root Task、独立授权的远端读取范围，或同时连接这两个显式选择的来源。每次获准的请求都会检查当前授权，并接收精确记录的上下文；忙碌时的变化等待自然请求边界。显式自动执行许可可为本地目标启动有限次数的空闲轮次。远端通知不含事实，仅挂载此包不会启动工作。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在已经提供原生 Agent、Session 投影和 [scope access](../scope-access/README.zh.md) 的 `dsh` profile 中挂载此 consumer。远端绑定拥有新建的接收订阅。组合绑定保留显式选择的当前本地 Root Task 分配，并增加一个远端订阅。本地调度还要求挂载 Task context consumer 和 backend。委派、分叉及未运行的 Agent 不能绑定。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-scope-agent-context'
  config:
    maxContextBytes: 8000
    maxLocalContextBytes: 4000
    coalesceMs: 50
    retryDelayMs: 1000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxContextBytes` | 必填 | 所有受管上下文消息及说明文字的 UTF-8 总字节数，至少 512 字节。 |
| `maxLocalContextBytes` | 必填 | 双方来源均有效时完整本地投影的上限，必须为远端说明文字和正文留出空间；纯本地绑定与远端已撤回时使用总额度中的剩余部分。 |
| `coalesceMs` | 必填 | 空闲启动尝试前用于合并待处理变化的延迟。 |
| `retryDelayMs` | 必填 | owner 不可用后再次检查的延迟；自动执行许可保持暂停。 |

允许范围以[配置目录](../../../docs/config-catalog.zh.md)为准。每次远端读取先扣除 consumer 说明文字及其他受管上下文，再提交可用文本字节数。scope access 取该额度与双方 Host 上限的较小值，交由 owner 计算完整来源组。Task 必需的完整表示无法容纳时使用明确撤回标记，不会截断 Unicode 字符或静默裁剪。

### 显式绑定与许可

经过认证的本地 `scopeAgentContext` Remote 提供 `bind`、`bindLocal`、`pause`、`resume`、`leave`、`leaveLocalTask`、`updateRoute` 和 `status`，不公开原始传输或等待接口。Host 插件可直接调用同一服务：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScopeInvitation } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-scope-agent-context'

declare const ctx: Context
declare const agentId: SessionId
declare const invitation: ScopeInvitation
const current = await ctx.scopeAgentContext.status({ agentId })
if (current.eligibility !== 'eligible') throw new Error('Session cannot receive a scope')
const bound = await ctx.scopeAgentContext.bind({
  agentId, invitation, automatic: null, expectedBindingId: current.state.binding?.id ?? null,
  ...(current.localTask === null ? {} : { localTask: current.localTask }),
})
if (bound.binding === null) throw new Error('Binding was not retained')
const expectedBindingId = bound.binding.id
await ctx.scopeAgentContext.resume({
  agentId, expectedBindingId,
  automatic: {
    goal: 'Implement the assigned client integration',
    activationLimit: 3,
    maxStepsPerTurn: 2,
    minIntervalMs: 1000,
  },
})
await ctx.scopeAgentContext.pause({ agentId, expectedBindingId })
```

`status` 只读取已运行的 Agent，不创建或恢复会话，并区分可接收、委派、分叉、冲突和未运行状态。其 `state`、`activity` 与 `recordedContext` 对应同一个 `asOfSeq` Session 日志位置。现有 Session control stream 通过 `scopeAgentContext` 提供调度状态，通过 `scopeAgentEvidence` 提供不含正文的活动记录。Status 将活动限定于当前符合资格的绑定和本地目标：当前轮次保留的实际请求、最近一次成功完成及最近一次评估。自动许可或合格目标缺失时清空活动。恢复的历史记录不会续期许可；完成只证明所记录的轮次已结束，不证明产物质量。`localTask` 标识当前 owner 本地 Task 代际。本地绑定的 `subscriptionState` 为 `unbound`；远端 `active` 仅记录本地意图，不证明 owner 当前授权或模型采用。


`recordedContext` 描述当前已记录消息中唯一的共享快照，要求它与符合接收条件的绑定、有效的本地订阅意图和精确权限身份匹配。摘要包含快照序号、Task 修订、完整共享消息的 UTF-8 字节数、已选来源数及按原因划分的省略数。字节包含 consumer 说明文字，不包含本地上下文或其他消息；来源数不是事实数。撤回、缺少快照、快照不唯一或绑定已替换时返回 null。这些元数据不证明请求已经发出、模型已经理解或 owner 当前可用。恢复的历史可提供摘要，但不会续期授权；status 不启动未运行的 Agent。

每个管理修改操作都会先比较 `expectedBindingId`；bind 仅在没有调度绑定时接受 null，此时 Session 可以已有本地 Task 分配。延迟的 bind 和 resume 在提交前还会复核准确的 Agent 实例与绑定。替换绑定会保留原绑定，直到新订阅准备完成；未被采用的迟到订阅会结束。RPC 回复丢失后应先读取 status：已经提交的绑定仍可查询，使用旧条件重试会被拒绝。修改响应不带 Session watermark，不能覆盖 Client 已收到的较新投影。

`updateRoute` 在修改所有者地址前比较当前绑定和 `readStateSeq`。地址必须使用非零端口的直连 IP/TCP，并指向相同的所有者 PeerId。原授权、订阅、绑定、自动策略及已用额度保持不变；正在运行的自动轮次不会被取消。恢复地址不证明网络可达，也不续期授权。已终结的订阅不能恢复。无效地址返回 `scope-agent/invalid-route`。

`bindLocal` 要求当前 Task ID、Task binding ID、绑定代际和已观察到的调度绑定。它只授予执行许可，文件采集仍需独立授权。`automatic: null` 保留被动 Task 读取。`leaveLocalTask` 先停止自有自动工作，再有条件地清除精确匹配的当前 Task 代际及其采集。只有 Task 分配已不存在时，才可用 `leave` 丢弃遗留的本地调度绑定。

`bind` 和 `adoptJoinRead` 必须显式传入带精确分配代际的 `localTask`，才能保留已有本地职责。组合绑定只有一份当前自动策略和一个全生命周期预留计数。原本地自动许可独立保留，不会授予远端变化触发权。离开远端后恢复新的本地绑定区间，原策略处于暂停状态；原先无策略则保持被动。Task、分配代际、历史、文件权限和本地采集保留。离开本地 Task 前须先离开远端 scope。

带有来源关联的联合采用通过 version-4 计划与绑定记录原始采集。所属 Session 在读取重试、停止贡献和路由恢复期间保留它；手动绑定不会从读取邀请推断该关联。后来的手动绑定或退出不能继承此前的关联。owner 验证关联后才返回 version-3 采集投影；[scope access](../scope-access/README.zh.md)负责该验证。这允许按精确来源省略工具报告，不授予执行许可，也不声称模型记得被省略的内容。

组合准入只经过一次 Task consumer。系统先按 `maxLocalContextBytes` 计算本地投影，从总额度扣除其实际文本、全部说明文字和额外撤回消息，再按剩余额度请求远端投影。该次在线读取返回后，同步复核本地分配、provider、修订和过期时间；本地授权变化会丢弃候选并重新读取。两份精确消息共用总预算。远端失败时撤回远端事实，普通用户工作仍使用总额度中的剩余部分获得当前本地上下文；自动续步停止。自动请求证据保存双方投影及两条已提交消息序号，任一来源变化均会使已完成比较失效。

管理失败携带结构化 Remote code，包括 `scope-agent/stale-binding`、`scope-agent/not-live` 和 `scope-agent/terminal-subscription`；客户端按 code 与 details 判断，不解析诊断文本。已知撤销、过期、退出或缺失的订阅不能恢复。本地 Task assignment 冲突时，仍可对准确绑定执行暂停与退出。

`automatic: null` 仅允许请求时被动读取。`activationLimit` 是此 Session 全生命周期的绝对预留次数上限，不是每次恢复新增的配额。取消的预留仍计入消耗；退出、重新绑定和重启保留 `usedBudget`。耗尽后恢复需要显式提高绝对上限。自动触发消息使用本地目标，远端文本不能授予执行许可。

`pause` 停止自动调度，只删除此 consumer 排队的触发消息。普通用户请求仍可接收当前授权的上下文。`leave` 结束远端接收及其订阅；组合绑定保留本地 Task 接收，并将原自动策略恢复为暂停状态。Agent 取消会停止正在执行或维护中的活动；空闲网络预取不属于 Agent 活动，此时应使用 `pause` 阻止后续自动执行。普通的空闲 Agent 取消不会停用此策略。

只有自动目标的实际模型请求包含精确记录的 scope 快照，且整轮成功完成，才会建立比较基线。普通用户请求、预取、排队的触发消息、失败请求和取消的轮次不会建立此基线。新绑定或改变后的本地目标需要各自完成自动轮次。

backend 声明使用精确投影比较或接收方证据比较。重新在线授权后，完整接收方证据若与基线一致，即使来源记录推进，也会抑制空闲启动，不产生触发消息或消耗预留次数。来源权限、绑定、目标、backend identity 和证据仍参与比较。普通请求仍接收最新精确文本。当前证据组被遗漏时，自动许可因 `coverage` 暂停；调整 scope 或容量后再显式恢复。

如果任何 backend 将当前 Task 版本的 publication 标为 `budget` 省略，自动工作同样暂停。系统在预留前及每次自动模型请求前检查，包括工具调用后的继续步骤；已消耗的预留次数不退还。仅省略自有发布、已替代或已撤回记录不会触发此项检查；普通用户请求仍接收文本 backend 的有界输出及省略信息。

自动轮次的工具后续请求仍须具备原执行许可和当前授权上下文。读取不可用、已结束、失败或内容超限时，即使自动 pulse 已被消费，也会在下一次模型请求前结束该自动轮次。监视器引发的暂停同样阻止后续自动请求，即使下一步之前读取已经恢复；连接恢复不会恢复执行许可。新认领的外部输入可以作为普通工作继续，并获得当前上下文或明确的撤回提示。已消耗的预留和已完成的工具结果仍保留在记录中。

暂停、离开、替换绑定和卸载 consumer 会取消由自有自动触发消息启动的活动轮次。已经发出的请求可能产生了效果，其工作不会自动重放。已经领取但尚未发送的用户输入会返还 Inbox 一次。已发送给模型的混合轮次会中断，独立的普通用户轮次不会被取消。

恢复运行中的 Session 会保留绑定和精确消息历史，但暂停自动执行许可。待处理触发消息会被删除，预留次数不退还。恢复不会创建未运行的 Agent、重放启动动作或重新计算历史文本；下一次实时请求仍需在线读取。

仅 Host 可用的联合加入方法先在来源 Session 中预留精确的读取计划，再创建订阅。`readStateSeq` 比较读取管理事件，普通消息不会改变它。采用 ID 保留原邀请、比较游标、订阅和绑定 ID，以及可选的明确自动策略。省略策略时保持被动接收。自动采用一同记录绑定和策略，仅在 Session 检查点落盘后开始调度。策略沿用现有累计预留次数，不重置或追加额度。待采用的自动计划属于原在线 Agent 和 consumer 实例；实例更换后该计划终结。重试不能覆盖后来的手工操作、恢复已暂停的绑定或重新打开已取消的操作。

Session 先记录并落盘地址变更意图，再由 Access 修改接收记录。若 Access 写入失败，下一次读取或监听会先根据该意图补完；旧地址的迟到响应不会被采用。`updateJoinReadRoute` 对原联合采用操作执行相同规则，也可更新冷存储 Session 而不启动 Agent。采用计划保持不可变。组合计划原子暂停原本地策略、清除待执行触发消息，并保留原绑定及策略；失败或取消的计划让该本地策略保持暂停，需显式恢复。系统会停止其自有自动活动；外部采用等待该活动结束后才安装新绑定。普通轮次可直接采用。自动轮次不能替换自身的接收许可，该调用会被拒绝，避免等待自身结束。显式暂停、换绑或退出会使待采用计划失效。固定的读取状态比较可阻止迟到恢复覆盖后来手动调整的读取状态，包括地址改走后又改回原值的情况。

`cancelJoinRead` 先记录待处理申请的取消终态，再在管理队列外等待已开始的订阅创建并终结该订阅。停止贡献会保留已采用的读取和自动许可，完整退出只撤回该操作拥有的绑定。冷会话取消独占打开已有 Session 日志，不启动 Agent。日志缺失、写入者冲突、非法状态迁移或持久化检查点失败都会使取消报错，调用方须保留待处理意图。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

不透明且经过授权的变化游标把绑定标记为待更新。忙碌 Agent 不接收注入或 steering 消息，其下一次自然 pre-step 会读取当前权限。空闲自动绑定合并变化，同一时刻仅拥有一次预取，在短 `runMaintenance` 内预留启动次数，并排入本地目标触发消息。pre-step 再次独立读取，并在等待后检查准确的 Agent 和绑定。新通知不会阻止已捕获读取的提交，而是为后续请求保留待更新标记。

本地 Task 变化、终结通知、backend 替换及最近的来源到期时间会使同一调度器重新读取。接收 Agent 在本地 Task 上发布的普通 owner-local 工具观察不会单独唤醒它，显式发布和终结通知仍会触发处理。实际 Task admission consumer 拥有唯一注入点；卸载它会中止自有自动工作，替换后的 consumer 不继承自动许可。无来源关联的本地状态及请求证据使用第 2 版，组合绑定与双输入证据使用第 3 版。带采集关联的状态、采用、评估与请求证据使用第 4 版；来源快照和路由意图使用第 2 版。旧版事件保留严格解析，不能接受新增关联投影。

完整状态 Session 事件拥有绑定和累计预留次数。精确上下文消息携带订阅、绑定、grant、peer、Task revision、backend identity、projection identity 和来源覆盖信息。首条消息经正常 Loop admission 进入受保护的 system head 之后。后续投影替换自有的可见节点，同时保留历史事件。终态或不可用读取撤回当前上下文，不会授权自动轮次。

| 源文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 本地管理、有界等待和启动的所有权、请求 admission。 |
| [state.ts](src/state.ts)、[types.ts](src/types.ts) | 严格的重放验证和完整 Session 调度状态。 |
| [recorded-context.ts](src/recorded-context.ts) | 当前匹配共享快照的不含正文元数据。 |
| [messages.ts](src/messages.ts) | 精确上下文文本和持久替换。 |
| [evidence.ts](src/evidence.ts) | 记录调度决定、实际请求证据，以及已完成自动目标的比较基线。 |

此包不发布 invariant companion，因为 Session 投影归约权威事件，每次 admission 检查当前绑定和完整字节预算。scope access 拥有远端授权，AgentLoop 拥有请求与活动顺序。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Scope access](../scope-access/README.zh.md) — 独立读取授权和变化提示。
- [Agent loop](../../core/agent-loop/README.zh.md) — 原生活动、取消和 admission。
- [Session projection](../../session/session-projection/README.zh.md) — 可重放的状态归约。
- [Task context](../development-task-context/README.zh.md) — 本地 Task 分配的上下文。

-----

<a id="model-experience"></a>
## 模型体验

### 共享 scope 快照与本地目标

#### 模型看到什么

远端绑定接收标题为 `## Shared scope context` 的 user-role 消息。本地绑定通过 Task consumer 的第 3 版快照接收 Task backend 文本；调度器不会另加第二个上下文节点。本地自动触发消息要求模型使用当前快照继续显式授权的目标。`## Shared scope context withdrawn` 表明较早快照不能确立当前事实。无需 recall 工具或逐条 publication 发送动作。

#### Token 影响

有条件增加。每个已选来源保留一条当前上下文消息，自动轮次另加有界的本地目标触发消息。复用同一授权投影不增加上下文消息。完整证据一致时可以抑制自动轮次；这不会删除来源历史，也不证明其他工作负载的 token 节省。撤回是简短替换，不是对已移除文本的语义总结。

#### KV Cache 影响

替换可见上下文节点会使该节点之后的请求后缀缓存失效。授权投影不变时保留原节点。历史 Session 事件仍可用于重放。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限原生 Session** — 此 consumer 不能唤醒任意 Claude Code 终端会话，也不会启动未运行的 Agent 或绑定委派／分叉 Agent。
- **只读 scope** — Root Task grant 和职责不授予文件、命令、采集或跨 owner 写入权限。
- **本地范围** — 仅支持精确匹配的 owner 本地 Root Task 分配。过滤自身普通采集不证明跨 owner 语义反馈循环已消除。
- **由 provider 定义比较** — facts backend 比较为接收方选择的受支持声明证据。semantic backend 比较逐字选定摘要及其来源证据；text provider 使用精确投影 identity。这不证明任意改写等价，语义相关性误判也可能抑制有用的响应。即使抑制自动轮次，在线读取和审计记录仍会继续。
- **可见替换范围有限** — 移除自有上下文节点不会擦除普通用户或 assistant 消息引用的事实、撤销已完成工作，也不能证明模型遗忘。
- **显式恢复** — 权限不可用、等待失败、取消、步骤上限和预算耗尽会暂停自动执行许可。恢复后可继续被动读取，自动轮次需要显式恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

短维护预留期间的取消会同步删除自有触发消息，保留其他输入。abort 监听持续到返回的 maintenance promise 结算。插件卸载会取消并等待自有读取与等待结束；自动执行许可被拒绝时，同批用户输入仍然可用。

</details>
