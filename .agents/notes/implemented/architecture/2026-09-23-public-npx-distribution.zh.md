# Agent Note: 公开 npm 启动包与无凭据源码导出

Status: implemented

[English](2026-09-23-public-npx-distribution.md) | 中文

## Problem

公开安装不能依赖仓库凭据或源码构建。私有源码历史包含 provider 凭据，即使当前工作区已清理，公开 Git 历史仍会泄露信息。

## Decision

npm 启动包打包现有的固定版本便携安装器，仅在显式调用时启动它们。DeepSeek Harness 保留在便携依赖闭包中。HTTPS staging 拒绝嵌入集群凭据。全新安装生成自己的集群密钥；安装器保留已有凭据。模型 API key 由用户提供。

环境文件被忽略并从索引移除，示例文件中的 key 为空。公开源码导出器复制当前文件，不包含 Git 元数据，拒绝识别出的凭据及与本地密钥完全相同的值，并生成引用审计。撤销凭据和审查仍由发行负责人完成。

[便携凭据隔离记录](2026-08-28-public-portable-release-credential-separation.zh.md)仍负责安装器校验与私有团队加入。此决策部分替代[源码发行记录](2026-08-25-agentharness-turnkey-development-room.zh.md)中跟踪凭据的策略；其组合与验收拓扑仍然有效。

GitHub main 分支发布使用独立的 `0.1.<run_number>` 版本序列，保留 workspace 的上游包版本。所有原生产物成功后才公开 Release；npm 独立认证并发布同一 tarball。上游工作流仅保留手动触发，防止本分支自动访问上游发布账号或专用 runner。

## Alternatives considered

**仅依赖上游 npm。** AgentHarness 分支增加了运行时包，上游依赖无法安装本产品的完整运行时。

**删除环境文件后公开原历史。** 旧 blob 仍保留凭据。全新源码导出避免分发这些对象，同时不改写私有仓库。

**嵌入团队凭据。** 公开产物不能携带共享认证信息。独立安装创建自己的集群，之后显式加入团队。

## Consequences

启动包需要 Node.js 和平台安装工具。npm 发布前必须托管产物；URL 与校验值在 staging 时固定。重复调用会再次下载固定归档。每个对外支持的平台仍需原生验收。GitHub 托管 runner 无法访问局域网组播组，因此便携包启动验收关闭局域网自动发现；本地启动与已配置 peer 的行为由各自验收路径覆盖。聚焦子进程检查覆盖私有凭据生成、显式团队输入、失败传播、源码排除规则，以及拒绝凭据和 HTTP staging。现有便携验收负责启动与校验行为；此发行改动没有增加模型转录行为。
