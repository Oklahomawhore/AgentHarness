# Agent Note：完整 vendor 家族替代闲置的 payload 选择

Status: implemented

[English](2026-10-26-complete-vendor-release-family.md) | 中文

## Problem

vendor bump 已经推进每个可发布成员，但闲置的路径分类器及其测试仍描述选择性发布。该分类器没有生产调用方。家族发现还接受完全由私有 manifest 组成的集合，使 vendor bump 可能在没有任何发布计划时报告成功。

## Decision

[家族 bump](../../../../scripts/release/bump.ts) 保留完整家族推进，各包继续使用独立版本和 tag。每个选定成员都保留在计划中，即使其文件与已打 tag 的提交相同。稳定版本 bump 从 manifest 或已打 tag 的基线推进；已打 tag 的预发布版本可保留版本数字，并使用显式提供的预发布标识符。目录差异不能证明另一个仓库状态的发布字节身份；发布器单独对照 registry 检查 tarball integrity。bump 规划既不查询 registry，也不能证明 tag 所指版本已发布。

移除闲置的 payload 分类器、常量和只测试该实现的用例。[家族发现](../../../../scripts/release/families.ts) 在过滤私有 manifest 后拒绝空的可发布集合。不存在匹配项与全部为私有项的情况由同一处诊断负责；验证器使用该已解析集合，不再重复过滤私有项；bump 不再需要空计划成功分支。

[独立 npm 家族决策](../process/2026-08-10-npm-release-sequences.zh.md) 继续拥有其他版本、payload 和发布规则。本决策只取代其中按 vendor payload 选择成员的策略。AgentHarness portable 发布与原生包发布仍是独立操作。

## Alternatives considered

**只选择 payload 改变的成员。** 这可以避免为未变包预留新版本，也是原选择性发布的动机。完整家族规划则将每个成员的版本纳入发布决策，不会默默保留未变成员的版本，也无需第二个分类器判断哪些文件能改变打包字节。包级独立版本线仍保留上游沿革。

**为未来选择保留闲置分类器。** 测试会维持一个没有发布命令消费的替代实现。若要恢复选择性发布，须增加实际调用方并证明打包字节身份。

**将全部私有的家族视为没有变化。** 此时没有可发布成员，成功的空输出掩盖了配置问题，不能描述一次发布。

## Consequences

完整发布族规划可能为 payload 未变的成员预留版本。Git tag 仍只是版本预留元数据；registry 认证、产物验证和实际发布是独立要求。无密钥的真实 CLI 排练使用文件未变且已有 tag 的成员，观察两者版本都推进，并验证 dry run 不改 manifest 或 tag。基于真实文件的测试拒绝全部私有的集合。
