# 为共享 Task 上下文启用模型摘要

[English](collaboration-semantic.md) | 中文

希望本 Host 按各接收者职责整理获准工作报告时，可以选择模型摘要。Web profile 默认使用**报告（不调用摘要模型）**，通过 [`/reported`](../../../packages/collaboration/development-task-context/README.zh.md#behavior) 交付有界报告，并在不调用摘要模型的情况下重建满足条件的文件报告组。选择普通聊天模型不会启用摘要。

## 1. 选择摘要模型

在提供上下文的 Host 上，通过**模型**配置可用路由。打开**设置 → 插件 → 协作摘要**，在**上下文提供方式**中选择**模型摘要**，再选择**摘要模型**。这个经过身份验证的管理页控制 Host 配置，不限于某个 Task 的所有者。该选择作用于本 Host 的上下文后端，不是只影响某一份邀请。

检查**摘要累计调用上限**，再选择**保存**。Web 默认允许累计预留100次调用，同时最多执行两次。每次计算允许20秒，输入和输出也有明确限制。这些限额不是金额上限。打开、编辑和保存卡片都不会调用摘要模型，保存也不改变运行中的后端。

所选提供方会使用已配置凭据接收获准来源文本，并可能收取调用费用。卡片不显示或存储凭据。普通 Agent 各自保留所选模型，也可能产生独立费用。目录列出模型不代表凭据或账户额度一定可用；计算需要的路由不可用时会失败，不会改用报告交付或旧摘要。

## 2. 重启同一 Host

手动重启 Host，保留原 Harness home 和 Task 存储。保存的选择在启动时生效；仅启动 Host 不会调用摘要模型。后续获准的上下文计算可以使用所选模型。已有 Session 保留普通模型。重启后检查采集和自动工作状态：恢复读取不会授权新采集，自动工作仍需明确恢复。

交付的 Web profile 允许 scope 读取等待30秒、传输请求等待35秒，容纳默认20秒的摘要计算。双方都需要兼容的期限；自定义或较旧的接收部署可能在所有者完成前超时。双方 native 都使用当前 Web 默认配置时，无需另加期限 overlay。更改后端配置不会创建读取授权、采集许可或自动工作许可；仍使用[协作加入流程](collaboration-network.zh.md)。

### 已安装的 Claude Code hooks

[期限 overlay](../../../apps/cli/config/examples/scope-context/deadlines.cordis.yml)提供45秒的 hook 请求超时及独立命令 profile `claude-hook-summaries`。保存摘要设置不会更新已安装的 Claude hooks。在受支持的 macOS 或 Linux Host 上，先暂停 Claude 工作，再对每个已配置的项目按以下顺序操作；无需选择 Task：

1. 保持原 Host 配置运行，打开**打开涌现协作中心 → Claude Code**，输入原**项目路径**，选择**检查配置**。显示**项目 hooks 已配置**后，选择**移除项目 hooks**。
2. 使用检查过的期限 overlay 副本重启该 Host，保留同一 home 和已保存的摘要设置。在 Claude Code 区域填写项目路径，选择**配置 hooks**。
3. 在该项目打开或重启 Claude Code，发送下一条消息，再选择**刷新会话**。Claude 决定何时加载变更后的 hooks；配置成功不证明正在运行的 Claude 会话已收到上下文。

移除 hooks 会保留命令 profile 和已有会话授权。要结束共享或接收，请使用相应停止或退出操作。如果安装与已有 hooks 冲突，先在原 Host 配置下移除匹配的 hooks，不要覆盖项目里的其他设置。恢复旧 hook 配置时，也需先移除再重新配置。

### 部署 overlay

CLI 在 `config/examples/scope-context/` 发布[语义](../../../apps/cli/config/examples/scope-context/semantic.cordis.yml)和期限示例。语义示例为已有 configured 后端设置部署默认值；已保存的 `scope-context` 偏好优先生效。它不会增加第二个后端或审计 group。请检查被完整替换的配置，并选择自己已安装的路由，不要把 API key 写入 overlay。启动器的 patch 选项应放在应用选项之前，后续启动也需保留 patch。从已构建的仓库中，Claude Host 可以使用：

```sh
node apps/cli/lib/bin.js --profile web --patch "/absolute/path/to/deadlines.cordis.yml" --no-open
```

调整自定义部署时，只保留一个上下文后端，并保留原审计目录与 Session ID。设置插件不会发现或迁移任意已有审计日志。配置预览不调用推理，也不能证明凭据可用；已保存的偏好不证明当前已挂载的后端。

## 3. 核对已记录的上下文

获准工作发生且接收端 native Session 发出下一次请求后，打开**当前会话协作 → 查看来源**。在轨迹中选择 `scope-agent-context` 消息并打开**来源**，展开 `projection` 和 `backend`：`id` 标识该次已记录投递使用的 provider，模型摘要显示为 `semantic`。同时核对内容和来源引用。这里展示的是已记录投影，也包括可能已被替换或撤回的历史投影。要确认某次模型请求采用了它，还需核对该请求的上下文；申请已批准或绑定已连接本身不能证明采用。

对于已获有限自动许可的 Session，选定摘要与证据不变时，可以跳过针对同一本地目标的另一次自动响应。下次普通请求仍会收到当前上下文。措辞或相关证据改变可能触发下一次响应，摘要调用仍有独立费用和额度。已记录的完成轮次不证明工作正确。

职责用于指导相关性，不是隐私访问权限。投递成功和精确来源引文不能证明模型正确理解了更正、失败或否定。此设置不增加 embedding、latent 交流或互联网发现能力。

## 4. 停用摘要或调整额度

选择**报告（不调用摘要模型）**，保存并手动重启 Host，即可停止摘要计算。接收其他 Host 的摘要时，仍需保留兼容的 hook 期限。停用后重新启用、更换模型路由和重启都会保留 `dshHomePath('scope-context-audit')` 下的累计预留，Session ID 为 `scope-context-audit`。不要通过删除目录或修改稳定 ID 来重置额度。

额度耗尽时，先核对已有用量，再明确提高**摘要累计调用上限**并重启，或停用摘要。已失败或结果未知的预留调用仍计入保留的额度。普通 Agent 的自动工作额度另行计算。

## 开发备注

无。
