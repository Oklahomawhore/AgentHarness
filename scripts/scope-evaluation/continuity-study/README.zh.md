# 原有 Session 的策略连续采用

[English](README.md) | 中文

## 概述

本文定义 `payment-policy-continuity-v1`，它独立于[单波次 JSON 研究](../data-study/README.zh.md)。来源依次报告初始策略、更正策略并结束贡献时，一个接收 agent（智能体）保留同一个活跃 Session 和读取权限。试验检查连续的当前工作产物，不与未绑定的对照组比较协作收益。

## 目录

- [阶段与权限](#phases-and-permission)
- [当前工作与历史](#current-work-and-history)
- [注册与限制](#registration-and-limits)
- [证据](#evidence)
- [开发备注](#dev-note)

<a id="phases-and-permission"></a>
## 阶段与权限

三个独立的具名 `dsh` Host 分别拥有来源 A、scope 所有者 O 和接收者 B。A 使用真实的原生文件工具及贡献采集。B 使用普通 HTTP 提供方和受限的数据工具。它的初始目标描述持续任务及当前来源支持这一前置条件，不含未来更正值。所有者在 E 中提供原始报告，在 R 中提供面向接收职责的语义投影。

B 仅绑定一次，显式设置自动目标和有限额度。来源写入初始策略后，在更正前等待 B 的自动轮次完成并封存产物。父进程随后准入成功更正及失败编辑，再允许 B 的下一个自然 pre-step 继续。最后，A 结束贡献，B 保留有效的读取订阅。由此形成的终结发布触发第三个自动轮次。父进程不添加中途用户消息、新目标、替代 Session 或重新绑定。

私有来源屏障和 pre-step 屏障固定试验的交错时序。它们只等待，不改变模型消息或选择产物内容。请求仍经过生产授权和投影。因此结果不能证明未经协调的延迟，也不能代表任意并发来源变化下的行为。R 可能在完整更正阶段到达前汇总中间修订；这些尝试计入其不变的总预算。

来源贡献终结撤回当前支持，但不撤销 B 的读取授权。撤销读取授权是另一条生命周期路径：Host 必须停止自动工作，不能仅为写入阻塞产物而启动另一个模型轮次。本研究不运行该分支，也不运行同时接收的 B/C。

<a id="current-work-and-history"></a>
## 当前工作与历史

[公开项目与判分器](../continuity-study.ts) 在策略旁使用一个小型当前工作决策。ready 决策内嵌完整策略，必须与独立封存的策略文件一致。父进程根据私有参考输入执行二者，并拒绝未采用更正或来自失败编辑的重试值。公开诊断保留初始基线，绝不公开私有评分。支付请求均为解释器内的请求轨迹，不调用支付服务。

blocked 决策表示当前依据不可用。贡献撤回后，父进程要求该决策及与上一封存阶段完全一致的策略字节，并且不发起新的支付请求。即使策略曾经正确，ready 决策也会失败。在有来源支持的阶段，始终 blocked 的决策会失败。历史策略文件和早期 Session 事件仍可证明以前的工作；撤回不要求擦除它们、把旧策略改回去，或让模型忘记历史消息。

每个阶段保留两份产物的原始字节及哈希。无效 JSON、ready 策略不一致、行为错误和运行时失败分别记录。自动轮次完成不代表产物正确；产物评分失败本身不会停止剩余阶段。

<a id="registration-and-limits"></a>
## 注册与限制

使用受支持的 Node 运行时及已构建的公开包。显式路由配置与单波次研究相同。用独立协议准备新目录：

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts prepare --run /tmp/payment-continuity --seed 20261004 --config /absolute/study-config.json --execution live --protocol continuity
pnpm exec tsx scripts/scope-evaluation/data-cli.ts preflight --run /tmp/payment-continuity
```

准备和预检不读取模型凭据、不启动 Host。它们固定协议身份、E/R 条件、项目、判分依据、源码和构建入口指纹以及 Node 身份。既有阶段不能重复运行。已注册输入变化后，必须使用新目录重新注册。

只有明确选择账户和模型后才执行：

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts execute --run /tmp/payment-continuity
```

每个 E/R Session 有三个自动激活，每轮至多四个模型步骤，三个轮次共用一个 `ordinary.maxCalls` 额度。十二次普通调用允许达到注册步骤上限；更少调用是显式选择的较小额度，不能因此重置计数。`semantic.maxCalls` 覆盖整个 R 所有者，包括中间计算。总预留上限为 `2 × ordinary.maxCalls + semantic.maxCalls`。等待、模型操作和清理都有注册的有限期限。未知用量会阻止后续派发。不存在自动重试或货币支出硬上限。

<a id="evidence"></a>
## 证据

[运行器](../native-data-run.ts) 在每个接收阶段前封存来源结果及持久化的所有者回执。阶段记录保留原始绑定和 Session 身份、订阅状态、实际请求区间、所有者修订、已完成的自动证据、可重建的 JSONL 前缀及独立产物评分。早期检查点单独保留。强制终止 Host 会使执行失效；取消会保留已完成阶段及可用的部分证据。

可选的 [HTTP 校准](../native-continuity-run.spec.ts) 要求 `DSH_NATIVE_DATA_EVALUATION=1` 和已构建的公开依赖。服务端返回受控产物，因此检查通过只证明传输、调度和判分行为。[纯判分测试](../continuity-study.spec.ts) 拒绝缺少支持的 ready 决策，区分合法保留的历史与新使用。[注册测试](../data-cli.spec.ts) 要求 `DSH_NATIVE_EVALUATION=1`，验证派发前的静态拒绝。

没有独立证据时，本协议不能证明真实模型准确率、成本节省、双人接入或跨设备可靠性。E/R 是摘要成本可能不同的机制试验，不是随机化质量比较。[决策记录](../../../.agents/notes/implemented/testing/2026-10-04-scope-data-artifact-study.zh.md) 说明当前使用与保留历史的区分。

## 开发备注

无。
