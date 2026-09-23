# 开发工作台

[English](development-workbench.md) | 中文

开发工作台由 profile 配置的 Host 任务控制器和面向人的 Web 面板组成。它为仓库专用开发服务器提供 Harness 管理的进程树、有限输出及一个或多个浏览器视图，同时不把项目路径、命令或端口变成产品常量。随附 Web 组合包组合一项空服务；部署需要该面板时由 profile 提供条目。

源码：[`packages/host/dev-workbench/src/index.ts`](../../packages/host/dev-workbench/src/index.ts)、[`packages/host/dev-workbench/src/types.ts`](../../packages/host/dev-workbench/src/types.ts)与 [`packages/client/ui-dev-workbench`](../../packages/client/ui-dev-workbench)

## 任务记录

`DevWorkbenchEntryId` 与 `DevWorkbenchViewId` 是由 profile 编写、匹配 `[a-z][a-z0-9-]*` 的品牌化 id。`DevWorkbenchView` 包含一个 id、标签与不内嵌凭证的规范化 HTTP(S) URL。同一条目的多个视图共享一个进程及其生命周期。

`DevWorkbenchEntrySnapshot` 包含配置的 id、标签、argv、工作目录与视图，以及当前的 `idle`、`running`、`stopping`、`stopped`、`exited` 或 `failed` 阶段。进程 id 只在任务实时运行时存在。启动与完成时间戳、退出事实和 spawn 失败文本会在已知时出现。Stdout 与 stderr 是分别具有有损标记和可选 spill 路径的有限保留尾部；当前实现不启用 spill 文件。`DevWorkbenchSnapshot` 按配置顺序保留所有条目。

可选的 `DevWorkbenchReadinessSnapshot` 记录由部署配置且不含凭证的 URL，以及独立的 `checking`、`delayed` 或 `ready` 状态，还可包含最近检查时间、状态码或传输错误。就绪延迟期间，任务进程仍保持 `running`。可接受状态码、轮询间隔、请求超时与告警阈值均由 profile 显式配置。

服务按条目串行执行启动与停止操作。对实时任务执行启动会返回当前快照；在任务结算后启动会替换保留的进程句柄与输出。停止操作会取消并等待就绪探测、终止完整进程树并等待完全停稳。Harness dispose（资源释放）会以相同顺序处理所有实时任务。stdin 保持断开。

浏览器通过 [`dsh-api-remotes`](../../packages/api/remotes/README.zh.md) 消费生成的 Remote。清单为空时，其底部操作会隐藏。打开的面板通过 portal 位于布局缩放手柄之上，每秒轮询一次，在配置的就绪状态成立后才挂载所选 iframe；左下角缩放手柄配有小屏幕近全屏回退布局。经过校验的浏览器本地偏好会跨刷新保留面板尺寸、选中任务与选中视图。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdevworkbench--devworkbenchservice"></a>

### `ctx.devWorkbench` — `DevWorkbenchService`

Host runtime for configured development tasks.

```ts cordis-catalog
/**
 * Read every configured task and its retained output.
 * @returns Point-in-time task state in configuration order.
 */
@Remote('list') list(): DevWorkbenchSnapshot

/**
 * Start one task, or return its current state when it is already live.
 * @param id - Configured task identity.
 * @returns State after the serialized start operation.
 */
@Remote('start') start(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot>

/**
 * Stop one task's complete process tree and wait until it is gone.
 * @param id - Configured task identity.
 * @returns State after the serialized stop operation reaches quiescence.
 */
@Remote('stop') stop(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot>
```

Source: [`packages/host/dev-workbench/src/index.ts`](../../packages/host/dev-workbench/src/index.ts)
<!-- END GENERATED cordis-surface -->
