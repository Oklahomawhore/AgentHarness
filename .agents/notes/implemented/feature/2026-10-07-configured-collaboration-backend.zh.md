# Agent Note: 重启生效的协作摘要设置

Status: implemented

[English](2026-10-07-configured-collaboration-backend.md) | 中文

## Problem

普通 Agent 模型可用，不等于已选择用于整理获准协作报告的模型。每次选择摘要都要求另写部署 overlay，会让用户难以发现这一区别。切换 provider 必须保留已有 Session 模型、正在执行的确切计算以及累计审计额度。

## Decision

[可配置后端](../../../../packages/collaboration/development-task-context/src/configured.ts)注册重启生效的 `scope-context` 命名空间。通过身份验证的 Host 管理页选择报告或语义交付、已有 provider/model 路由以及累计调用上限。启动时只挂载一个既有 provider。保存记录下次选择，不替换运行中的后端、不授予协作访问，也不改变普通 Session 的模型。打开、保存和启动都不调用摘要推理；只有计算需要路由或凭据时，缺失才会导致失败，不会静默选择另一个后端。

部署配置负责隔离的审计目录、稳定 Session ID 和执行限额。Web profile 在普通 Session 持久化之外，保留 `scope-context-audit` 下的一份审计。更换路由、重启和停用后重新启用摘要都会保留预留；失败和未知尝试仍计入已用额度。自定义部署明确保留原目录和身份。系统不会自动发现或迁移合并不同审计历史。

[设置卡片](../../../../packages/client/ui-settings-plugins/README.zh.md)以草稿的 revision 一次保存全部选择字段。设置只读或写入已过期时，不丢弃或覆盖用户草稿。模型目录提供路由选项，不暴露凭据。窄屏设置将导航放在内容上方，并将模型选择器限制在可用宽度内。已存路由缺失时仍显示为不可用；列出路由不证明账户或凭据可用。设置由 Host 管理身份验证控制，不使用 Task 所有者专属授权。

[Overlay 决策](2026-10-04-web-semantic-context-overlay.zh.md)继续负责高级部署组合与已有 Claude hook 替换。原生 Web 的读取和传输期限可容纳默认摘要超时。改变摘要选择不会重装已有 hooks，也不证明远端可达。

## Alternatives considered

**保存后立即重载后端。** 在线替换需要为进行中的读取、取消的摘要、缓存以及独占审计写入者定义所有权规则。重启时应用选择可保留这些既有生命周期，并给用户明确的生效时点。

**复用普通 Session 的模型选择。** 一个 Host 可以服务多个参与者，每个 Session 又有自己的模型。单独保留摘要路由，可以避免改变普通工作或静默开启额外推理。

**更换 provider 或重新启用时重置额度。** 这会允许通过设置变更绕过累计预留上限。稳定审计身份统计使用它的所有选择所预留的调用。

## Consequences

用户无需编辑部署文件即可选择协作后端，但生效仍需重启 Host。设置页记录下次选择，不证明实际接收模型请求已使用摘要。审计隔离使辅助记录不出现在普通 Session 列表中，不会向所选提供方隐藏获准来源文本。调用上限不是金额上限。

验证范围包含延迟生效、普通 Session 模型与历史保持、持久请求重建、带 revision 的保存、不可用路由，以及停用后重新启用时保留预留。受控适配器可在不付费推理的情况下验证这些机制，不能证明摘要保真度、后续任务质量或物理设备协作。[用户指南](../../../../docs/user/guide/collaboration-semantic.zh.md)负责操作步骤。
