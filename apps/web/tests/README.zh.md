# apps/web 浏览器 e2e

[English](README.md) | 中文

依赖 scaffold 的测试在进程内启动真实的 web 组合，并用真实 Chromium 通过真实 HTTP 驱动它。该 lane 的运行机制——模式、fixture、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在 [`scaffold.ts`](scaffold.ts) 和 [浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)中。

[独立 Web 校准](../../../scripts/scope-evaluation/two-device/README.zh.md)则启动两个正式 `dsh` 进程，通过产品 UI 完成 Task 设置、加入和文件工作。它使用独立持久化和只读证据，不通过 scaffold 预填状态。本机结果不能证明两台物理设备。

## 完成状态观察

依赖状态的用例使用 Workspace、接纳、附件和模型流屏障，区分可见中间状态与已完成操作。详情关闭等待框架过渡结束；归档验证为 seed Session 设置显式标题，并跨重载跟踪该身份。参见 [CI fixture 同步决策](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.zh.md)。

原生所有者贡献用例使用独立 Web Host 和真实 Write 工具。保留本地职责的联合加入用例明确选择加入前观察，向所有者展示这项许可，检查来源的投递覆盖，并在后续实时 Write 前捕获包含已有记录的所有者请求。随后验证实时更新和退出，不替换原本地 Task 或采集。独立 SDK 初始化场景覆盖第三个 Host 默认未选择历史分享的情况。 独立接收预算用例在没有既有本地采集时被动加入，验证不变的 8,000 字节组合额度在扣除实际开销后，仍容纳完整事实并明确记录遗漏。它用捕获的上下文核对接收面板展示的已记录共享字节与省略数量，并检查退出后摘要消失；文案不声称请求已发送或模型已理解。地址恢复用例在所有者真实离线和恢复后检查被动模式标题与历史读取问题，不增加模型请求。

工作区建议验收复用现有原生加入和完整文件用例：本机 Host 填写可编辑目录、工具和部署额度，但不授予权限。远端用例缩小草稿范围后明确申请，经批准执行真实 Write；本地用例使用配置额度，明确同意 Edit 和全文后，检查接收方请求及撤回。两者使用受控模型回复与本机两个 Host。

Claude 联合场景使用一个所有者、一个已有原生 Session 和一个已观察的外部 Claude 会话，各有独立 Host。两位参与者使用同一多人入口；来源页面关闭后，所有者审批仍可完成接入。原生 Write 进入受控 Claude Hook 输出，受控 Claude 完成观察进入实际原生模型请求。停止 Claude 贡献保留其读取；退出联合协作会结束原权限，原生成员仍可继续。Hook 输出证明上下文已准备，不证明外部 Claude 模型已经消费。该场景不使用付费模型或物理第二设备。

原生命令场景使用本机两个 Web Host、受控模型回复和真实前台 Bash 执行。来源先明确选择命令与目录，再由所有者批准；文件许可本身不能分享命令结果。实际接收请求区分最新失败与较早成功，并排除未选择的命令。停止贡献保留读取，退出保留原 Task、文件采集和工具。每份捕获的请求都从持久 Session 事件重建；这不证明物理设备连接或模型判断能力。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取 Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动 浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 cordis `Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处 Host 服务访问都无法编译。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程 拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的 Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译， 于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的 import 点明源模块。这样漂移会表现为选择器未命中或镜像值过期——是响亮的失败，绝不会是静默 通过。`scaffold.ts` 按此规则镜像欢迎声明的 namespace、确认字段、版本和被断言的中文文案。

有一类 Client import 是长期成立的。`assembled-boot.ts` 驱动 shell 本身，因此它从 `@deepseek-ai/dsh-client-web` import `AppWebEntry`、从 `@deepseek-ai/dsh-client-modules/client` import boot manifest 类型：启动真实 shell 正是该 harness 的用途，且这两个包本来就在 Host 图中。chat 场景则在 `support.ts` 中镜像 `conversationContextKey`，而不 import 其 Client owner。

没有任何机制强制这条规则；靠 review 守住它。
