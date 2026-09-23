# `@agentharness/evidence-repository`

[English](README.md) | 中文

这是一个可选 AgentHarness bundle，用于把只读 Git worktree 注册到 DeepSeek Harness 的通用 `ctx.developmentEvidence` 注册表。它在插件加载时解析仓库根目录，把每条自然语言查询分割成数量有界的固定字符串词项，通过受管 subprocess 能力搜索已跟踪文本和可选的未忽略未跟踪文本，并返回排序后的行引用。检索不会改变房间或 Session，当前房间阶段也不组合此适配器。

使用 `dsh plugin --profile web add ./agentharness/packages/evidence-repository` 安装本地 checkout。把 `AGENTHARNESS_REPOSITORY_EVIDENCE_ROOT` 设置为目标仓库，并按需设置 `AGENTHARNESS_REPOSITORY_ID`，然后启动 `web` profile。根目录变量缺失时，bundle 保持禁用。配置目录不在 Git worktree 内时，插件加载会失败。

## 配置

`cordis.patch.yml` 明确列出所有字段：提供方身份与标签、Git 可执行文件、仓库根目录与稳定身份、pathspec、未跟踪文件与大小写匹配策略、查询词项与单文件匹配上限、收集输出与摘要上限，以及进程终止宽限。注册之前，`git rev-parse --show-toplevel` 会把配置的子目录解析为 worktree 根目录。搜索使用固定字符串，绝不调用 shell。

每条结果保留 `git://worktree/<repository>/<path>#L<line>` 定位符，以及根据仓库身份、路径、行号和命中内容计算的 SHA-256 revision。定位符不会暴露部署的绝对路径。安装此可选适配器的 profile 必须提供 `developmentEvidence` 和 `subprocess`。

## 模型体验

### 请求上下文与触发条件

#### 模型会看到什么

仓库引用不会直接进入模型请求。提供方只把 Host 侧行匹配返回给未来的显式 Consumer。

#### Token 影响

仓库检索不会增加 prompt token。

#### KV Cache 影响

仓库检索不会创建或改变 KV-cache 条目。

## 已知限制与后续工作

- 检索是词法行搜索，不是语义代码搜索。排序按命中查询词项数计算，并以路径和行号作确定性并列排序。
- 忽略文件始终排除。启用未跟踪搜索时只包含未被忽略的文件，并可能向查询操作人员展示草稿内容；部署必须把根目录和 pathspec 限制到该操作人员可以接收的资料。
- 引用 revision 对命中行计算指纹，不代表完整文件或 commit。后续仓库解析器可以附加 commit 与 worktree 状态，并在所属代码界面中打开定位符。
- 本提供方只读。diff 评审、测试执行和已验收产物发布仍属于独立插件与审批路径。
- 本包仍使用父 checkout 的开发工具链；迁出与独立 CI/发布自动化尚未完成。
