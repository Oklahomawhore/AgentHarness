# Agent Note：AgentHarness 的 scoped npm 启动包

Status: implemented

[English](2026-09-24-agentharness-scoped-bootstrap.md) | 中文

## 问题

公开启动包与 vendored DeepSeek Harness workspace 包是不同的 npm 包。无 scope 的 `agentharness` 名称要求拥有 npm 全局名称；GitHub 仓库所有权不会自动带来该名称的发布权限。发版工作流还假定 npm 生成的 tarball 名为 `agentharness-<version>.tgz`，改为 scoped 包后这个假定不再成立。

## 决策

启动包使用 `@sandboxbreak/agentharness`。可执行命令仍为 `agentharness`，安装后的便携运行时不依赖 npm scope。发版工作流继续使用 `agentharness-npm.tgz` 作为稳定的 GitHub 资产名，暂存时读取 npm 实际生成的文件名。查重和发布均使用完整 scoped 包名。根 README、用户指南、生成包的 README 与 CLI 帮助展示 scoped npx 命令。

npm 账号 `sandboxbreak` 拥有同名的 `@sandboxbreak` 用户 scope。GitHub 仓库所有权不会授予 npm scope。稳定版本 tag 为这个包名生成新产物。已发布的 Release 资产保持不变，不会改名冒充新包。

## 考虑过的替代方案

**保留无 scope 名称。** 仓库并不拥有该 npm 全局名称，GitHub 命名空间也不能证明对它的所有权。

**使用 `@agentharness/agentharness` 或 `@oklahomawhore/agentharness`。** 这两个名称都不对应发布账号，需要单独创建 npm 组织并配置发布权限。账号自带的用户 scope 保留了可执行命令与产品名称，也省去这一步。

## 结果

npm 发布后，用户运行 `npx --yes @sandboxbreak/agentharness`。发布账号或 Trusted Publisher 必须拥有这个包的权限。打包测试核对生成的包名与命令入口；发版暂存不再依赖 scoped tarball 的文件名。
