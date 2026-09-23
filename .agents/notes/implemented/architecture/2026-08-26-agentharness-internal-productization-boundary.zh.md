# Agent Note: AgentHarness 协作使用便携本地 connector 与自动 MCP 注册

Status: implemented

[English](2026-08-26-agentharness-internal-productization-boundary.md) | 中文

## 问题

内部 alpha 把源码开发流程暴露成产品流程：每位同事都需要 Git 访问、pnpm、本机构建工具和仓库编译。现有 Cursor、Codex、Claude Agent 没有 Harness-as-server 约定；如果直接集中托管未认证的 Web 进程，又会把仓库、终端、credential 和 Agent 能力放到不安全的远程代码执行接口之后。

## 决定

**AgentHarness 使用混合本地产品边界。**Web UI 与 MCP bridge 位于每位同事的机器上，靠近其仓库与工具。面向同事的正式入口是无源码便携 artifact，其中包含 Node runtime、构建后的完整应用 closure、launcher 和 `mcp.mjs`；无需 Git、pnpm、编译器或源码 checkout。

**局域网安装使用 release owner 提供的一条命令。**Release owner 暂存 archive 和安装脚本，从局域网地址提供服务，并分发 `curl <address>/install.sh | sh`。脚本会警告局域网 HTTP 既没有服务器认证，也没有保密性；它安装到 Harness home，在首次启动前配置 cluster credential，启动服务，并打印状态和 MCP setup 指南。升级保留匹配的 cluster credential；指纹不同时，除非 operator 明确 replace，否则拒绝切换。

**MCP 注册是 fail-safe 自动化，并保留手动 fallback。**安装过程和 `agentharness mcp-setup` 分别检测支持的客户端。公开 JSON 配置使用 owner-only 原子写入并保留无关 server；官方 client command 在其拥有注册约定时负责写入。无效 JSON、不同的同名 `agentharness` entry、symbolic-link target、command failure，以及没有稳定 unattended 机制的 client 都是明确 outcome。Status 区分 detected、configured、conflict、manual、absent 和 failed client，且不打印 secret。

**现有 coding Agent 通过一个 loopback STDIO MCP server 接入。**Cursor、Codex、Claude Code 和兼容客户端继续拥有编辑器、模型、chat loop 与仓库权限。Bridge 只接受 loopback Harness URL，也不宣称审计绕过 MCP 的操作。Task-first tool catalog、assignment、context acknowledgement、涌现协作中心 UI 和认证多节点协议由后续的 [Task 谱系决策](2026-08-27-emergence-center-task-lineage.zh.md)负责；该决策取代内部 alpha 的 Room/Mission 产品语义。

## 曾考虑的替代方案

**集中托管现有 Web 进程。**未采用，因为 Host 没有 tenant authorization，而 Agent 能力属于本地仓库旁边。只有具备认证 coordinator 与最小权限 managed local connector 时才重新考虑。

**把 clone-and-build 保留为安装方式。**贡献者仍可使用，但普通用户不应把源码控制 credential、package 安装、编译和 Node 版本管理当作产品前置条件。

**只打印 MCP JSON 和 command。**保留为 fallback guide，但不作为主路径，因为路径替换、逐 client 配置发现以及 configured 与 connected 的区分都容易重复出错。

**为每个编辑器分别构建原生 plugin。**未采用，因为 STDIO MCP 是共享互操作约定，可以只维护一个经过测试的行为面。特定编辑器需要时，原生包装仍可复用同一 bridge。

## 影响

内部用户可以从局域网 release 安装而无需源码工具，保留既有 coding Agent，幂等重跑 setup，并查看服务、cluster 和逐 client 状态。成本是一个本地进程、注册后的 client reload，以及可信 release owner 工作流。局域网 HTTP 仍可被观察和伪造，OS code signing 仍未提供；组织 SSO、集中策略、安全远程协调和 AgentHarness instrumentation 之外的审计采集仍是独立产品工作。

验证覆盖 staging、archive 内容、无 system Node 或 package 工具的 clean-home 安装、start/status/restart、升级 credential 保留、cluster replace 拒绝、secret 文件权限、自动 MCP setup outcome，以及真实 loopback STDIO discovery。
