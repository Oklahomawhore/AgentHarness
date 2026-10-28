# Agent Note: Client 清单共享快照 store，并保留各自的生命周期所有者

Status: implemented

[English](2026-10-25-client-inventory-snapshot-store.md) | 中文

## Problem

Workbench、参与者、Task 与 MCP 客户端清单需要稳定快照及渲染器订阅。它们的 Host 查询、修改、连接重置和在线租约由不同模块负责。在每个目录内重写观察者分发，会让渲染失败影响异步刷新结算，并重复实现状态发布。

## Decision

[Workbench 清单](../../../../packages/client/ui-dev-workbench/README.zh.md)与三个[协作目录](../../../../packages/client/ui-emergence-center/README.zh.md)使用既有同步 [Client 快照 store](../../../../packages/client/store/README.zh.md)。订阅回调异常会被报告，不会中断其他订阅者。同一回调的重复注册各自持有独立的取消订阅函数。非生产环境的整值发布会深度冻结可 draft 的值；初始值不会被隐式冻结。

渲染器负责清理订阅。消费者只读取嵌套 DTO，不作修改；Task 图布局另建节点及位置对象。刷新顺序、陈旧响应代际、修改操作与参与者租约清理仍由各目录负责。参与者刷新统一报告目录读取与身份公告失败，并在操作结算后释放读取锁。租约回复仍须属于当前连接代际和所选身份。关闭时停止新工作，等待已发出的租约请求结算后再尝试撤回。计时器在通知观察者之前安排，因此观察者同步重置或关闭目录时可以取消该次续租。

Task 目录及谱系查询使用 Host 配置的结果默认值；浏览器不复制第二套限额。目录在刷新目录和连接重置时保留所选 Task，重新读取其谱系，并保留位于有界目录之外的已选图节点。独立的请求序号拒绝同一连接内较早的聚焦响应，包括失败；连接代际仍负责拒绝被替换 Host 连接的响应。Task 增补和更新会比较 revision，防止谱系响应覆盖更新的通知数据。

[读取授权失效通知](../bug-fix/2026-10-24-owner-read-inventory-synchronization.zh.md)保留独立的通知及权限决策；清单引擎不替代 Host 权威或 contribution directory。

## Alternatives considered

**在每个清单中保留 listener set。** 这会让观察者异常沿刷新 Promise 传播，回调注册的所有权也与渲染器既有 store 引擎不同。共享引擎负责这些发布语义，不接管 Host 操作。

**统一的刷新或生命周期控制器。** Workbench 显式启动查询，MCP 配置替换单个客户端，参与者查询可能声明并续期租约，Task 查询则组合目录、分配和有界血缘。共享控制器需要策略回调，并会掩盖这些既有所有者。

## Consequences

订阅回调异常不会让刷新失败，每次渲染器注册都可独立移除。开发环境发布会冻结嵌套数组与普通对象，因此须以只读方式使用 DTO。目录测试覆盖重置代际、错误、修改、租约释放及订阅清理；实际 UI 组装测试覆盖渲染器更新与销毁。不引入通用控制器、新 Host 权威、持久事件或模型输入。
