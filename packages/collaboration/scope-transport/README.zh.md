---
description: "使用持久设备身份、完整 JSON 预算和消费者负责的 scope 授权进行认证直连请求"
kind: "package-reference"
---
# Scope 传输

[English](README.md) | 中文

## 概述

与显式指定地址的设备交换有界 JSON 请求，并在重启后保持设备身份。Noise 验证对端私钥，每个请求都有字节、并发和时间限制。[Scope access](../scope-access/README.zh.md) 对每个请求授权；仅通过连接身份认证不授予应用读写权限。

## 目录

- [使用本包](#use-this-package)
- [身份和请求](#identity-and-requests)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

两台设备都有显式且可直连的 TCP 地址，并由消费者负责应用授权时，挂载此提供方。

### 最小配置

挂载 [credentials provider](../../credentials/credentials/README.zh.md)，再挂载传输提供方及其消费者。以下字段均必填；所示值是组合示例，不是默认值。

```yaml
- name: '@deepseek-ai/dsh-scope-transport/libp2p'
  config:
    listenAddresses: ['/ip4/127.0.0.1/tcp/0']
    maxRequestBytes: 65536
    maxResponseBytes: 65536
    maxInboundRequests: 8
    maxOutboundRequests: 8
    maxConnections: 8
    requestTimeoutMs: 10000
    connectionTimeoutMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `listenAddresses` | 必填 | 显式 IPv4/IPv6 TCP 监听地址；零表示由操作系统分配端口。 |
| `maxRequestBytes` | 必填 | 完整请求信封的字节预算。 |
| `maxResponseBytes` | 必填 | 完整响应信封的字节预算。 |
| `maxInboundRequests` | 必填 | 提供方范围内已准入的入站请求上限。 |
| `maxOutboundRequests` | 必填 | 提供方范围内的出站并发请求上限。 |
| `maxConnections` | 必填 | 库的连接裁剪阈值和待完成入站连接上限。 |
| `requestTimeoutMs` | 必填 | 完整请求或已准入处理器的截止时间。 |
| `connectionTimeoutMs` | 必填 | 连接、协商和库关闭操作的截止时间。 |

[配置目录](../../../docs/config-catalog.zh.md) 从提供方 schema 生成接受的字段。

监听地址只接受显式 IPv4/IPv6 TCP multiaddr。端口为零时由操作系统分配。`identity()` 等待初始化完成，返回公开 PeerId 和带 `/p2p/<PeerId>` 后缀的已绑定地址。请求目标必须在该后缀中包含完全一致的预期 PeerId；Noise 验证目标持有对应私钥。

`limits()` 返回本地 provider 的不可变入站、出站请求上限与请求截止时间。消费方使用这些部署值，在准入长等待时为普通请求保留容量。这些值既不代表远端 peer 的限制，也不为本消费方排他预留槽位。

字节限制包含完整 UTF-8 JSON 信封，必须容纳最小请求或固定失败响应。并发请求上限覆盖所有协议和对端；`maxConnections` 配置库的连接裁剪阈值和待完成入站连接上限。`requestTimeoutMs` 覆盖完整出站操作或已准入的入站处理器。`connectionTimeoutMs` 限制连接建立、协议协商和库的连接关闭时间。两个时长均须处于 Node 定时器的取值范围。

<a id="identity-and-requests"></a>
## 身份和请求

提供方通过 `credentials.modifyRecord` 原子创建或读取 `credentialKey('scope-transport', 'identity')`。其 grant payload 包含版本 1 和 libp2p Ed25519 私钥的规范 base64 编码。已有记录格式错误时启动失败，不会替换记录。并发启动使用 credentials provider 返回的已提交记录。公开状态只包含 PeerId 和地址；错误不包含已保存的私钥材料。

活动实例保持启动时的身份。修改或删除凭据只记录需要重启，不会轮换运行中的私钥。删除凭据后重启会创建新身份。消费者必须把耐久授权和订阅绑定到公开身份，不能把新私钥视为原设备。

`register(protocol, handler)` 注册一个带版本的协议，并返回幂等 disposer，由消费者使用 `ctx.effect` 持有。处理器接收经 Noise 认证的发送者、不可信 JSON payload 和取消信号。它必须使用该认证身份对每个请求授权，在取消后结束，并返回无损 JSON 值。注销阻止新请求准入，并取消已准入工作。提供方卸载会取消全部工作、停止监听和连接，并等待所拥有的操作结束。

`request(target, protocol, payload, signal)` 在等待异步工作前为完整 JSON 请求建立快照。每次调用使用独立流，并返回一个完整 JSON 响应。不支持的 JSON 值、格式错误的 UTF-8 或信封、超出预算、取消、超时及连接失败均以分类的 `ScopeTransportError` 拒绝。处理器异常转换为固定的 `scope-transport/remote-failed` 响应；应用错误必须通过协议自己的 JSON 值表达。响应失败不代表远端处理器没有提交耐久变更，因此消费者负责重试标识和幂等性。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

默认入口声明 `ctx.scopeTransport`；`/libp2p` 使用 TCP、Noise 和 Yamux 实现它。每项协议注册使用连接认证的身份分派独立且有界的请求流。不存在应用 channel 复制或全局请求标识路由表。

| 源码 | 职责 |
|---|---|
| [index.ts](src/index.ts)、[types.ts](src/types.ts) | 与提供方无关的服务及认证请求类型。 |
| [libp2p.ts](src/libp2p.ts) | 直连、流准入、取消和清理。 |
| [identity.ts](src/identity.ts) | 原子凭据初始化及存储私钥的完整性。 |
| [wire.ts](src/wire.ts) | 完整 JSON 信封、UTF-8 校验和固定错误。 |

本服务不发布不变量伴随插件：credentials 负责持久记录互斥，libp2p 负责认证连接，每个请求自行校验完整信封和限制。不存在声称镜像这些权威的第二份投影。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Credentials](../../credentials/credentials/README.zh.md) — 按拥有者隔离的原子记录。
- [Scope access](../scope-access/README.zh.md) — 应用读取授权及投影。
- [架构](../../../docs/architecture.zh.md) — profile 组合和能力服务。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包交换协议拥有的数据，不添加模型消息或工具。

#### KV Cache 影响

本包不构造或修改模型请求。消费者负责由此产生的上下文及缓存影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

提供方明确要求直接可达，并由应用消费者配合。

- **显式直连可达性** — 提供方不包含 DNS 地址、bootstrap、DHT、relay、环境发现、NAT 穿透或后台重连。每次请求按需拨号到显式目标。
- **不负责复制或 scope 授权** — 传输不暴露旧 Mesh channel，也不根据连接准入推断应用权限。消费者负责授权、撤销、耐久回执和重试状态。
- **处理器协作取消** — 进程内处理器必须在信号取消后结束。卸载等待它结束，不会遗弃消费者工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
