# Agent Note: Workbench 清理负责保留的进程范围

Status: implemented

[English](2026-10-29-workbench-managed-process-lifetimes.md) | 中文

## Problem

开发命令可能退出或失败，而其受管子进程仍在提供页面。按直接命令的阶段选择清理对象，会在停止、重启或卸载 workbench 时遗漏该子进程。超出 Node 支持范围的计时值还可能把配置延迟变成立即轮询或拒绝。

## Decision

[Host workbench](../../../../packages/host/dev-workbench/README.zh.md)在替换前保留各 subprocess 句柄。停止、重启和释放都会终止该句柄，并等待直接结果及受管范围退出。重启先等待旧范围完全停稳，再获取新句柄。就绪探测的取消先于终止完成。直接结果失败仍显示在任务状态中，不会跳过范围清理；范围结算失败仍会拒绝该操作。

[Subprocess 提供方决策](../architecture/2026-08-28-subprocess-native-containment.zh.md)独立负责范围成员及平台保证。Workbench 使用既有接口，不推断 PID，也不另建进程控制器。其就绪间隔、请求超时及终止宽限均为正整数，并受 Node 的 2,147,483,647 毫秒计时上限约束。警告阈值仅比较经过时间，仍允许整个正安全整数范围。

[浏览器面板](../../../../packages/client/ui-dev-workbench/README.zh.md)为已启动但退出或失败的任务同时提供“停止”和“重新启动”。它保留最后一次就绪结果；未就绪且没有错误时提示探测已停止。[清单决策](../simplification/2026-10-25-client-inventory-snapshot-store.zh.md)保有独立的连接代际及发布所有权。可见面板负责轮询及正在使用的缩放监听器；关闭、全部条目消失或卸载时释放它们，不持久化尚未完成的拖拽。

## Alternatives considered

**只清理运行中或停止中的命令。**直接退出不能证明其受管范围为空。按命令阶段筛选会遗弃存活子进程。

**增加子进程存活标志或另一轮询器。**保留的提供方句柄已经负责终止及范围结算。另一套观察无法增强其平台保证，却会增加需要协调的状态。

## Consequences

即使命令已经结算，显式停止、重启及卸载仍会等待提供方范围完全停稳。已启动任务结算后仍显示“停止”，因为浏览器无法从该阶段推断子进程已退出。提供方无法证明范围为空时，清理等待可能失败；不增加成功兜底。

真实子进程测试在仅卸载 workbench 时保留 subprocess 提供方，并验证子进程的 loopback 服务器停止。夹具在 Windows 上将子进程与 Node 的父进程关闭即终止 Job 分离，但保留 Harness 的外层 Job 成员关系；POSIX 子进程则保留提供方的进程组。独立停止及重启用例验证范围结算；挂载后的浏览器测试操作实际 Remote 控件，覆盖被替换 Host 的回复及探测已停止的文案。计时值拒绝测试覆盖三项实际调度延迟。
