# Agent Note: Worker 镜像保留页面包的归属

Status: implemented

[English](2026-10-03-worker-preview-package-ownership.md) | 中文

## Problem

预览打包器沿 workspace 依赖遍历，并把所有公开 workspace 导出作为扫描起点。静态浏览器库以 `lib/index.js` 发布裸浏览器导入，其依赖由页面构建拥有。把这些入口当作 Worker 模块会留下无法解析的导入。未激活的 Mesh provider 也会导入 UDP 发现 API，但浏览器 Worker 无法打开相应 socket。启动时禁用插件不能修复这两种打包归属错误。

## Decision

[打包器](../../../../packages/experimental/webworker-packer/README.zh.md) 接受显式的页面专用包集合。仓库适配层使用 Client 校验器既有的 `readStaticLinkedRoster` 函数读取该集合。实际发布的 `staticLinked` 构建预设仍是唯一分类依据；适配层不维护第二份包名单，也不根据目录名推断归属。构建后的仓库工具与 profile 合成一样，通过已安装的 tsx 环境运行这个源码读取函数。

页面专用包不进入 Worker 物化。若配置把它命名为 Worker 插件，或某个 Worker 模块真正导入它，打包会抛出明确指出该包的错误。这些库由页面的 Vite 构建提供。动态 `lib/client.js` 插件资产仍原样经过镜像与隧道传递。其他 workspace 导入继续受打包器的未解析请求拒绝规则约束。

[Worker runtime](../../../../packages/experimental/webworker-runtime/README.zh.md) 在 app-boot 挂载插件树前，显式禁用默认 development Mesh 传输及 Room/Task 通道。其 `node:dgram.createSocket` 入口报告 UDP 不可用，并在获取资源前抛错。这个窄兼容声明允许未激活的 provider 模块完成解析；它不实现网络，也不会把启用的发现服务伪装为成功。既有 scope TCP 和外部 Claude hook 条目仍被禁用。本机 MCP 客户端配置条目也被禁用：其原生可执行文件和外部配置路径没有 Worker 对应能力，启动不会伪造 Node 路径。

部署也禁用管理调用依赖这些 Node 服务的 `ui-emergence-center`。它禁用启动即打开数据库的 `storage-sqlite` provider，并且仅将已有的 `development_tasks: sqlite` 存储路由改为既有 JSON 后端；它不会创建缺失的存储条目或覆盖显式选择的其他后端。其他存储设置与路由保持不变，因此自定义 SQLite 路由仍不受支持。因此，Task 记录使用 Worker 的易失 VFS，Node Web profile 仍保留 SQLite 路由。这种显式组合避免调用缺失的管理 API 和尝试启动 SQLite，无需弱化 Remote 错误或实现替代 SQLite API。

## Alternatives considered

收集全部开发依赖会混淆浏览器构建输入与 Worker 运行时输入，并隐藏非法 Host 导入。把浏览器依赖移入 Node 安装依赖区，会为预览特有的缺陷改变包归属。第二份静态库名单会与构建预设漂移。静默丢弃未解析请求或返回空 UDP 模块，会推迟错误并可能错误呈现网络能力。

## Consequences

定向回归打包实际 store、UI primitives、Mesh 与默认 web profile 产物。它们拒绝直接挂载页面专用插件及 Host 导入，保留普通 Host 模块和动态 Client 资产，并验证 UDP 明确拒绝与嵌套部署补丁。最初三个回归在修复前失败。浏览器启动仍是单独必需的验收：镜像成功构造不等于预览页面可交互。

仓库适配层需要已安装的源码构建工具链，与其既有 profile 合成要求一致。使用通用打包器的自定义库必须提供自己的页面专用分类。Worker 仍不支持局域网发现、独立 scope peer 连接或外部 Claude 集成；这些能力需要 Node Host。已提交的 Session 代际与模型输入保持不变。
