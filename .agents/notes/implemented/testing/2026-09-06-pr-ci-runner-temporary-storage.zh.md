# Agent Note: PR CI 使用 runner 管理的临时存储

Status: implemented

[English](2026-09-06-pr-ci-runner-temporary-storage.md) | 中文

## 问题

Linux 故障切换池在同一台虚拟机上运行多个 runner 实例。PR 覆盖率和快照进程使用操作系统临时目录存放转换后的模块与测试夹具。runner 临时目录之外的文件不受作业清理管理，取消执行阻止进程自行清理时也不例外。该共享目录耗尽会让无关 PR 在测试执行前就失败。

## 决策

[托管 CI 决策](../process/2026-10-25-agentharness-hosted-ci.zh.md)取代持久运行器分配。每个一次性 job 拥有自己的检出、包安装、临时文件和浏览器进程；夹具仍分配唯一根目录、立即注册清理，并等待完全静止。

包管理器缓存遵循标准准备动作；每个托管 job 安装自己的浏览器。CI 不复用上游私有池、不导出共享主机工具缓存 preload，也不回收属于其他进程的临时文件。

下文的夹具同步和放置决策独立于运行器选择，继续有效。[已归档部署手册](../../archived/process/2026-07-26-ci-failover-runbook.md)记录共享主机事件的背景。

## ACP 完成顺序的录制

[ACP 诊断场景](../../../../snapshots/session/subagent-acp-diagnostic/cordis.snapshot.yml) 暂停脚本化的后台响应，直到 `job_output` 开始等待完成。没有这种同步，快速子进程可能在录制的父步骤之间发布合法的作业通知。场景本地 wrapper 在 jobs 服务注册完成等待器后释放子进程；mock 在测试私有 workspace 中监听独占创建的标记，并在释放后关闭 watcher。夹具在销毁时恢复被包装的方法。录制的 Session 字节和生产作业通知行为保持不变。

## Workspace 授权夹具的位置

Headless 的 `session-sandbox-root` 夹具声明 `workspace.parent: outside-temp`，而不是依赖 home 所在文件系统。分配器在父目录可写且避开系统临时授权时选择规范化平台临时根目录的同级目录，否则使用 home，并拒绝已被自动临时写授权覆盖的 cwd。在故障切换 runner 上，这让测试留在数据卷中，同时不会让写入借助临时目录豁免而成功。文件系统沙箱的包含关系测试使用同一分配器创建 workspace 及被拒绝的同级目录，并在成功获取目录后立即注册清理。原子 workspace 分配、录制的 Session 字节以及独立预期文件保持不变。

## 在线验证与浏览器夹具输入

已安装 wheel 的在线 SDK 测试在要求模型验证前，由外部将创建的文件替换为新的、仅主机知道的挑战值；验证提示不暴露该值。两个 turn 必须包含模型请求的工具调用，验证器同时比较返回值及真实文件字节。

Reference-composer 夹具将已知的 home 缩写 workspace 显示映射到既有 cwd token，并在选择前等待当前精确建议集；主机路径或过时建议都不决定测试结果。共享浏览器时区、Inspector 订阅同步及 PowerShell 完成行为遵循[既有平台测试决策](2026-09-07-pwsh-ci-observable-completion.zh.md)。

高级 Python 快照仅暂停其匹配的 workflow 子进程首次 pre-step，直到观察到父 Session 的持久化 workflow 成员事件。夹具支持事件先到或等待先建立两种顺序，并在取消或销毁时结束未完成等待。这固定了场景的跨 Session 顺序，而不排序通知或改变生产调度。

Queue 快照在捕获前将指针移离 Stop/Send 控件，并等待其 Send tooltip 关闭。Workspace-management 测试通过操作按钮定位唯一非空 Session，而不依赖行位置；在断言归档会移除空的 Ungrouped 分组前，先选中该 Session。Hover 行为、队列内容、持久化归档身份及重载断言保持不变。并发 spill 隔离测试将每个根目录与其运行结果关联，而不假设文件系统分配完成顺序与输入顺序一致。

## 考虑过的替代方案

**由 PR 作业删除共享临时文件。** 其他 runner 可能仍在使用这些文件。仓库作业不得按路径或文件年龄回收共享目录。

**重试测试或增大超时。** 两者都不能恢复存储空间，也不能为残留文件指定清理责任方。

**仅依赖一次性 runner。** 一次性机器不能给并发夹具分配唯一资源，也不能同步其观测。每个夹具仍需负责分配和清理。

## 影响

遵循 `TMPDIR` 的输出随作业生命周期清理，而不累积于无人管理的主机存储。包管理器缓存使用准备动作；浏览器进程和文件属于一次性 job。本方案不回收既有共享临时文件、不保证文件系统容量，也不清理 runner 账号无权删除的文件。历史残留、磁盘配置以及本 PR 工作流以外的作业仍由运维人员负责。

Linux bwrap 和 Landlock 的 workspace-write profile 允许写入字面路径 `/tmp` 和 workspace，而不允许写入其外部继承的 `TMPDIR`；受限测试夹具必须将临时写入放在这些已授权路径中。[快照 spill helper](../../../../packages/test-support/session-snapshot/src/harness.ts) 将固定长度的逻辑定位符与原子分配的实际存储分开。仅用于夹具的适配器将保存操作委托给真实的本地 spill provider，并仅将本次运行已保存的定位符解析到实际文件。录制的预览长度、省略计数及检索断言保持不变；逻辑 `/tmp/dsh-acp-snap-*` 前缀下不分配文件。本变更不扩大产品沙箱授权。

[托管工作流测试](../../../../scripts/tests/agentharness-ci.spec.ts)验证一次性运行器选择和必需验收 job。夹具分配和同步继续由各自的测试独立验证；仅有工作流断言不能证明主机容量充足。
