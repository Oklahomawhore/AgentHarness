---
description: "面向人的浏览器面板，用于配置好的 dev-workbench Host 服务(../../host/dev-workbench/README.zh.md)"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-dev-workbench

[English](README.md) | 中文

## 概述

面向人的浏览器面板，用于配置好的 [`dev-workbench` Host 服务](../../host/dev-workbench/README.zh.md)。该插件通过原生 `sidebar.footer.action` slot 贡献一个底部操作，并在 Host 未报告任何条目时隐藏。打开的面板通过 portal 挂到 document body，位于布局缩放手柄之上，不会增加覆盖条、分割条或第二层侧边栏外壳。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

打开该操作后，会显示一个不透明面板，其中包含任务选择、生命周期控制、保留的 stdout／stderr，以及沙箱 iframe 中选中的 HTTP(S) 视图。同一任务附带的多个视图共享一个进程，因此在 chat 与 local-debug 路由之间切换不会启动重复服务器。Host 配置就绪策略时，预览会在 `checking` 或 `delayed` 阶段等待，只在 `ready` 后挂载 iframe；在新窗口打开的链接始终可用。刷新操作会重新读取 Host 状态，并刷新已挂载的 iframe。

面板默认最大为 1100 × 760 像素，尺寸受视口约束；其右边缘保持固定，左下角手柄同时调整宽度与高度。面板尺寸、选中的任务以及各任务选中的视图经过校验后持久化到浏览器本地存储；配置条目仍由 Host 管理。狭窄或低矮的视口会切换为带少量边距的近全屏布局，纵向排列预览与日志，并隐藏缩放手柄。面板打开期间，清单每秒轮询一次；启动与停止结果通过包自有 observable 立即发布。

<a id="model-experience"></a>

## 模型体验

无，因为该包展示由人操作的本地开发状态，不注册任何模型接口。

#### KV Cache 影响

无；浏览器清单与 iframe 状态不影响提供方请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

- **仅使用显式就绪配置**——未配置就绪策略的条目仍会立即挂载所选 iframe；浏览器不会根据进程状态推断可用性。
- **轮询而非推送**——打开的面板每秒采样一次 Host 状态，因此已结算进程的显示最多可能延迟一个间隔。
- **iframe 策略取决于目标站点**——目标可能通过响应头拒绝嵌入；仍可使用“新窗口打开”操作。
- **没有终端输入**——日志只读；交互式命令属于终端会话，而不是此面板。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
