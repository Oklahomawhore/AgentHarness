# 开发房间验收环境

[English](README.md) | 中文

这个 Docker Compose 环境只构建一次 AgentHarness，并运行三个无需配置 peer URL 即可自动发现完整开发房间 mesh 的独立 Web 节点。它使用 `packages/collaboration` 下的现行协作包；已移除的选举、共识和房间智能包不会被重新引入。

## 启动

内源仓库在根目录 `.env` 中跟踪 `AGENTHARNESS_PROVIDER_BASE_URL` 与 `AGENTHARNESS_PROVIDER_API_KEY`。每个容器会把该文件复制到自己的持久化 Harness home，并在 Cordis 解析 `agentharness-provider` 路由前导出两个值，因此浏览器用户无需进入 Models 页面或配置 provider。

```sh
pnpm run development-room:up
```

启动器通过宿主 Git credential helper 读取现有 `gitee.com` 身份，在 clone／fetch 阶段以权限 `0600` 的临时 Docker secret 提供给容器，等待所有节点健康后删除临时文件，并且不会打印凭据。

打开 `http://127.0.0.1:3081` 访问 `node-a`，打开 `http://127.0.0.1:3082` 访问 `node-b`，打开 `http://127.0.0.1:3083` 访问 `node-c`。

fixture 只为保持测试证据易读而分配确定性 node id。它不提供 `DSH_ROOM_MESH_PEERS` 或单 peer 变量；三个容器必须通过独立安装节点使用的同一房间 mesh 局域网发现完成发现、拨号、淘汰与重连。

启动后运行黑盒检查。它会在 `node-a` 创建或复用一个房间，并要求三个节点的普通 HTTP API 都出现同一个 room id：

```sh
pnpm run development-room:verify
```

三个节点分别持久化 `/workspace` 中的 `agentharness-frontend`、`agentharness-backend` 和 `agentharness-agents` checkout。首次启动从 `origin/main` 创建 `codex/agentharness-mesh-e2e`；后续启动只会 fetch 并快进干净的 checkout，本地工作和提交都会保留。

从分库原型升级时，启动流程会先从持久化 Web profile 中删除已经失效的 `@agentharness/*` 条目，再加载现行内置 bundle。如果预发行房间存储版本与当前 schema 不兼容，启动流程会把旧文件重命名为带时间戳的 `.legacy-vN-*` 备份，并创建全新房间日志。该迁移绝不会编辑业务仓库 checkout 或其他 Harness 状态。

## 查看与停止

```sh
docker compose -f acceptance/development-room/compose.yaml logs -f node-a node-b node-c
pnpm run development-room:down
```

命名 volume 会保留每个 Harness home 和对应工作区。只有确定要删除这些环境专属副本时，才运行 `docker compose -f acceptance/development-room/compose.yaml down --volumes`。
