# Agent Note：AgentHarness 的托管无密钥 CI

Status: implemented

[English](2026-10-25-agentharness-hosted-ci.md) | 中文

## Problem

导入的 CI 只允许手动运行运行器 benchmark，依赖上游私有运行器标签，并引用 AgentHarness 中不存在的 master 专用工作流。本仓库没有注册的自托管运行器。这些配置不能证明项目 main 分支上的 Pull Request 已就绪。

## Decision

[CI](../../../../.github/workflows/ci.yml) 在 Pull Request、main 推送和明确手动触发时使用标准 GitHub 托管运行器。独立 Linux lane 保留现有静态、覆盖率和构建消费方聚合门禁。benchmark 使用独立运行器，job 的 30 分钟额度包含浏览器安装、编译、执行和清理。托管浏览器准备可能在 benchmark 命令开始前就消耗十分钟以上；job 额度不改变测量用的性能阈值。Node 兼容性保留 22.19、24.9 和 26。原生 Windows 在 PowerShell 下运行完整 Windows 聚合。Python SDK 测试保持无密钥。CI 与 Python 发布工作流调用同一个原生 wheel 构建器；目标规划和发布清单读取唯一的 Python 运行时平台声明。构建器规定五个原生目标、完整可执行文件与已安装 wheel 的无密钥冒烟、Linux GLIBC 校验和 macOS 架构及部署目标检查。已安装 wheel 的消费方在检出目录外的干净虚拟环境中使用明确的本地 SDK 与运行时路径。受保护发布工作流单独负责发布。

Ubuntu job 通过发行版包管理器安装 bubblewrap，并在依赖沙箱的验收前要求命名空间探针成功。Linux 运行时构建器对已安装 node-pty 的脚本调用仅在该命令中禁用 pnpm 依赖校验，避免 ABI 容器替换主机工作区安装；原生源码编译和 GLIBC 校验仍为必需。

Linux consumer lane 安装固定版本的 Python 和 uv，并通过已构建的 `dsh` SDK profile 运行 Python Scope 聚合。显式场景选择项与聚合由同一注册表拥有，聚合保留每个场景的记录期望和验证。这个读取者完成后，HMR 才能改写共享构建产物。仅验证协议的 Python 测试与五平台已安装 wheel 冒烟保留各自独立的用途。

独立的 Linux 覆盖率 lane 在两个覆盖率进程启动前构建 CLI，因为 profile 子进程夹具显式启动已构建入口。这项前置依赖不改变源码导入解析或覆盖率阈值。Windows 已安装 wheel 的步骤删除 PYTHONPATH 和 DSH_RUNTIME_MODE，而不赋空字符串；空的运行时模式属于非法配置。

必需汇总判定依赖所有验收 job，并只接受成功的依赖结果。空结果、跳过、取消、失败及意外结果都会使判定失败；取消后不再启动判定。工作流权限为只读。自动 CI 不接收模型账户密钥，不能调用发布或刷新记录期望。提供方账户验证使用独立的[手动真实 API 工作流](../testing/2026-06-19-real-api-e2e-ci.zh.md)。现有逐文件覆盖率阈值保持不变。

一次性托管机器拥有各 job 的检出、工具、缓存、临时文件和子进程。不保留私有运行器选择器、持久主机工具缓存覆盖、待命 lane 或运行器健康兜底。上游部署决策保留为历史：[池故障切换](../../archived/process/2026-07-26-ci-failover-runbook.md)、[兼容性隔离](../../archived/process/2026-09-06-node-compatibility-selfhosted.md)和[发布演练路由](../../archived/process/2026-09-06-release-rehearsal-selfhosted.md)。

Linux 与原生 Windows 覆盖率通过 `DSH_COVERAGE_TEST_TIMEOUT_MS` 为用例、轮询断言和 hooks 分配 30 秒预算。插桩与覆盖率豁免命令都接收该预算。顺序历史报告准备、完整 Web profile 打包及多条真实命令连续性验证可能超过 Vitest 默认的五秒用例期限和十秒 hook 期限；原生 Windows 还会执行基于 CIM 的进程身份检查。显式夹具期限仍具有优先级。

共享预算校验同时供 CLI 参数及根配置中的两个测试 project 使用。Vitest 4 会将 CLI 用例期限传入 project，却不转发 hook 或轮询期限；只检查参数不能证明后两者的实际预算。根配置与两个 project 接收相同的解析选项。未设置预算时保留 Vitest 默认值，非法预算则在加载配置时失败。配置测试在独立进程中解析真实 project，并在退出前关闭每个 Vitest 实例。

同目录 Session 恢复夹具将清理所有权移交给恢复后的 Host。恢复后的 Session 仍持有文件句柄或待落盘操作时，已退役 Host 不能删除该目录。恢复到另一份复制目录则保留独立清理所有者；这项夹具所有权不需要文件删除重试或生产清理变更。

[完整运行独立门禁决策](2026-10-26-complete-independent-gates.zh.md)拥有调度器完成和中断语义。

生成包关系图的新鲜度检查属于文档聚合。快速／完整本地文档检查与 CI 复用同一检查项；依赖变更后，过期关系图不能通过文档同步验证。

## Alternatives considered

仅恢复导入的触发器仍会留下没有运行器的私有标签及不存在的工作流引用。重建上游持久基础设施会增加本仓库没有运行的部署和信任模型。删除测试或将原生验收改为非阻塞会隐藏发布失败，不能提供跨平台证据。

## Consequences

每个符合条件的事件都使用托管资源，包括五个原生独立构建。工作流不声称配置测试能够证明这些平台上的执行已成功。托管执行成功仍是发布条件，包括每个平台的 wheel 校验。本地工作流测试不构建或执行这些平台产物。

[聚焦策略测试](../../../../scripts/tests/agentharness-ci.spec.ts)验证事件订阅、托管路由、必需聚合命令、原生目标，以及不存在模型和发布调用。测试以接受和拒绝的输入执行真实 Linux 判定、原生目标规划和发布清单脚本。Node 22 启动检查观察全文索引未创建，同时独立的 Task KV 数据库已打开；普通 SQLite 警告不能证明全文搜索已启用。清单要求恰好包含一个 SDK wheel 和五个已声明的运行时 wheel，且每个都小于 100 MB。托管发布测试保留手动选择、受保护环境、串行发布、打包安装验证，以及发布已打包字节且不重新构建的要求。已退役的私有池和工具缓存断言由托管要求替代；原生平台、取消、凭据和发布检查仍保留。MCP 冒烟 profile 在外部客户端旁显式声明有界 MCP 注册服务。物理双设备协作和模型采用仍是独立验收要求。
