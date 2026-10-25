# Agent Note：AgentHarness 的托管无密钥 CI

Status: implemented

[English](2026-10-25-agentharness-hosted-ci.md) | 中文

## Problem

导入的 CI 只允许手动运行运行器 benchmark，依赖上游私有运行器标签，并引用 AgentHarness 中不存在的 master 专用工作流。本仓库没有注册的自托管运行器。这些配置不能证明项目 main 分支上的 Pull Request 已就绪。

## Decision

[CI](../../../../.github/workflows/ci.yml) 在 Pull Request、main 推送和明确手动触发时使用标准 GitHub 托管运行器。独立 Linux lane 保留现有静态、覆盖率和构建消费方聚合门禁。benchmark 使用独立运行器。Node 兼容性保留 22.19、24.9 和 26。原生 Windows 在 PowerShell 下运行完整 Windows 聚合。Python SDK 测试保持无密钥。CI 与 Python 发布工作流调用同一个原生 wheel 构建器；目标规划和发布清单读取唯一的 Python 运行时平台声明。构建器规定五个原生目标、完整可执行文件与已安装 wheel 的无密钥冒烟、Linux GLIBC 校验和 macOS 架构及部署目标检查。已安装 wheel 的消费方在检出目录外的干净虚拟环境中使用明确的本地 SDK 与运行时路径。受保护发布工作流单独负责发布。

Ubuntu job 通过发行版包管理器安装 bubblewrap，并在依赖沙箱的验收前要求命名空间探针成功。Linux 运行时构建器对已安装 node-pty 的脚本调用仅在该命令中禁用 pnpm 依赖校验，避免 ABI 容器替换主机工作区安装；原生源码编译和 GLIBC 校验仍为必需。

独立的 Linux 覆盖率 lane 在两个覆盖率进程启动前构建 CLI，因为 profile 子进程夹具显式启动已构建入口。这项前置依赖不改变源码导入解析或覆盖率阈值。Windows 已安装 wheel 的步骤删除 PYTHONPATH 和 DSH_RUNTIME_MODE，而不赋空字符串；空的运行时模式属于非法配置。

必需汇总判定依赖所有验收 job，并只接受成功的依赖结果。空结果、跳过、取消、失败及意外结果都会使判定失败；取消后不再启动判定。工作流权限为只读。自动 CI 不接收模型账户密钥，不能调用发布或刷新记录期望。现有逐文件覆盖率阈值和门禁清单保持不变。

一次性托管机器拥有各 job 的检出、工具、缓存、临时文件和子进程。不保留私有运行器选择器、持久主机工具缓存覆盖、待命 lane 或运行器健康兜底。上游部署决策保留为历史：[池故障切换](../../archived/process/2026-07-26-ci-failover-runbook.md)、[兼容性隔离](../../archived/process/2026-09-06-node-compatibility-selfhosted.md)和[发布演练路由](../../archived/process/2026-09-06-release-rehearsal-selfhosted.md)。

## Alternatives considered

仅恢复导入的触发器仍会留下没有运行器的私有标签及不存在的工作流引用。重建上游持久基础设施会增加本仓库没有运行的部署和信任模型。删除测试或将原生验收改为非阻塞会隐藏发布失败，不能提供跨平台证据。

## Consequences

每个符合条件的事件都使用托管资源，包括五个原生独立构建。工作流不声称配置测试能够证明这些平台上的执行已成功。托管执行成功仍是发布条件，包括每个平台的 wheel 校验。本地工作流测试不构建或执行这些平台产物。

[聚焦策略测试](../../../../scripts/tests/agentharness-ci.spec.ts)验证事件订阅、托管路由、必需聚合命令、原生目标，以及不存在模型和发布调用。测试以接受和拒绝的输入执行真实 Linux 判定、原生目标规划和发布清单脚本。Node 22 启动检查观察全文索引未创建，同时独立的 Task KV 数据库已打开；普通 SQLite 警告不能证明全文搜索已启用。清单要求恰好包含一个 SDK wheel 和五个已声明的运行时 wheel，且每个都小于 100 MB。托管发布测试保留手动选择、受保护环境、串行发布、打包安装验证，以及发布已打包字节且不重新构建的要求。已退役的私有池和工具缓存断言由托管要求替代；原生平台、取消、凭据和发布检查仍保留。MCP 冒烟 profile 在外部客户端旁显式声明有界 MCP 注册服务。物理双设备协作和模型采用仍是独立验收要求。
