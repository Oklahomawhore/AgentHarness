# Agent Note: 独立且固定接收方的 scope 读授权

Status: implemented

[English](2026-10-03-independent-scope-read-grants.md) | 中文

## Problem

协作者需要另一位 owner 的当前工作上下文，但不应获得该 owner 其他 Task、Room 成员关系、分配日志或私有对话的访问权。整个集群共用凭据和复制完整 Task 无法表达这种权限。读邀请也必须与采集接收方文件或发布观察的权限分开。

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.zh.md)通过独立认证的 [scope transport](../../../../packages/collaboration/scope-transport/README.zh.md)提供逐接收方读授权。Owner 为一个本地 Root Task、一个接收方 peer、不可复用的授权代际、职责与过期时间签发耐久邀请。接收方保存独立的订阅身份和代际。加入只记录本地意图；每次获取都独立建立在线授权。不伪造 Task 分配 epoch 或原生 Session。

Peer 协议仅暴露绑定邀请的读取。它先认证发送方再查询 Task 内容，对不匹配的 grant、peer 或邀请返回统一且不含 scope 元数据的拒绝。它不暴露 Task 列表、Room、lineage 或副本日志。仅接纳 Root 可排除继承上下文；Fork 和 Merge 授权需要另行决策。职责控制后端路由，而读授权允许读取整个选定 Task。

Owner 在修改队列外调用既有上下文后端。随后它复核当前授权状态、过期、Task 所有权、Root 来源、provider 身份和取消，再持久化精确输出并返回。撤销更新已有记录，不等待慢速计算。新发布到达时，已捕获的来源修订仍可交付；后续获取捕获新修订。这允许持续活动期间交付，同时不把到达顺序当成真相。

每个请求具有新的关联身份。接收方在持久化前拒绝不匹配的 Task、peer、grant、generation、响应身份、投影摘要、来源归属和字节预算。更新的请求或本地退出会使迟到结果失效。双方 Host 保留精确投影文本和覆盖；严格耐久解析与本地 peer 固定防止更换密钥后静默继承旧授权。相同投影字节复用记录；不同记录和终态身份均受显式保留限制约束。

Owner 不可达表示授权未知。接收方在该状态下不返回缓存投影。撤销与过期是不同终态。Owner 决定在耐久授权检查后线性化；已经发送的字节无法召回。消费方框架文本、已记录模型输入以及外部宿主的真实模型准入仍由消费方负责。

传输监听选择与应用权限独立。[Web 组合](../../../../packages/bundle/web-app/README.zh.md#scope-collaboration-network)使用持久设置管理监听，每次 provider 启动只采样一次；保存新值既不改变活动 socket，也不改变授权。邀请控件只接受 Host 当前公布的地址；地址标识连接目标，但不证明远端可达。配置优先级和恢复规则归属[传输 README](../../../../packages/collaboration/scope-transport/README.zh.md#persistent-listener-settings)。

## Alternatives considered

**复用互信 Mesh 副本。** 集群共享凭据与全局复制披露了受邀 Task 以外的内容。独立读取协议仅携带已授权投影文本和覆盖，观察写入区间仍属于另一套授权系统。

**让接收方下载 Task 后计算。** 这会披露 owner 投影省略的来源材料，并要求更广的副本权限。在 owner 侧计算可将来源选择与授权保留在一起，无需传输伪装成完整 Task 的局部快照。

**离线时授权缓存上下文。** 离线租约会延迟撤销，并要求独立的到期和时钟策略。每次请求重新检查可给出更小的承诺：离线上下文不可用，不会被暗示为当前有效或已撤销。

**等待修订停止变化。** 要求 Task 修订在整个计算过程中不变，可能使持续工作期间的交付饥饿。显式捕获修订保留归属；采用时仍检查授权与 provider 身份。

**通过改写实时 Web profile 保存监听。** Web profile 变更可能替换运行中的 provider 并卸载依赖它的消费方。重启生效的设置项将持久偏好与这种生命周期切换分开。

## Consequences

读取权限与采集权限独立，也不授予发布权。代价是依赖 owner 在线，以及精确输出的有限保留容量。过期和已撤销记录保留为终态记录，因此容量变更不能静默复活旧邀请。当获取不可用或连接不活跃时，接收消费方必须停止把旧事实呈现为当前已授权内容。

包内测试覆盖精确持久化、私有 scope 拒绝、错误线上归属、计算期间撤销、本地退出、provider 更换、持续发布、卸载、有界并发读取、存储失败、过期、重启和密钥更换。独立进程 fixture 负责真实认证传输与外部消费方证据；单元结果本身不证明跨机器可达性或模型采用。NAT 穿透、空闲唤醒和跨 owner 写授权不在本决策范围内。
