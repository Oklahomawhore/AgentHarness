# Agent Note：项目级 Claude scope 接入

Status: implemented

[English](2026-10-03-claude-project-onboarding.md) | 中文

## 问题

[Claude scope 适配器](2026-10-02-claude-scope-adapter.zh.md) 需要手工组装 profile、hook 命令和本地管理请求。这些准备使普通用户必须理解传输机制才能连接现有会话。观察到一个会话也不能成为授权同目录全部会话的依据。

## 决策

Web bundle 在 macOS 和 Linux 上挂载适配器，通过生成的浏览器 Remote 提供已有会话操作。Windows 因描述符锁不受支持而禁用该 Host 行。浏览器 worker 也禁用它，因为该环境无法启动外部 Claude CLI 或提供所需的 Host 生命周期。Host 服务缺失时连接中心仍可用，并显示不可用，而非把它当作运行中会话列表为空。

连接中心配置一个明确选择的项目的 `.claude/settings.local.json`，查看已观察到的主会话，再将一个选定会话按其职责和采集目录加入当前 Task。通过该界面加入不授予 Bash 命令或 API 文件读取。配置、观察、成员身份和模型采用始终区分。刷新和重连使用当前 Host 的观察；目录相同不授予成员身份。

项目 setup 在同一 Harness home 下生成共用的仅启动时加载的 `dsh --profile` 组合。部署显式提供当前 Node 可执行文件、CLI 参数、工作目录、限制和 profile 名称；保留 profile 不能被占用。生成命令逐参数引用并设置相同 home，不查找 PATH、不通过包管理器执行、不嵌入凭证，也不新增应用入口。私有描述符继续承担既有认证机制。

Setup 读取有界的严格 JSON，并合并七组精确归属的 hook。无关 hook 条目、权限和其他 JSON 值在重新序列化后保留，但格式会改变。已修改或重复的自有组、符号链接配置、不兼容 profile 或本地禁用 hooks 均拒绝安装。检查不写文件。移除仅删除匹配的 hook 组，保留共用 profile；已有会话授权需要单独退出。

写入使用既有协作文件锁和原子替换工具。完整 profile 文件先于 settings 提交；只要全部既有文件匹配，重试可补齐缺失 profile 文件。Setup 在替换前重新检查 settings 字节，拒绝已观察到的外部编辑。这些操作不承诺跨文件事务、fsync 耐久性或与同用户恶意进程的隔离。崩溃可能遗留需要显式恢复的锁；setup 不抢占它。

Host 在释放期间跟踪 setup 操作。取消阻止后续写入，但已开始的原子替换仍可能完成；释放等待其结算。稳定的领域错误码让浏览器解释失败，而不显示配置内容。Setup 成功只证明文件落盘，不证明 Claude 信任、托管策略许可、真实 hook 执行或模型采用。

Task 绑定变更事件用 `null` 表示已清除的 assignment。JSON Remote 传输拒绝 `undefined` 事件参数，因此清除必须发布显式的空值，发起退出的请求才能报告成功。本地 assignment 查询和持久绑定事件保留原有表示。

## 考虑过的替代方案

**要求用户粘贴命令和 profile YAML。** 这让部署细节进入普通加入流程，并容易混淆源码启动、安装运行时和 Harness home。

**自动加入项目内全部已观察会话。** 观察不授予采集权限，同目录两个会话也可能承担不同职责或处理私人工作。

**覆盖既有 hook 配置或卸载时删除共用 profile。** 这可能丢失无关自动化，或破坏另一项目已安装的 hooks。精确归属允许限定删除范围并显式处理冲突。

## 后果

用户可以配置项目并选择会话，无需编写 profile YAML 或逐次发布工作变化。既有项目信任和托管设置仍由 Claude 管理。跨所有者授权、空闲唤醒、真实模型行为和代表性安装试用仍是[产品提案](../../proposed/architecture/2026-10-02-scope-context-backends.zh.md)中的要求。

验证区分文件系统 setup、经认证的管理、生成命令执行和浏览器交互。受控 hook 输入证明采集与投影行为，不宣称真实 Claude 模型产生或采用了这些输入。
