# Agent Note: AgentHarness release 分支与版本 tag

Status: implemented

[English](2026-09-23-agentharness-tag-release-flow.md) | 中文

## Problem

每次推送 `main` 都发版，会让包括纯文档在内的每次合并承担发布成本，并使 Actions 运行号成为公开版本号。贡献者也没有与发布线分离的集成分支。按日定时发布则可能在候选版本尚未准备好时执行。

## Decision

贡献者提交到 `develop`。发布负责人在候选版本就绪时切出带日期的 `release/*` 分支，在该分支接收稳定性修复，通过合并提交将其合入 `main`，再对该准确提交推送稳定语义版本 tag。发布工作流只监听 tag 推送。首个任务从 tag 取得版本号，并拒绝格式错误的 tag、与 tag 事件提交不符的 checkout，以及尚未进入 `main` 的提交。原有五平台构建、产物准备、GitHub Release 与可选 npm 任务保持原有顺序。发布后将 `main` 合回 `develop`。

## Alternatives considered

**每次合入 `main` 都发布。** 文档和运营改动也会产生版本，Actions 运行号还会决定公开版本号。

**推送 release 分支即发布。** 可移动的分支不能确定准确产物版本，每次稳定性修复都会重复构建。

**每日定时发布。** 固定时间无法判断候选版本是否通过审查；日期分支可提供按天推进的节奏，而不自动发布。

## Consequences

维护者在审查后选择版本号并明确推送一次 tag。功能或文档 PR 不运行 AgentHarness 发布矩阵。tag 校验只能证明源码已进入 `main`，无法证明它来自特定名称的 release 分支，因此 release 分支审查仍由维护者执行。`scripts/agentharness-release.test.mjs` 覆盖合法与不合法的 tag 格式及提交祖先关系。
