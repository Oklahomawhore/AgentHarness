# 混合工作与独立产物

[English](README.md) | 中文

## 概述

本参考定义 `payment-mixed-work-v1`：在 8,000 字节受管上下文上限下，独立校准不共享（`N`）、完整操作报告（`reported`）及按接收者整理摘要（`semantic`）。它保留各自接收 Session 与本地 Task，检查实际输入和独立评分的 JSON 产物。受控回复证明测量机制，不证明模型质量或协作收益。

## 目录

- [相同工作机会](#equal-work-opportunities)
- [独立评分](#independent-grading)
- [执行与证据](#execution-and-evidence)
- [限制](#limits)
- [开发说明](#dev-note)

<a id="equal-work-opportunities"></a>
## 相同工作机会

每个接收者在共享更新前先进行普通本地工作，保留原 Session、Task 与公开项目文件。来源通过实际 Write、Bash 和 Edit 操作工作；同一命令先成功，之后失败。另一所有者写入并替换无关文档。全部混合工作回执完成后，两个接收者才得到相同的中性工作机会。中间没有请求提前提供纠正，也不删除任何历史。

[实验定义](../mixed-study.ts)使用同一组由 seed 生成的字段名，派生来源策略、初始项目与隐藏评分输入。每个条件采用相同来源轨迹、项目输入和完整上下文上限。条件选择通信方式，不决定产物内容。旧[单轮实验](../data-study/README.zh.md)的 E 仍为原始文本；[连续性实验](../continuity-study/README.zh.md)保留其独立 E/R 协议。

<a id="independent-grading"></a>
## 独立评分

客户端维护支付策略 JSON；QA 维护可独立执行的数据用例。既有[产物评分器](../data-artifacts.ts)使用父进程持有的参考，核对完整请求轨迹与必需的行为变体。两个接收者都看不到隐藏输入或参考产物。

每个角色还写入一份验证观察。其评分区分对已有证据的准确描述与取得最新来源结果。没有获准进入请求的命令结果时，`unavailable` 是准确描述，但不算取得当前证据或完成全部工作。命令失败描述的是那次报告的执行，不证明当前磁盘或部署持续无效。缺失、格式错误、校验不符或陈旧产物仍明确记为失败。

<a id="execution-and-evidence"></a>
## 执行与证据

使用已安装依赖和受支持的 Node 运行时，在仓库根目录执行：

```sh
pnpm exec vitest run scripts/scope-evaluation/mixed-study.spec.ts packages/collaboration/scope-agent-contribution/tests/mixed-artifacts.spec.ts --maxWorkers=1
```

[所属校准](../../../packages/collaboration/scope-agent-contribution/tests/mixed-artifacts.spec.ts)使用四个独立 Loader 组合与进程内传输。普通受控回复只从实际进入请求的消息及公开项目数据生成产物，不接收条件名或评分参考。来源工具、采集、投影、接收上下文、文件写入与 Session 持久化均使用真实实现。检查保留完整模型消息重建、原历史与 Task 身份、完整上下文外框、来源回执、产物封存及等待完成的资源清理。

将 `DSH_MIXED_ARTIFACTS` 设为已存在的私有输出目录，可为每个条件保留一份排他创建的 JSON 结果。不会替换已有结果。没有该设置时，所属 Host 完成清理后删除临时证据。不需要凭据文件或外部模型。

<a id="limits"></a>
## 限制

受控摘要有意识别注册的策略报告。摘要路径的产物通过，不代表真实模型能够选出这些报告、理解纠正或完成有用工作。协议分别记录机制、产物有效性及当前证据可用性。单测拒绝陈旧策略与命令结果；默认 reported 后端保留其实际省略，不为此夹具改变选择。

本校准不是经命名 profile 启动的真实模型执行器、物理设备测试或自主响应延迟测量。真实对照仍需要独立获准的模型账户、固定累计调用、相同工作机会与不可访问的评分数据。不能用既有真实模型协议的不同输入或预算替代此对照。

<a id="dev-note"></a>
## 开发说明

[混合工作产物校准](../../../.agents/notes/implemented/testing/2026-10-08-mixed-context-artifact-calibration.zh.md)记录可见证据、完成产物与模型收益的区分。
