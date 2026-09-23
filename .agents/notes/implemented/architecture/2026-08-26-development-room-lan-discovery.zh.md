# Agent Note: 把局域网发现留在通用 development Mesh 传输内

Status: implemented

[English](2026-08-26-development-room-lan-discovery.md) | 中文

## 问题

一次安装已经对应一个独立持有的 AgentHarness 节点，但协作仍要求每位同事分配 node id，并交换完整 peer 拓扑。静态列表让首个共享 Task 依赖额外协调，在地址变化后变得陈旧，而且每加入一名参与者都要求所有现有节点更新。

固定三容器 Docker 拓扑能够验证多节点行为，但不是产品目录。根启动器不能重新创建该 fixture，也不能持有远端节点的生命周期。

## 决策

通用 `development-mesh-websocket` 提供方在认证、复制与重连旁边持有局域网发现。每个活跃节点发送有字节上限且经过严格校验的 UDP multicast 公告，其中包含产品标记、发现协议版本、派生 cluster id、进程 instance id、稳定 node id、Web 端口与 Mesh path。完整公告由 cluster credential 通过 HMAC-SHA256 认证。接收方根据 datagram 来源推导 host 地址，不信任公告中的地址。公告使用 link-local multicast TTL；goodbye 公告或租约过期会移除已发现 peer。

对每一对发现节点，由稳定 node id 字典序较小的一方持有拨号，另一方接受连接。该确定性规则无需 coordinator 即可建立一条 WebSocket。提供方动态增加、更新、重连和移除发现到的 peer，同时保留已配置 peer 作为显式回退。未知入站 node id 在发现或配置建立该 peer 前继续被拒绝。

根启动器只持有安装身份，因为 Cordis 配置求值前已经由它解析 `$DSH_HOME`。全新 home 会在权限 `0600` 的身份记录中获得一个由易读 host slug 与随机后缀组成的 id。显式 id 和有效的非旧版持久 owner 优先级保持更高。旧版 `standalone` 房间与上下文 JSON 记录在启动前完成备份，并原子改写为生成的 id。启动器仍然只启动一个进程，绝不枚举 peer。

Web bundle 为启动器创建的节点启用发现，并使用空的已配置拓扑。Mesh 启动时通过 credentials provider 解析 `AGENTHARNESS_MESH_SECRET`，拒绝缺失或短于 32 字节的值，并且只为 status 派生非密 cluster id 与 fingerprint。发现认证 cluster 节点和消息完整性；它不提供保密性、个人参与者授权或跨局域网路由。

## 协议与生命周期规则

发现 datagram 具有可配置的字节上限，并拒绝未知字段、协议版本、无效 id、无效端口以及 cluster 或 path 不匹配。运行时忽略本进程 instance，报告另一个 instance 复用稳定 node id，只通过有效公告刷新 peer 租约，并在 dispose（资源释放）期间关闭公告 timer、UDP socket、重连 timer、WebSocket 与待处理 command。

自动范围是一个 IPv4 multicast domain。跨 VLAN 路由或禁止 multicast 的网络需要显式 peer，或后续的公司内部 rendezvous 提供方。

## 已考虑的替代方案

**把 peer 发现放进根启动器。** 未采用，因为启动器会成为第二个拓扑 controller，无法响应启动后加入或离开的 peer，并让产品启动耦合到一种传输实现。

**把 Docker 节点列表用作公司目录。** 未采用，因为验收容器是同一台机器上的测试进程，不是同事独立持有的安装。

**使用模型 provider key 认证公告。** 未采用，因为模型 provider 访问与 Mesh 身份具有不同的轮换、披露和授权 domain。专用 cluster credential 单独存储，绝不出现在公告中。

**立即要求中央 rendezvous 服务。** 未采用，因为同子网公司 alpha 使用已经存在 multicast 路径，且目前没有已部署目录服务。出现对应部署后，可以在独立发现实现后增加路由型提供方。

**采用通用 DNS-SD 依赖。** 本阶段未采用，因为当前维护中的候选要么只有公告而没有浏览，要么只暴露违反源码启动 ESM 要求的 CommonJS entrypoint。产品需要一个固定且有上限的公告，而不是通用服务目录。

## 结果

- 现有一行命令启动一个稳定节点，在首次启动前 provision cluster credential，并且不需要 peer 环境变量。
- 三个不带静态 peer 列表的节点会收敛为一个经过认证的全互联 Mesh，增量复制 Room 和 Task channel、淘汰离线节点，并在同一稳定 node id 重启后无需重新配置即可重新获取数据。
- 现有显式 peer 与非旧版持久 id 继续可读；旧版 `standalone` 本地日志完成带备份迁移，且无关 Harness 状态不受影响。
- Cluster secret 绝不出现在发现 frame、日志、status 或 UI 中，只显示派生 id 与 fingerprint。
- Multicast 可用性仍取决于本地网络和主机防火墙。跨路由、禁止 multicast 的网段和纯 IPv6 局域网继续使用显式 peer，直到存在其他发现提供方。
- Node id 与 HMAC 认证 cluster membership，不认证具体同事；被动监听者仍可读取局域网流量。

## 验证

- 启动器测试覆盖全新与重复身份、显式及持久 owner 优先级、带备份的旧房间／上下文迁移、异常状态、dry-run 行为和默认 `0.0.0.0` 监听。
- Mesh 包测试为三个空静态 peer 列表的 Web 节点打开真实 UDP multicast socket，断言确定性全互联拨号归属与 Room、Task 复制，覆盖重放与错误密钥拒绝，释放一个节点，再以同一稳定 node id 重启并验证增量重新获取。
- Portable release 测试覆盖 owner-only cluster credential 的 provision、保留、查看、拒绝意外替换和显式替换。
- 聚焦 typecheck、Oxlint、Web 组合测试、文档 gate 与 Docker 镜像构建覆盖变更的包和启动器表面。
