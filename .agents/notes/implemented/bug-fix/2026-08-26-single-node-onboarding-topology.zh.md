# Agent Note：恢复“一次安装一个节点”的 onboarding

状态：已实现

[English](2026-08-26-single-node-onboarding-topology.md) | 中文

## 问题

根目录一句话启动器错误地把三容器协作验收当成了产品安装拓扑，为每位同事启动前端、后端、算法三个 Docker 节点。真实部署中，一位同事安装并运行一个 AgentHarness 进程；多人协作连接的是不同同事各自拥有的这些节点。

这个拓扑错误又为已有 DeepSeek Harness 用户制造了第二个伪问题：产品进程被移进三个隔离的 Linux home 后，宿主 Web profile 中已经启用的插件消失了，于是实现中又加入插件导出器和三路容器导入器，去跨越产品本来就不该跨越的边界。

## 决策

根目录 `start` 命令现在只启动一个本地 AgentHarness Web 进程。它在需要时安装依赖并构建源码 checkout，默认让普通 Web server 监听 `3080` 端口，等待监听可用后打开本地页面，并以前台进程持续运行，直到用户停止。它不会调用 Docker，也不会准备按角色划分的业务仓库。

本地进程解析 DeepSeek Harness 使用的同一 `$DSH_HOME`（未设置时为 `~/.dsh`）和同一 `web` profile。这就是插件兼容路径：现有组合依赖、层顺序、`cordis.patch.yml`、skill、会话、设置、凭据与存储都原地继续生效，不需要导出产物、复制 profile、计算指纹或重新安装。之后通过普通 `dsh plugin --profile web` 流程做出的插件改动会在下一次 AgentHarness 启动时直接可见。

启动器先保留用户显式配置的 `DSH_ROOM_NODE_ID`，再保留 profile 持久房间日志中已有的非旧版 owner id。全新 profile 会把由易读主机 slug 与随机后缀组成的身份持久化到 `$DSH_HOME/agentharness-node.json`；旧版 `standalone` 房间与上下文日志会先备份，再于启动前原子改写 owner。这个顺序既让已有房间存储继续可读，也让新安装零配置得到抗冲突身份。后续[局域网发现决策](../architecture/2026-08-26-development-room-lan-discovery.zh.md)让多节点协作在房间 mesh 内自动完成，同时保留显式 peer 作为回退。

三节点 Docker 拓扑继续保留在 `acceptance/development-room` 及其 `development-room:up` 命令下。它仍用于模拟三个独立拥有的节点并回归 协作，但不再是根目录安装路径。宿主插件导出器、容器导入器、导入指纹和插件变化触发的容器重建都从该验收夹具中移除。

仓库跟踪的 provider endpoint 与共享 key 保持不变。

## 考虑过的替代方案

**保留默认三 Docker 节点，只改进复制层。** 拒绝，因为即使插件传递成功，它仍保留了错误的所有权与部署模型。

**导出每个已安装插件并在三个容器内重新安装。** 拒绝，因为包归档与指纹只是在解决错误容器边界自己制造的兼容问题；它们还会复制用户 profile，并可能引入宿主到 Linux 的包差异。

**创建独立 AgentHarness home，再复制选定的 DeepSeek Harness 状态。** 拒绝，因为本产品是集成 Harness 发行版；拆分 home 会让插件顺序、patch、凭据、会话和存储逐渐分叉。

**把协作验收缩减为单节点。** 拒绝，因为协作 E2E 仍必须覆盖多个独立进程与复制链路。本修复做的是分离验收拓扑与安装拓扑。

## 结果

- 一位同事的一次安装和前台进程对应一个 AgentHarness 节点。
- AgentHarness 运行同一个 Web profile，因此现有 DeepSeek Harness 插件与用户状态无需克隆或迁移即可继续生效。
- 默认 onboarding 命令需要 Git 和 Node，但不需要 Docker、预装 pnpm、填写 provider 或执行另一条启动命令。
- 同一 multicast domain 内的协作会自动发现可达 AgentHarness peer；跨路由或禁止 multicast 的网络仍需显式 peer。
- 固定三节点环境继续用于协作验收，不再依据宿主插件 profile 改写其节点。
- 共享 provider 配置保持权威且不变。
