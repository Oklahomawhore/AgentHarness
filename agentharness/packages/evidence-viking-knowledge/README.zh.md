# `@agentharness/evidence-viking-knowledge`

[English](README.md) | 中文

这是一个可选 AgentHarness bundle，用于把只读 Viking Knowledge collection 注册到 DeepSeek Harness 的通用 `ctx.developmentEvidence` seam。它通过受管 subprocess 能力调用 `viking-cli`，在每次查询时解析 AK/SK 引用，保留授权与失败状态，校验 CLI JSON 响应，并返回有界且带来源归因的引用。检索不会改变房间或 Session，当前房间阶段也不组合此适配器。

使用 `dsh plugin --profile web add ./agentharness/packages/evidence-viking-knowledge` 安装本地 checkout。设置 `AGENTHARNESS_VIKING_KNOWLEDGE_COLLECTION`，通过 Harness 凭证提供方存储 `AGENTHARNESS_VIKING_ACCESS_KEY` 与 `AGENTHARNESS_VIKING_SECRET_KEY`，然后启动 `web` profile。collection 变量缺失时，bundle 保持禁用。

## 配置

`cordis.patch.yml` 明确列出所有字段：提供方身份与标签、CLI 可执行文件、collection、project、region、cloud、工作目录、凭证引用、收集输出上限、引用摘要上限和进程终止宽限。profile patch 可以替换该行，但必须重述所有字段。

本包的 DSH peer 在运行时仅用于类型，并对 pnpm 标记为可选。安装此可选适配器的 profile 必须提供 `credentials`、`developmentEvidence` 和 `subprocess`。这样可以避免在外部插件下方安装第二套 Cordis 或服务定义图。

## 模型体验

### 请求上下文与触发条件

#### 模型会看到什么

`DevelopmentEvidenceItem` 不会直接进入模型请求。提供方只把 Host 侧引用返回给未来的显式 Consumer。

#### Token 影响

提供方检索不会增加 prompt token。

#### KV Cache 影响

提供方检索不会创建或改变 KV-cache 条目。

## 已知限制与后续工作

- 当前使用部署管理的 AK/SK 凭证，而不是参与者专属 Viking 身份；collection 策略必须把服务账号限制到查询操作人员可以接收的资料。
- 由于 CLI 结果不返回可打开文档 URL，source 使用稳定 `viking://` 定位符。后续 AgentHarness resolver 可以在所属知识界面中打开该定位符。
- 本提供方只读。任何回写都属于独立、经评审的能力。
- 本包仍使用父 checkout 的开发工具链；迁出与独立 CI/发布自动化尚未完成。
