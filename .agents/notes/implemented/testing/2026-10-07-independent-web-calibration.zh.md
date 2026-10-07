# Agent Note: 独立 Web 校准

Status: implemented

[English](2026-10-07-independent-web-calibration.md) | 中文

## Problem

共享协调器或进程内 Web scaffold 可以代为提供新用户必须自行建立的工作目录、Task 绑定和工具提供方。这些测试通过，不能证明独立启动的 Agent 保留自己的工作，并通过获准 scope 获取对端事实。

## Decision

[每端准备器](../../../../scripts/scope-evaluation/two-device-prepare.ts)为正式 Web profile 创建一个角色的独立受控程序和覆盖配置。[浏览器用例](../../../../apps/web/tests/two-device-profile.e2e.ts)启动两个真实 `dsh` 进程，通过已有 UI 选择工作区、创建本地 Task、连接已有 Session、允许文件采集、申请加入并批准共享读取。生产沙箱文件工具执行各自写入。协调器推进普通回合并检查结果，不预填 Task、不代理文件访问，也不把对端事实插入提示词。

每端生成自己的不可预测业务标记。在获准发布前，只有生成端的程序包含该标记。B 加入前的私有写入、共享写入和退出后写入区分既有本地工作与获准的后续贡献。真实请求检查证明自动上下文供给，同时保持自动工作关闭。固定工具程序不能证明语义推理或协作收益。

[观察插件](../../../../scripts/scope-evaluation/two-device-observer.mjs)在 LLM waterfall 捕获完整普通模型请求，通过 `next` 委派，并核对内存及磁盘严格恢复的事件前缀。完整 messages、tools 和已记录请求配置必须一致。它不添加 Session 事件、不调用 scope 管理 API。每端拥有自己的观察目录和有限证据上限。最终成功要求完整预期请求及已结束回合；中间前缀通过明确不是最终结果。观察插件等待其拥有的文件系统工作并记录收尾预算超限。进程所有者执行独立的硬终止期限，强制终止不能通过。

[操作说明](../../../../scripts/scope-evaluation/two-device/README.zh.md)明确已构建仓库依赖、隔离的发现目录、browse 选择器覆盖和回环传输限制。本机双进程校准与物理双设备验收属于不同结果。自报主机名或两个私有目录都不能证明物理隔离。

## Alternatives considered

**复用协调器的远程文件工具。** 这保留了共同的执行所有者，并绕过每人的生产文件权限机制，不能验证独立文件系统工作。

**通过夹具 API 预填 Task 或权限。** 这会跳过正在验收的首次使用路径，可能隐藏加入或工作区步骤的问题。观察插件保持只读，变更使用可见产品操作。

**把固定回复当作模型采用事实。** 固定回复无需理解上下文也可成功。测试要求真实请求中出现精确的对端证据，并保持真实模型实验次数为零。

## Consequences

校准检测请求不足或超额、持久证据分歧、文件工具失败，以及本地 Task 或原 Session 丢失。它增加证据持久化开销，不测量未插桩延迟。它需要开发用回放依赖，不是仅含生产包的安装流程。物理设备可达性、真实用户上手成本、模型推理质量及语义通信 backend 仍需独立证据。

## Verification

[准备器测试](../../../../scripts/scope-evaluation/two-device-prepare.spec.ts)覆盖独立程序和拒绝覆盖。[观察插件测试](../../../../scripts/scope-evaluation/two-device-observer.spec.ts)运行真实 Agent 循环和 JSONL 持久化，覆盖请求数量失败、字节上限、磁盘篡改、调用方拥有的活跃回合销毁及独立目录。[浏览器用例](../../../../apps/web/tests/two-device-profile.e2e.ts)检查原生文件的双向流转、排除私有历史、工具与 Session 前缀保留、退出后本地工作、响应式 UI 证据以及子进程完整终止。
