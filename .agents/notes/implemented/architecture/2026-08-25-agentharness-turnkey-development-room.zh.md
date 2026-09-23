# Agent Note：以单一源码 checkout 交付 AgentHarness provider 与协作验收

状态：已实现

[English](2026-08-25-agentharness-turnkey-development-room.md) | 中文

## 问题

最初的 AgentHarness 房间分库提交位于一个与内源仓库保留的 DeepSeek Harness 历史无关的根提交上。直接重放会恢复已经删除的 `packages/room` 包、旧选举协议以及 Docker 镜像里的第二套源码树；模型路由还依赖 Web 手工配置，导致缺少凭据，或者在 endpoint 缺失时把 token 发往无关 router。

后续 onboarding 实现又混淆了固定三容器协作验收与产品拓扑：根启动命令会为每位同事创建三个 Docker 节点，而实际上一位同事独立安装并运行的 Harness 进程就是一个 AgentHarness 节点。这个边界错误还凭空制造了宿主插件复制到容器的问题。修正过程记录在[单节点 onboarding 拓扑说明](../bug-fix/2026-08-26-single-node-onboarding-topology.zh.md)中。

## 决策

继续以内源 `master` 历史为基线，只在现行包图上增加窄范围 AgentHarness overlay：base bundle 通过 `llm-pi-ai` 声明 `agentharness-provider`，默认模型选择该路由；Web bundle 启用 development-room 局域网发现，同时保留 `DSH_ROOM_MESH_PEERS` 和原有单 peer 变量作为回退。

根目录 `.env` 仅供本地使用，用户复制 `.env.example` 后填写自己的 provider key。产品启动在 Cordis 解析组合包表达式前加载调用 checkout 的环境。端点保留精确的 config-source ownership 例外。公开凭据处理遵循 [npm 发行决策](2026-09-23-public-npx-distribution.zh.md)。

根目录 `start` 脚本是产品 onboarding 入口。复制的一条命令会通过 npm 调用仓库固定的 pnpm 版本，在需要时安装依赖并构建当前 checkout，然后在同事自己的机器上启动一个前台 Web 进程。它使用 DeepSeek Harness 原本使用的同一 `$DSH_HOME`（未设置时为 `~/.dsh`）中的普通 `web` profile，因此现有插件和用户状态原地继续生效。启动器会优先保留显式节点 id 或已有持久房间日志的 owner，为全新 profile 持久化由主机 slug 与随机后缀组成的身份，并安全迁移带备份的旧 `standalone` 日志；随后等待本地 Web 监听可用并打开回环地址。它不会启动 Docker，也不会克隆按角色划分的业务仓库。

协作由 development-room WebSocket 提供方内部有上限的 IPv4 multicast 发现连接这些独立安装节点。稳定 node id 为每对节点确定唯一拨号方；multicast 被禁止时仍可使用静态 peer 变量。每个节点继续拥有自己的 Harness profile、会话、插件、工作区和进程；房间只复制其文档明确声明的协作状态。具体边界记录在[局域网发现说明](2026-08-26-development-room-lan-discovery.zh.md)中。

`acceptance/development-room` 下的 Docker 环境继续作为独立的三进程验收夹具。它直接构建当前 checkout，为每个容器准备一个业务仓库工作区，并在不配置 peer URL 的情况下启动三个现行 Web profile，从而可重复验证协作发现与复制。不兼容的预发行房间存储会保留为带时间戳的 `.legacy-vN-*` 文件，而不是被解析或删除；该迁移不会接触业务仓库 checkout 或无关 Harness 状态。已经移除的共识、选举、房间智能、bridge 和 UI 包不会复活。

## 结果

- 已配置本地 API key 的用户可以拉取、构建并启动一个本地节点，无需进入 Models 页面。
- 一位同事的安装就是一个节点。多人房间由这些各自拥有的节点组成，不是在每台电脑上创建三个容器。
- 现有 DeepSeek Harness 插件、组合顺序、用户 patch、skill、会话、设置、凭据与存储继续位于同一 Web profile，无需导出或重装。
- endpoint 固定为火山引擎 Coding Plan 的 OpenAI 兼容地址，用户提供的 bearer token 不会发送到 Teamo Router。
- 用户在本地环境中轮换 provider 凭据，不提交凭据。
- `DSH_ROOM_MESH_PEERS` 是 multicast 被禁止时的可选回退；一旦提供，必须是合法 JSON。
- 三容器 协作角色拓扑只通过 `development-room:up` 保留用于协作验收。

## 考虑过的替代方案

**Cherry-pick 无共同根提交，并把所有冲突保留为本地版本。** 拒绝，因为这会撤销远端包重组，并恢复当前仓库已经主动移除的协议。

**恢复旧 collaboration bundle 和凭据灌入插件。** 拒绝，因为产品启动流程已经负责分层 `.env` 加载，第二个 credential writer 会增加顺序和持久化行为，却没有第二个事实来源。

**要求每位同事配置 Models 页面。** 拒绝，因为内源发行明确要求仅凭仓库地址完成 onboarding，并统一使用一个批准的 provider 路由。

**把三容器验收环境用作默认安装。** 拒绝，因为这会把一位同事变成三个虚构节点，重复 profile 和工作区，并错误表达跨人协作的真实部署方式。

**继续把安装、构建、启动、ready 检查和地址发现拆成多条文档命令。** 拒绝，因为每次手工衔接都可能让 alpha 用户在进入第一个可用节点前流失，而启动器已经掌握验证 ready 并打开正确页面所需的信息。
