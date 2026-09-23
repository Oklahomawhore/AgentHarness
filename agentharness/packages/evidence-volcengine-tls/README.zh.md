# `@agentharness/evidence-volcengine-tls`

[English](README.md) | 中文

这是一个可选 AgentHarness bundle，用于把只读火山引擎 TLS topic 注册到 DeepSeek Harness 的通用 `ctx.developmentEvidence` 注册表。它按照火山引擎 V4 协议签名 `POST /SearchLogs`，在每次查询时解析 AK/SK 引用，通过字节上限读取响应，校验 JSON 字段，并返回有界日志引用。检索不会改变房间或 Session，当前房间阶段也不组合此适配器。

使用 `dsh plugin --profile web add ./agentharness/packages/evidence-volcengine-tls` 安装本地 checkout。设置 `AGENTHARNESS_TLS_TOPIC_ID`，通过 Harness 凭证提供方存储 `AGENTHARNESS_TLS_ACCESS_KEY` 与 `AGENTHARNESS_TLS_SECRET_KEY`，然后启动 `web` profile。`AGENTHARNESS_TLS_ENDPOINT` 和 `AGENTHARNESS_TLS_REGION` 可以选择其他区域 endpoint。TopicId 缺失时，bundle 保持禁用。

## 配置

`cordis.patch.yml` 明确列出所有字段：提供方身份与标签、HTTPS endpoint origin、region、确切 TopicId、凭证引用、回溯时长、结果顺序、查询字节上限、响应字节上限和引用摘要上限。本包不包含 topic alias 或凭证。endpoint 必须是不带内嵌凭证和其他 URL 组成部分的 HTTPS origin。

每次检索都把操作人员输入作为 TLS 查询表达式，并在配置的滚动时间窗口内执行。包含 `|` 的 SQL 分析表达式会被拒绝，因为聚合响应使用不同的引用语义。成功响应必须报告 `ResultStatus: complete`；HTTP 授权错误映射为 `denied`，限流和服务端错误保留为可重试失败，格式错误、不完整或超出大小的响应绝不会产生部分证据。

每条结果保留 `tls://search/<topic>/<time>/<record>?start=...&end=...&query=...` 定位符，以及根据规范化日志记录计算的 SHA-256 revision。安装此可选适配器的 profile 必须提供 `credentials` 和 `developmentEvidence`。

## 模型体验

### 请求上下文与触发条件

#### 模型会看到什么

TLS 日志不会直接进入模型请求。提供方只把 Host 侧引用返回给未来的显式 Consumer。

#### Token 影响

TLS 检索不会增加 prompt token。

#### KV Cache 影响

TLS 检索不会创建或改变 KV-cache 条目。

## 已知限制与后续工作

- 身份验证使用部署管理的 AK/SK 凭证，而不是参与者专属火山引擎身份。IAM 账号与 TopicId 必须只暴露每位获授权房间操作人员都可以查询的日志。
- 查询窗口由部署配置，并以 Host 时钟为结束时间。调用方无法通过当前提供方无关的证据请求指定任意历史区间或翻页。
- topic 字段名和历史索引变更仍属于部署知识。提供方会发送确切 TLS 表达式，不会把旧查询改写成范围更广的全文搜索。
- 日志记录可能包含私有用户内容或工具内容。检索结果对执行查询的操作人员可见；任何更广用途都需要独立评审策略。
- `tls://` 定位符目前没有浏览器解析器。后续 AgentHarness diagnostics 界面可以重新打开精确 topic、时间窗口、查询和记录 revision。
- 本包仍使用父 checkout 的开发工具链；迁出与独立 CI/发布自动化尚未完成。
