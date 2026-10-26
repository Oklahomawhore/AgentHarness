# Agent Note: CI fixture 的完成与隔离

Status: implemented

[English](2026-09-08-ci-completion-observations.md) | 中文

## 问题

[参考 CI 运行](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34206953049)报告：轮询一秒后 webhook 创建的 Session 仍不存在，五秒读取期限内 PowerShell 输出为空。HTTP 接受、UI 投影状态、进程启动和持久化完成是不同的观察。测试需要明确的完成条件，并用对照阻止中间状态满足该条件。[完成等待决策](2026-09-08-ci-readiness-and-completion.zh.md)拥有这些条件与 lane 预算；这些 fixture 通过受控延迟使顺序与清理可观察。

## 决策

[GitHub 评审浏览器测试](../../../../apps/web/tests/github-ready-review.e2e.ts)在 HTTP 202 后阻塞真实 Workspace 创建，验证 Agent 和模型请求均不存在，再释放创建并等待对应 Session 的 `turn/end`。即使测试超时，清理也会释放屏障、恢复方法并移除事件监听器。Workspace 归属、请求数量、提示词内容和浏览器预期保留原有断言。

[PowerShell 执行器测试](../../../../packages/shell/pwsh-local/tests/executor.spec.ts)用私有文件屏障控制启动与消费式读取。测试决定后续输出何时可用；最终 stdin／环境变量输出在 `done` 后读取。轮询使用当前测试预算，每个创建的 Context 都在插件初始化前登记。清理在等待释放前同时取得 Context 与目录，完成释放后才删除目录。

[排队图片测试](../../../../apps/web/tests/queue-image.e2e.ts)分别阻塞接纳和附件读取，再捕获已接纳行中加载完成的缩略图。清理共享一个 Promise，释放保留的请求，并在关闭浏览器前等待其 handler 完成。

[详情 Session 生命周期测试](../../../../apps/web/tests/details-session-lifecycle.e2e.ts)在关闭状态出现后等待框架已捕获的动画 Promise，再检查轨道宽度为零。取消的过渡同样进入该断言；动画结束不能让持续非零的轨道通过。

[整队列 steering 测试](../../../../apps/web/tests/steering.e2e.ts)等待 steering 操作可用以及 composer 显示队列 steering 提示。模型流屏障在测试观察 steering 时阻止后续问题 composer 接管。清理在关闭浏览器前释放该屏障。

[Workspace 管理测试](../../../../apps/web/tests/workspace-management.e2e.ts)在下一次目录对话框操作前等待恢复后的 composer 焦点。归档用例通过 Session controller 为已知 seed id 设置显式用户标题，再用该精确标题跨重载定位行。无关的恢复行无法匹配该定位器；持久化归档断言仍检查 seed id 和保留的日志。

[Worker 预算测试](../../../../packages/code-runtime/code-runtime-worker-thread/tests/budget.spec.ts)保留真实 worker 执行与绑定传输，只控制 Host 定时器和 ELU 样本。测试先确认绑定已进入，再检验 idle、active 和壁钟决策，使启动超时不能冒充绑定期间的预算决策。[真实 worker 测试](../../../../packages/code-runtime/code-runtime-worker-thread/tests/runtime.spec.ts)独立保留实际 ELU、空闲绑定和热循环覆盖。

[分离启动测试](../../../../packages/host/open-in-app/tests/launch-detached.spec.ts)控制观察时间，并通过真实 launcher 登记的回调发送迟到进程事件。测试检查仅完成一次、仅 unref 一次且不终止子进程。[Resolver 测试](../../../../packages/host/open-in-app/tests/resolver.spec.ts)保留真实进程的环境变量和提前退出用例。

[LSP 背压测试](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts)保留真实暂停读取的 fixture 与大型原生管道写入。接受 abort 错误前，测试验证待处理写入回调已完成、捕获的子进程也已结束；`instance.dead` 在释放开始时就可能为真。

[复合原生工作](../../../../snapshots/sdk/scope-native-work/README.zh.md)和[混合来源](../../../../snapshots/sdk/scope-mixed-source/README.zh.md) SDK 夹具在后续来源请求或独立来源发布前等待所有者回执。Agent 空闲不表示远端报告已被应用。独立的当前 writer 预期保留不可变的重放输入，并完整比较 publication、grant、来源身份和省略信息；Python 拥有对应的回执顺序输出。

[Headless 默认参数夹具](../../../../apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts)使用 provider 配置的空闲默认值，并在收到真实标题请求后才结束。它检查 SSE 注释、确切默认参数、两次 HTTP 请求及没有重试。[Adapter 时钟测试](../../../../packages/llm/llm-deepseek/tests/adapter.spec.ts)单独证明注释会重置空闲期限；其 fetch mock 将中止传播给 reader，并清理计时器与监听器。 测试只模拟负责心跳与请求期限的 `setTimeout` 和 `clearTimeout`；零计时器断言不统计无关的调度 API。

[Semantic Web observer](../../../../apps/cli/tests/profiles/web/fixtures/scope-semantic-observer.mjs)通过同目录独占临时写入与原子 rename 发布就绪状态。读取端只等待文件不存在，损坏的 JSON 仍立即失败。

命令超时与开发预览夹具仅在失败时报告正在等待的清理阶段，以及直接命令和受管范围的结束状态。命令句柄保留实际使用的原生或 fallback 模式供诊断。观测代码转发原始 Promise，并在清理后恢复。[Outbox 恢复夹具](../../../../packages/collaboration/scope-agent-contribution/tests/recovery.spec.ts)在真实失败后阻挡后续写入，原子恢复原始字节及权限，再释放写入方并等待 Host 释放完成。

[原生工作夹具](../../../../packages/collaboration/scope-agent-contribution/tests/native-work.spec.ts)将每次投递尝试与四份不可变封存报告和四个持久回执比较。受控的确认丢失保留回执身份，同时允许新的 request id。命令超时失败在 worker 退出前捕获属于当前 worker 的具名 scope 的有界 systemctl 属性，不输出启动环境或命令参数。

[完整门禁 CLI 夹具](../../../../scripts/run-gates.spec.ts)仅在失败时报告有界子进程输出、实际私有调用记录和最后一个已有阶段标记。入口环境诊断只含同名键及其与夹具值是否相等的布尔结果，不含环境值。子进程环境将 `npm_execpath` 的所有大小写变体替换为夹具入口。[Node 在 Windows 上不区分环境键的大小写](https://nodejs.org/docs/latest-v24.x/api/child_process.html)，因此保留继承的全大写别名可能会启动真实包管理器。夹具在每个平台都加入该别名，并要求最终只保留一个选定键。原有断言和子进程时限保持不变。

[网络偏好卡片](../../../../packages/client/ui-settings-plugins/src/client/ScopeNetworkCard.tsx)只接受受支持的预设选项。Host 刷新将选项替换为自定义值后，较早[排队的 select 通知](https://html.spec.whatwg.org/multipage/form-elements.html#send-select-update-notifications)仍可能到达；接受该值会产生隐藏草稿，并在下一次修订时误报冲突。Host 修订与观察者销毁仍是独立检查。

[MCP 连接夹具](../../../../packages/mcp/mcp-client/tests/reconnect.spec.ts)要求提供方的实际依赖声明和 Host 路由。短暂的工具注册不能证明激活成功。SDK 关闭通知与连接释放是不同的观察；关闭仍待通知时发生的释放，既不能发布新路由，也不能启动下一代连接。

### 已构建 Client 的导入分类

[Node import sweep](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts)通过普通 Node 启动只含可擦除语法的 TypeScript 驱动，使传递导入使用已构建的包导出。tsx hook 会将这些导入重定向到源码，并可能创建第二份原生模块实例，不能充当构建产物导入的判定器。不使用该 hook 时 Koffi 可以导入，不再有豁免。检查只有在 Node 针对 Client 包已构建 `lib/` 目录中现存的普通样式表文件报告 `ERR_UNKNOWN_FILE_EXTENSION` 时，才接受列表中的三个 Client bundle。首先失败的样式表可以来自传递依赖，因此不能用导入顺序选定一个固定资源路径。源码路径、不存在的文件、其他错误以及意外成功的豁免导入都会失败。各隔离夹具持有自己的仓库目录结构和资源；限定范围的 resolve/load hook 只替换选中的 bundle，不修改共享构建产物。

## 考虑过的替代方案

**生产超时、重试或套件串行化。** 拒绝，因为均不能建立缺少的完成观察。

**从接受或预览推断完成。** HTTP 202 和乐观图片可能早于被断言的操作。

**用受控样本替换实测 worker 覆盖。** 拒绝，因为会遗漏对 Node 实际 ELU 与传输行为的验证。

## 影响

每个 fixture 拥有自己的时钟、屏障、回调、进程和临时路径。受控观察补充真实 worker、子进程、浏览器和持久化路径。产品行为、生产时序、基准预算和 CI 调度均保持不变。录制输出保留完整比较。
