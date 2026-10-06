# Agent Note：独立的当前写入预期

Status: implemented

[English](2026-10-06-separate-current-writer-oracles.md) | 中文

## 问题

后端改为写入不同的身份或证据字段后，已记录的 provider 响应仍可能是有效回放输入。替换已提交的 Session 会破坏该输入；把当前格式日志声明为保留旧格式则会错误描述迁移覆盖。

## 决策

[快照 manifest](../../../../packages/test-support/session-snapshot/README.zh.md)允许拥有输入的 SDK 场景选择独立的当前写入预期。原规范 Session 仍作为回放输入，实际原生输出与完整归一化写入预期比较，协议通知另有当前预期。TypeScript 与 Python 使用同一声明。历史格式保留使用独立声明，并维持原有语料限制。

该机制适用于当前生产身份与记录输入不同的 facts 和 semantic 后端场景。新增输出预期来自实际无密钥执行，并保留身份差异供审阅。不伪造 provider 身份、不抹除比较字段，也不为行为变化虚增 Session 格式版本。

## 考虑过的替代方案

**重写规范 Session 输入。** 这会丢失已提交证据，并混淆模型回放与当前写入行为。

**把当前输入标为旧格式，或归一化后端身份。** 前者破坏迁移计数，后者隐藏待验证行为。

## 影响

解析器拒绝借用 Session、历史格式声明及非 SDK profile 与此写入选择并用。Record 与 refresh 保持规范输入不变。审阅需检查独立写入和通知预期，以及所保留输入的哈希。
