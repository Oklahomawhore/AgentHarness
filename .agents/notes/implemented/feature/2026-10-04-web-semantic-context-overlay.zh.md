# Agent Note: 在 Web profile 中启用语义上下文

Status: implemented

[English](2026-10-04-web-semantic-context-overlay.md) | 中文

## Problem

选择普通 Agent 模型不会选择上下文 provider。单独挂载语义插件可能与既有 provider 竞争，其计算时间也可能超过接收者或 hook 的期限。高级部署需要完整组合示例，明确区分生成摘要与接收摘要。

## Decision

[语义 overlay](../../../../apps/cli/config/examples/scope-context/semantic.cordis.yml)为 Web profile 既有的 configured 后端提供部署默认值，保留单一 provider 和隔离的审计 group；已存摘要偏好优先生效。[设置决策](2026-10-07-configured-collaboration-backend.zh.md)负责普通 UI 路径与重启生效的选择。使用同一 Harness home 重启会保留已消耗的调用预留。普通 Session 持久化和查询与审计分离。

[期限 overlay](../../../../apps/cli/config/examples/scope-context/deadlines.cordis.yml)提供兼容的读取期限，并选择独立的 Claude 命令 profile，因此已有项目 hooks 必须在旧配置下移除后再重新安装。当前原生 Web 默认值已经可以容纳摘要计算。参与者消费获准投影不需要自己的语义 provider，但其普通 Agent 工作仍使用所选模型。

[用户指南](../../../../docs/user/guide/collaboration-semantic.zh.md)负责模型路由选择、启动、预算处理和移除。CLI 发布这两个指定的 overlay 文件；工作区约束拒绝额外发布路径。配置不会创建共享许可或启动普通 Agent。已有读取、贡献和自动工作生命周期继续生效。

## Alternatives considered

**默认启用语义摘要。** 真实模型摘要保真度和任务总成本尚未验证。自动启用会在没有显式部署选择时选定额外模型路由并消耗调用。

**只延长所有者的期限。** 发起读取的 peer 和 Claude hook 命令可能先到期。接收 overlay 覆盖完整的受支持请求路径，无需接收者生成摘要。

**增加另一套评测专用启动器。** 公开 Web profile 已支持显式 patch overlay。使用该入口验证用户实际运行的组合。

## Consequences

Web profile 提供了可执行的按接收者生成语义上下文的可选路径。交付 profile 检查使用独立 home、指向受控本地 HTTP 服务的生产 DeepSeek adapter，以及经身份认证的 peer 读取。它观察受控的延迟响应、精确缓存复用和持久审计隔离。受控回复证明组合与投递行为，不证明语义保真度或后续任务质量。

所有者选择摘要模型并承担其调用费用。调用上限跨重启保留，不是金额上限。两个 peer 都需要兼容的期限；本次不增加发现、中继、embedding 后端或模型质量保证。
