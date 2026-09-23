# Agent Note：AgentHarness 候选版源码基线

Status: implemented

[English](2026-09-23-agentharness-rc2-fork-baseline.md) | 中文

## 问题

AgentHarness 需要可复现的 DeepSeek Harness 基线，同时不能导入其提交历史，也不能丢失 AgentHarness 的 Task、Mesh、Web 与发行能力。只零散移植上游修复，会使后续开发的源码基点不清晰。

## 决定

AgentHarness 源码树以已发布的 DeepSeek Harness `dsh-v0.1.5-rc.2` 标签、提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203` 为起点。AgentHarness 模块和发行文件叠加到该源码快照，保存在公开仓库的独立历史中。[UPSTREAM.zh.md](../../../../UPSTREAM.zh.md)记录固定版本与更新流程。上游 CLI 保留原包名；AgentHarness 便携运行时的依赖闭包包含额外的协作包与 MCP bridge。

源码别名与生成的服务目录纳入 AgentHarness 包。MCP 客户端保留候选版的富内容处理，同时将已连接的 generation 提供给可信 Host Consumer。便携浏览器验收检查候选版当前的工作区入口。

## 考虑过的替代方案

**合并上游 Git 历史。** 这会破坏新公开仓库的干净历史边界。

**长期沿用旧源码。** 开源分叉开始前，运行时与 MCP 行为就会落后于上游。

## 结果

后续上游更新需要将新发布标签与此精确提交比较，并重新检查 AgentHarness 的包组合。构建、协作与 MCP 的针对性测试、打包测试和本机便携启动检查覆盖组装后的发行版；文档生成器与双语记录随源码快照更新。
