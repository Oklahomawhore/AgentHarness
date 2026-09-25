# Agent Note: AgentHarness 单 main 开发

Status: implemented

[English](2026-09-26-agentharness-single-main-development.md) | 中文

## Problem

长期 `develop` 分支与仅用于发布的 `main` 为贡献者提供了两个集成目标，并要求维护 release 分支及回合并。AgentHarness 已经通过 tag 和可下载产物标识发行版本，在第二条开发线上重复表达这一状态会增加同步工作。[分支模型讨论](https://chatgpt.com/share/6ab6aa75-121c-83ee-8d9e-e5e1c25c95a5)区分了开发主干、发行版本和旧版本维护。

## Decision

`main` 是唯一长期开发分支，也是短期主题分支 Pull Request 的默认目标。审查和相关检查通过后才能合并。存在依赖的 PR（Pull Request）可以临时以父主题分支为目标，最底层 PR 以 `main` 为目标；现有堆叠流程继续管理这些依赖。并行协作者使用各自的分支和 worktree。未完成的工作保留在 `main` 之外，除非它已构成可独立使用的增量。

发布时选择可从 `main` 到达、经过审查和验证的准确提交，并发布不可移动的稳定版本 tag。开发继续推进时，候选 SHA 保持固定。稳定性修复和紧急修复通过同一 PR 流程进入 `main`；需要包含修复时，重新选择并验证候选版本。合并不会发版，发布也不需要日期 release 分支或回合并。已发布 tag 和产物标识安装版本。

本决策仅替代 [tag 发布决策](2026-09-23-agentharness-tag-release-flow.zh.md)中的集成分支部分；后者继续负责发布校验、npm OIDC、产物完整性和重试。[贡献者工作流](../../../../docs/development.zh.md#agentharness-branch-workflow)负责具体步骤。现有上游 CI 触发条件保留配置的范围；不新增由分支触发的发布矩阵。

## Alternatives considered

**保留 `develop`、日期 release 分支和仅用于发布的 `main`。** 这能分离功能集成与稳定性修复，但也需要两条长期历史和回合并。对于当前仅维护一条开发线的项目，选择经过验证的提交即可固定发布版本，无需承担这些协调成本。

**每次合入 `main` 都发布。** 改动达到可集成状态，并不意味着需要发布可安装版本。显式 tag 让维护者决定版本号和发布时间。

**通过 `release/*` 维护旧版本。** 同时支持多个版本时，独立维护分支和选择性 backport 有实际价值。AgentHarness 当前没有这一承诺，发布校验也仅接受可从 `main` 到达的提交；支持维护版本发布需要另行制定策略并修改校验。

## Consequences

贡献者只有一个集成目标，维护者则可以在主干继续前进后发布经过验证的较早 `main` 提交。项目放弃独立的稳定性修复线，因此保持 `main` 可用及审慎选择候选版本由维护者负责。本策略不引入功能开关或产物晋级服务。

发布校验强制检查祖先关系和 checkout 身份，不验证审查质量或分支保护。[agentharness-release.test.mjs](../../../../scripts/agentharness-release.test.mjs)中的现有测试覆盖合法 tag，以及被拒绝的身份和祖先关系；文档检查覆盖双语配对和链接。仓库设置与已有远端分支的退役是独立于本文工作流的操作。
