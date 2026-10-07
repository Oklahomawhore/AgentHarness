# 为共享 Task 启用语义摘要

[English](collaboration-semantic.md) | 中文

当 Task 所有者希望模型按各接收者的职责整理获准工作报告时，可选择此配置。不启用时，Web profile 使用 [`/reported`](../../../packages/collaboration/development-task-context/README.zh.md#behavior) 交付有界 publication，并在不调用模型的情况下重建满足条件的文件报告组。选择聊天模型不会自动启用语义摘要。

## 1. 准备所有者的模型

在所有者的 Host 上，通过**模型**配置可用 route。把[语义 overlay](../../../apps/cli/config/examples/scope-context/semantic.cordis.yml) 复制到自己的配置文件，再将其中 `provider` 和 `model` 改为该 route。示例名称是 `deepseek-official` 和 `deepseek-flash`；保留这两个名称时，必须配置好对应 route 并确保可调用。不要把 API key 写入 overlay。

启用前检查明确限额。示例最多允许累计预留100次摘要调用，重启不清零，同时最多执行两次。每次模型计算最多允许20秒；失败时不会拿旧摘要顶替。token、字节和调用次数限制不等于供应商扣费上限。

摘要调用使用所有者配置的模型和凭据。各参与者的普通 Agent 工作仍使用自己选定的模型，也可能各自产生费用。摘要提供方会收到获准来源文本；审计不出现在普通聊天里，不代表提供方看不到这些文本。

## 2. 让双方使用兼容的期限启动

CLI 在 `config/examples/scope-context/` 随包提供[期限](../../../apps/cli/config/examples/scope-context/deadlines.cordis.yml)和[语义](../../../apps/cli/config/examples/scope-context/semantic.cordis.yml) overlay，仓库内位于 `apps/cli/` 下。复制到自己管理的位置，并替换以下绝对路径。示例从已构建仓库的根目录运行 dsh CLI；已安装的 `dsh` 可替代 `node apps/cli/lib/bin.js`，没有单独的语义开关。重启时保持原 Harness home 和 Task 存储。如果已安装 Claude hooks，请先按下文在旧配置运行时移除，再停止旧 Host。

Task 所有者加载两份 overlay：

```sh
node apps/cli/lib/bin.js web --patch "/absolute/path/to/deadlines.cordis.yml" --patch "/absolute/path/to/my-semantic.cordis.yml"
```

仅接收该所有者上下文的 Host 加载期限 overlay，不启用自己的摘要提供方：

```sh
node apps/cli/lib/bin.js web --patch "/absolute/path/to/deadlines.cordis.yml"
```

每份 overlay 都替换完整的插件配置。如果你的 Web 组合已定制这些限额或 Claude 配置字段，请将原值保留到自己的副本中，同时保持较长的期限和独立 hook profile。已保存的协作监听偏好仍优先生效。

双方都需要期限 overlay：只延长所有者的模型超时不会延长接收者的等待时间。启动器的 `--patch` 必须放在 `--no-open`、`--port` 等应用选项之前。后续启动命令也要保留这些 overlay；单次传入文件不会保存为新设置。

semantic overlay 选择该 owner Host 的上下文后端，不是只影响某一份邀请。切换后端不会创建读取授权、文件许可或自动工作许可，仍使用[协作加入流程](collaboration-network.zh.md)。重启后检查采集和自动工作状态：恢复读取不会授权新采集，自动工作仍需明确恢复。

### 已安装的 Claude Code hooks

期限 overlay 使用独立的命令 profile `claude-hook-summaries`，不会自动迁移已有 hooks。在受支持的 macOS 或 Linux Host 上，切换期间先暂停 Claude 工作，再对每个已配置的项目按以下顺序操作；无需选择 Task：

1. 保持旧 Web 配置运行，在侧栏选择**打开涌现协作中心**，找到 **Claude Code**，在**项目路径**填入原项目，然后选择**检查配置**。显示**项目 hooks 已配置**后，选择**移除项目 hooks**。
2. 停止旧 Host，按上述命令加载 overlay 启动替代进程。在同一 Claude Code 区域填写项目路径，选择**配置 hooks**，新 hooks 将使用 `claude-hook-summaries`。
3. 在该项目打开或重启 Claude Code，发送下一条消息，再选择**刷新会话**。Claude 决定何时加载变更后的 hooks；配置成功本身不能证明正在运行的 Claude 会话已加载配置或收到上下文。

移除 hooks 会保留共享命令 profile 和已有会话授权，不等于停止共享或接收。如果要结束这些行为，还需使用相应会话的停止或退出操作。如果新配置提示与旧 hooks 冲突，请先恢复原 Host 配置，再移除与它匹配的 hooks，不要覆盖项目里的其他设置。切回旧期限配置时，也应遵循先移除再重新配置的顺序。

## 3. 核对配置与已记录的摘要

启动前，可在所有者命令中添加 `--dump-config` 查看最终组合。确认默认后端配置项已禁用、已选择 semantic，且模型 route 和限额符合自己的选择。配置预览不调用模型，也不能证明凭据可用。

对于已获自动许可的 Session，**当前会话协作**展示当前目标已记录的请求与已完成轮次，也展示证据未变而跳过响应，以及证据不完整导致后续请求暂停。这些记录会自动更新；轮次完成不代表产物正确。

获准文件工作发生且接收端 native Session 发出下一次请求后，打开**当前会话协作 → 查看来源**。在轨迹中选择 `scope-agent-context` 消息并打开**来源**标签，展开 `projection` 和 `backend`：`id` 标识该次已记录投递使用的 provider，应为 `semantic`。同时核对消息内容和来源引用。这里标识的是所选已记录投影，也包括可能已被替换或撤回的历史投影。要确认某次模型请求实际采用它，还需核对该请求的上下文；来源标签不是实时状态指示。绑定已连接或申请已批准本身不能确认模型已采用上下文。

对于已获有限自动许可的 Session，如果逐字选定摘要及其证据仍与针对同一本地目标成功完成的响应一致，无关更新可以被记录而不再消耗一次自动响应。下次普通请求仍会收到当前上下文。措辞或相关证据改变可能触发下一次响应；摘要调用仍有独立的费用和额度。

职责用于指导摘要，不是隐私 ACL。请求成功和精确来源引文不能证明模型正确理解了更正、失败或否定。这份配置不增加 embedding、latent 交流或互联网发现能力。

## 4. 停用摘要或处理额度耗尽

要停止摘要计算，重启所有者时移除 semantic overlay，并确认所选后端为 `reported-files`。如果该 Host 还接收另一位所有者的摘要，应保留期限 overlay。选择后端不会授予新权限；重启时终结采集、暂停自动工作的规则仍然适用。不要通过删除审计目录或修改稳定 Session ID 来重置额度。

累计额度耗尽时，先核对已有用量，再明确提高同一 semantic 配置的 `maxCalls`，保留原审计身份重启；也可以停用 semantic。审计保存在 `dshHomePath('scope-context-audit')`，Session ID 为 `scope-context-audit`；已失败或结果未知的预留调用仍可能消耗额度。普通 Agent 的自动工作额度另行计算。

## 开发备注

无。
