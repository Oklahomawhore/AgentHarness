# Agent Note: 移除没有消费方的开发证据检索

Status: implemented

[English](2026-10-26-remove-unconsumed-development-evidence.md) | 中文

## Problem

Task 与 scope 产品没有开发证据 registry 的查询消费方。reviewed-file provider 与独立 `agentharness/` workspace 中的 repository、Volcengine TLS 和 Viking Knowledge 适配器注册提供方，但生产代码从不查询它们，也没有出厂 profile 挂载它们。适配器还提供明确的手动安装路径。能力图没有列出查询消费方。初始 Room 证据决策描述了当前源码中已不存在的简报创建 API 和 Team Room 界面。

## Decision

workspace 移除 `development-evidence`、其四个提供方，以及它们的包导出、编译引用、provider-change 事件、生成的发现与文档条目。空的可选适配器 workspace 的包、锁、兼容性、编译和测试配置一并移除；文档入口保留历史计划并链接当前产品。静态 Cordis 检查描述可用的编程接口，不会挂载缺失的 provider，也不构成检索消费方。注册行为与提供方自身的查询测试不能证明存在查询消费方。

这次移除完成了初始证据流程的退役，并将其决策依据整合至此；[原始引用简报记录](../../archived/architecture/2026-08-20-development-room-initial-evidence.md)完整保存在冻结归档中。当前 [Task 上下文 backend](../../../../packages/collaboration/development-task-context/src/backend.ts)计算接收者上下文，[Scope 准入](../../../../packages/collaboration/scope-agent-context/src/index.ts)检查接收权限；两者都不是证据检索或初始引用简报创建的等价替代。未来的向量通信本身不要求调用方驱动的查询 registry。

### Original purpose and reintroduction requirements

初始证据将人明确选中的引用原子地保存在 Room 第 1 次修订中。先建 Room 再追加引用会暴露未完成初始化，并允许引用之间发生持久化失败。受信任 Host 在一次持久提交前验证完整工作图、验收清单、在线作者、当前操作者、事实数量、引用边界及 provider／条目／修订归属。普通浏览器创建不能自行提供受信任的归属信息。同一受信任选择策略也适用于工作开始后发现的引用。

短期选择只属于一个已认证的参与者。手动与规划创建使用同一路径；完整创建成功后才消费互不重复的选择，失败、未选结果和拒绝的检索不会产生 Room 或 Session 事实。检索可以使明确编辑过的参与者 profile 上线，但后续模型准入仍要求明确选择工作与事实。恢复此能力的部署需要这些授权与原子性属性、真实 Loader 与产品测试，以及证明检索本身对模型不可见的无密钥组装请求录制。选中的引用需要确切的 provider、条目、修订、摘要、来源与作者归属；其他参与者不能消费它们。

被移除的 registry 与提供方不保存查询历史、Session 事件格式或迁移。reviewed-file 版本标识外部只读资料库，不是 Session generation。已有资料库、已提交的 Session 与 recorded-origin 文件、归档记录及已发布 tag 保持不变。历史文本不是可执行兼容解析器，缺失检查区分二者。

退役适配器提供有界的 reviewed-file 与 Git worktree 引用、带签名的只读 TLS 日志搜索，以及 Viking Knowledge CLI 集合查询。每次云端查询都会解析凭据引用，来源定位符与修订保留归属。这些可选 Host API（包括手动插件安装）被舍弃。重新引入时需要真实查询消费方，以及这些只读、凭据、有界输出与归属属性；接收者上下文计算仍是独立职责。

## Alternatives considered

**为未来企业检索消费方保留 registry。** 有界引用与 available、empty、denied、failed 的分离仍是有价值的设计要求。未来用途可以恢复完整能力，并同时提供真实消费方、profile 接线、读取授权、取消所有权和已记录的准入。潜在复用本身不足以支持现在继续维护闲置 registry 与 provider。

**将检索接入自动 scope 交换。** 来源查询与接收者上下文计算承担不同职责。为这些包增加手动选择或 recall 会改变产品的协作流程，而不是满足当前消费方。

**修补闲置查询 helper 的取消逻辑。** 这会保留没有消费方的 API、发布和测试负担。当前源码没有需要该 helper 完成的产品请求。

**在普通创建后追加引用。** 读取者可能观察到部分初始化，持久化失败也可能把选中的简报拆进多个修订。恢复初始简报能力仍要求一次完整提交。

**直接接受浏览器提供的归属事实。** provider、条目和修订身份必须来自受信任的检索，而不是调用方给出的 JSON。恢复功能不会放宽这一要求。

**将所有检索结果注入模型请求。** 检索不是同意。只有被接受且已记录的上下文才能进入模型请求；未选和失败结果保持临时状态。

## Consequences

这些尚未稳定的包及其发现条目从下一次 workspace 发布中移除。使用手动安装适配器的自定义 Host 会失去可选检索 API，可能需要修改；源码审查不能证明这些包从未被发布或使用。已发布产物与 tag 保持不可变。没有当前产品检索流程替代被移除的包，恢复初始引用简报仍是独立的功能决策。

当前源码扫描、workspace 与生成目录检查验证没有可执行消费方和残留声明。[Cordis 检查的 owner](../../../../packages/extensions/tool-cordis/tests/api-catalog.spec.ts)拒绝已退役服务，[手工编写的无密钥 Session 场景](../../../../snapshots/session/cordis-retired-evidence-service/snapshot.yml)通过真实检查 Tool，并在随后的模型请求中观察 unknown-service 结果。保留的 Task／scope 与插件生命周期测试各自验证自己的行为；这次移除不能证明真实模型采用或人工沟通减少。
