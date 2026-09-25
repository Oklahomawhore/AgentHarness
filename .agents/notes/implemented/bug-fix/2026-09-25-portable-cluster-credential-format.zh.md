# Agent Note: 便携集群凭据在提供方启动后保持不变

Status: implemented

[English](2026-09-25-portable-cluster-credential-format.md) | 中文

## Problem

便携集群辅助脚本与凭据提供方共享一份文档。若脚本只识别扁平顶层键，提供方将文档迁移为包含 `refs` 和 `records` 的 `version: 1` 格式后，脚本就会丢失集群。再次启动或安装会追加提供方拒绝加载的顶层密钥，而笼统的就绪错误会掩盖进程失败。

## Decision

[集群辅助脚本](../../../../scripts/agentharness-cluster.mjs)读取带版本号的引用，也识别旧版扁平字符串映射。新写入使用版本 1，通过 YAML 文档 API 编辑集群引用，保留其他引用、记录和注释。集群选择与替换持有提供方使用的文件锁，并通过其原子写入工具提交。并发首次启动复用先提交的密钥，修改已有集群必须显式要求替换。

格式错误的文档、不支持的版本，以及混入顶层凭据的带版本号文档，都会在写入前失败。持有写入锁时，提供方的解析器会校验完整的渲染后文档，包括无关引用和记录；校验通过后才会持久化或报告重复加入成功。密钥冲突时需要运维人员选择目标引用。这保留了[公网发行凭据分离](../architecture/2026-08-28-public-portable-release-credential-separation.zh.md)的规则，以及[凭据记录](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)定义的布局。

[已安装管理命令](../../../../scripts/agentharness-portable-command.mjs)区分子进程退出与就绪超时，并附带本次启动的有限长度输出。保存的日志偏移量排除先前运行，浏览器 URL token 会被脱敏。超时清理使用具有进程归属检查的进程组停止路径。

## Alternatives considered

延长超时无法加载无效凭据。删除文档会丢失其他认证信息。自动选择冲突密钥可能加入错误的集群。正则编辑无法可靠区分嵌套 YAML 条目、注释和流式映射。

## Consequences

便携产物包含 YAML 解析器、凭据提供方与原子写入工具。发行 staging 不加载已安装的包，凭据操作按需加载依赖。staging 回归测试在未安装依赖的检出目录中运行。测试结合真实辅助脚本与提供方，覆盖迁移、重启、重复加入、替换和无效的无关条目。命令预期输出固定本次失败诊断，不含旧输出或浏览器 token。发行浏览器 smoke 连续启动安装产物两次，并验证凭据逐字节不变；只测全新安装无法发现该缺陷。
