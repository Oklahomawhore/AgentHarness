# Agent Note: AgentHarness release 分支与版本 tag

Status: implemented

[English](2026-09-23-agentharness-tag-release-flow.md) | 中文

## Problem

每次推送 `main` 都发版，会让包括纯文档在内的每次合并承担发布成本，并使 Actions 运行号成为公开版本号。按日定时发布则可能在候选版本尚未准备好时执行。

## Decision

[单 main 开发决策](2026-09-26-agentharness-single-main-development.zh.md)替代本文的 `develop` 与日期 release 分支集成策略。本文继续负责 tag 触发发布和 npm 授权。仅推送稳定语义版本 tag 时启动新版本发布。首个任务从 tag 取得版本号，并拒绝格式错误的 tag、与 tag 事件提交不符的 checkout，以及尚未进入 `main` 的提交。原有五平台构建、产物准备、GitHub Release 与可选 npm 任务保持原有顺序；手动运行用于修复现有 Release 附件，不发布新版本。

npm 任务使用具有 `id-token: write` 权限的 GitHub Actions OIDC。npm 只信任本仓库的 `agentharness-release.yml` 直接发布 `@sandboxbreak/agentharness`；任务不接收长期 npm token。它核验校验值后发布与 GitHub Release 完全相同的 tarball；版本已存在时，只有 registry 完整性与这些字节一致才通过。

## Alternatives considered

**每次合入 `main` 都发布。** 文档和运营改动也会产生版本，Actions 运行号还会决定公开版本号。

**推送 release 分支即发布。** 可移动的分支不能确定准确产物版本，每次稳定性修复都会重复构建。

**每日定时发布。** 固定时间无法判断候选版本是否通过审查；维护者决定经过验证的候选版本何时就绪。

**在 Actions 中保留长期 npm 发布 token。** 可重复使用的 secret 会持续拥有直接发布权限，而且依赖 npm 计划限制的 Bypass 2FA token。OIDC 将发布权限绑定到指定仓库工作流。

## Consequences

维护者在审查后选择版本号并明确推送一次 tag。功能或文档 PR 不运行 AgentHarness 发布矩阵。tag 校验只能证明源码已进入 `main`，不能证明审查或候选版本验证已经完成，这些仍由维护者负责。`scripts/agentharness-release.test.mjs` 覆盖合法与不合法的 tag 格式及提交祖先关系。

仓库写入权限和 tag 保护决定谁能发起发布；npm Trusted Publisher 不能代替所选提交的审查。npm 任务可以重试，无需重新构建便携产物。
