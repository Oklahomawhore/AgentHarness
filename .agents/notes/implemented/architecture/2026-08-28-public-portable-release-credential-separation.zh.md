# Agent Note: 公网便携发行与集群凭据分离

Status: implemented

[English](2026-08-28-public-portable-release-credential-separation.md) | 中文

## Problem

当局域网路由、Wi-Fi 客户端隔离或代理阻止其他节点访问发行负责人的私有地址时，便携安装器需要公网 HTTPS 分发路径。静态公网对象不能安全包含 Mesh 共享密钥，因为任何下载该对象的人都可以认证为集群节点。

## Decision

静态发行暂存未显式接收集群 secret 时，会生成不含凭据的各平台安装器，以及带有 `credential.mode: prompt` 的格式版本 3 清单。首次 Unix 安装会为 `curl | sh` 保留标准输入，通过 `/dev/tty` 在关闭终端回显后读取 join secret，并用 `cluster join --secret-stdin` 持久化。首次 Windows x64 安装使用 `Read-Host -AsSecureString`，只通过重定向进程输入传入恢复后的值，并清零非托管缓冲区。自动化可以提供 `AGENTHARNESS_MESH_SECRET`；join 子进程接收空的继承值，使提供的 secret 写入 owner-only 凭据文件，而不是只存在于进程环境。已有托管凭据会直接保留，不再提示输入。

静态暂存只有在存在 macOS 或 Linux 产物时才生成 `install.sh`，只有存在 Windows x64 产物时才生成 `install.ps1`。两种安装器都会固定发行 URL、目标文件名与 SHA-256，拒绝不安全的 archive member，激活一个不可变版本，启动 loopback 运行时，并执行有冲突保护的 MCP 设置。PowerShell 路径使用 Windows junction 指向 `current`，并通过用户 PATH 中的命令 shim 暴露管理命令。Windows 原生 CI lane 负责打包、安装、后台进程管理、MCP、重启、状态与停止的执行验收；跨宿主组装可用于公网暂存，但不能替代该原生信号。

受信任局域网发布器仍与集群绑定。它会显式提供发行负责人当前的 secret，生成 `credential.mode: embedded`，并且只从私有网络中的随机路径提供安装器。公网托管只暴露不含凭据的安装器、清单和带校验值的运行时 archive；运维人员通过单独获批的私密渠道分发 join secret。

## Alternatives considered

**原样发布集群专用的局域网安装器。** 即使 URL 路径难以猜测，公网对象本身仍会成为可重复使用的集群凭据，因此拒绝该方案。

**把 secret 放进公网安装命令。** 环境变量赋值、查询参数或命令行参数会通过 shell 历史、进程检查、日志或复制的聊天泄露，因此公网命令必须不含凭据。

**为本地 Web 和 MCP endpoint 建立公网 tunnel。** 公网分发不要求公开运行时控制 endpoint；公开这些入口会把认证和传输安全问题扩大到产物交付之外。

## Consequences

无法路由到局域网的协作者可以从同一个稳定 HTTPS 发行安装带校验值的 macOS、Linux 和 Windows x64 便携产物，无需 Git、pnpm 或系统 Node.js。首次安装会增加一步私密 secret 输入，而且静态托管本身无法解决安全的 secret 交付。聚焦测试证明公网暂存不包含提供的测试凭据、会持久化单独提供的 secret、局域网安装仍保留 embedded 模式，并继续通过校验值和升级路径；Windows 原生 CI 防止只凭 PowerShell 文本生成测试就接受进程控制行为。
