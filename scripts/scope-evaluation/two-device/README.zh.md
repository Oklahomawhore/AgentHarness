# 每端独立的 Web 校准

[English](README.md) | 中文

## 概述

本文定义独立 Web 端的受控 scope 协作准备流程。每端使用正式 `dsh --profile web`、已有 standard Agent 预设、生产文件工具和独立工作区。本机浏览器检查在同一机器启动两个进程，不能证明物理设备隔离或模型推理质量。

## 目录

- [准备与启动](#prepare-and-launch)
- [受控交互](#controlled-interaction)
- [证据与限制](#evidence-and-limits)
- [合验两端导出](#verify-exports)
- [本机浏览器检查](#local-browser-check)
- [开发说明](#dev-note)

<a id="prepare-and-launch"></a>
## 准备与启动

使用已构建、已安装开发依赖的仓库和 Node 24。回放适配器属于测试依赖；此流程不代表最小生产安装。从仓库根目录执行准备命令，输出目录必须不存在。B 端独立准备时同时修改输出目录和角色参数；不要将 A 的清单或响应文件复制给 B。

```sh
pnpm exec tsx scripts/scope-evaluation/two-device-prepare.ts --output /tmp/scope-device-a --role A
```

命令创建 `device.json`、无密钥覆盖配置、本地响应程序、空工作区和独立 Harness 目录。它不启动应用、不写业务文件、不调用模型。清单记录本角色的本地文件正文、普通继续提示词和预期请求次数，不包含对端生成的业务标记。准备中途失败时保留新目录供排查；修复问题后选择新目录。

从准备好的工作区使用干净环境启动。以下 POSIX 示例假定 `/absolute/checkout` 是已构建仓库，且 `PATH` 中有 Node：

```sh
cd /tmp/scope-device-a/workspace
env -i PATH="$PATH" DSH_HOME=/tmp/scope-device-a/home DSH_AGENTS_HOME=/tmp/scope-device-a/agents DSH_BUNDLED_SKILL_DIR=/tmp/scope-device-a/skills node /absolute/checkout/apps/cli/lib/bin.js --profile web --patch /tmp/scope-device-a/device.cordis.yml --host 127.0.0.1 --port 0 --no-open
```

打印的启动 URL 用于本地浏览器认证，应保持私密。Web 管理与 scope 传输使用不同监听。scope 默认监听回环地址，仅适用于本机校准。物理端需在启动时通过 `AGENTHARNESS_SCOPE_LISTEN` 提供明确可达的 LAN 或 VPN scope 地址，并将其显式写入 `env -i` 命令，因为该命令会丢弃继承的变量；见 [Web bundle 的传输配置](../../../packages/bundle/web-app/README.zh.md)。Host 重启需使用新证据目录并重新校准；观察插件不会覆盖已有目录。

覆盖配置禁用真实模型提供方、标题生成、遥测和宿主应用设置，并为浏览器自动化固定使用已有的 browse 目录选择器。清单中的三个环境变量也隔离 standard 预设内部的技能发现。文件访问仍使用生产沙箱和普通权限机制。观察插件增加同步证据持久化开销；其耗时不是未插桩的网络延迟。

<a id="controlled-interaction"></a>
## 受控交互

分别在独立浏览器上下文打开两端，选择各自已有的 `workspace`，提交各自的 `stages.ready.prompt`。A 返回就绪回复；B 先完成私有本地文件工作。保存各人的协作身份，分别创建本地 Task，将当前 Session 连接到自己的 Task。仅 A 开启本地文件采集，限定到 `workspace/project` 和 write 工具。两端均不勾选自动工作。

A 创建一个联合加入入口。B 验证入口，允许自身 `workspace/project` 的文件写入贡献和共享读取，并申请加入。A 批准读取与贡献。这些均为真实 UI 授权；观察插件不授予权限、不修改 Task。B 保留原本地 Task 和 Session。

按以下顺序使用清单提示词继续：A `publish`、B `receive`、B `publish`、A `receive`。每轮等待回合完成和所有者界面的发布可见，再让对端继续。业务正文仅由各端的受控 write 程序生成；继续提示词不携带共享事实。随后 B 退出联合读取关系。提交 A `afterLeave` 并等待发布，再提交 B `afterLeave`。B 继续本地工作，但不再接收 A 的新共享事实。退出会结束此次加入的本地读取订阅和贡献；所有者签发的读取授权仍可能有效。

完整程序在 A 执行六次真实请求，在 B 执行七次，每端四个普通回合；A 完成两次原生写入，B 完成三次。A 的初始共享文件必须进入 B 的真实受管输入；B 的共享文件必须进入 A。B 加入前的私有文件不得进入 A 的共享输入。B 退出后的输入须撤回远端上下文并保留自己的 Task。固定回复不能证明模型理解或使用了这些事实。

<a id="evidence-and-limits"></a>
## 证据与限制

[观察插件](../two-device-observer.mjs)只观察普通循环请求和 Session 持久化，写入 `evidence/requests.jsonl` 和原子替换的 `evidence/verification.json`。每条请求包含实际 messages、tools、请求配置、Session 身份、事件数量、精确前缀摘要及受管上下文字节数。验证严格恢复本端磁盘未压缩 JSONL，核对捕获前缀，重建完整 messages、tools 和已记录请求配置。它不添加 Session 事件、不独立读取 scope 上下文、不代理文件工作，也不取消 Agent。

中途的 `passed` 仅表示已观察且已结束的前缀可以重建；只有 `final: true`、`status: passed`、次数精确符合预期且无失败，才证明观察程序完整消费。通过正常 `dsh` 终止流程停止，并等待进程退出。观察插件限制单请求、Session 和总证据字节数，拒绝额外请求。收尾预算超限会标记失败，但不能取消文件系统 I/O；浏览器辅助函数另行拥有进程清理硬期限，并将强制终止视为失败。未完成或发生分歧的证据不能算成功。

设置 `DSH_TWO_DEVICE_ARTIFACTS` 时，本机浏览器结果保留真实 Session 文件、私有生成程序、截图、进程退出和 `calibration.json`。认证 URL 和本地描述文件中的凭据不得随结果材料分享。仅凭设备清单和两个不同 peer ID 不能证明两台物理机器。第二设备身份、网络可达性和端到端执行仍需单独验收。此受控路径不产生付费模型调用，不能衡量协作收益、语义摘要质量或成本节省。

<a id="verify-exports"></a>
## 合验两端导出

[浏览器进程辅助程序](../../../apps/web/tests/two-device-profile-support.ts)观察每个子进程的实际退出后，记录 `process-exit.json`。上面的手工启动命令不会生成该记录；除非进程监督程序同时记录实际退出，否则其导出对本合验工具仍不完整。不要手填成功退出记录。本机浏览器检查提供完整受支持的导出路径。

两端停止后，分别导出到独立目录，仅包含 `device.json`、`process-exit.json`、`evidence/requests.jsonl`、`evidence/verification.json`、`sessions` 树，以及 `workspace` 下清单列出的业务文件。保留原相对路径，不复制私有 home、传输凭据、生成的响应程序或启动日志。合验工具只读取显式指定的导出目录；记录中的绝对路径用于标识原运行，不构成文件读取许可。

```sh
pnpm exec tsx scripts/scope-evaluation/two-device-verify.ts --a /tmp/scope-export-a --b /tmp/scope-export-b
```

此离线命令输出 JSON 报告，证据不完整或不一致时失败。它独立恢复两端 Session 日志，重建每条记录请求，将接收发布与对端已完成的文件工具及导出文件字节核对。它还检查私有历史排除、加入与退出权限、本地身份及工具保留，以及退出后的工作。观察程序的 `passed` 字段和 `calibration.json` 均不提供这些证明。合验工具读取有限且静止的导出，拒绝符号链接和越界路径，不启动应用、不调用模型。

报告证明所提供记录相互一致，不认证其来源。所有者的后续发布可能在最后一次捕获请求之后才获准入：`derivedOwnerAfterPublicationId` 仍是推导标识，只有捕获投影提供精确准入证据时，`ownerAfterAdmissionVerified` 才为 true。浏览器另行等待所有者界面出现该发布。独立端的时钟不能证明跨设备工作的先后；浏览器用例另行等待 A 发布完成，再让退出后的 B 继续。正常退出记录不能证明进程当前不存在；该观察由启动进程的调用方负责。记录的加入计划及后续本地投影证明保留的 Task 身份，浏览器用例另行观察加入前的身份。报告设置 `localBaseline: "join-plan"`、`preJoinUiAssignmentVerified: false` 和 `crossDeviceAfterLeaveOrderVerified: false`。即使两份导出路径或 peer 身份不同，`physicalDevicesVerified` 也保持为 `false`。

<a id="local-browser-check"></a>
## 本机浏览器检查

构建仓库并安装 Playwright Chromium 后执行针对性浏览器用例。可用 `DSH_TWO_DEVICE_ARTIFACTS` 指定保留结果的父目录，程序会在其中分配新目录；未设置时清理会删除结果目录。检查使用公开 Web 操作和只读请求证据，不通过进程内 scaffold 初始化或私有接口预填 Task。

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/two-device-profile.e2e.ts
```

[离线合验检查](../two-device-verify.spec.ts)拒绝被修改的请求、执行证据和导出。浏览器用例在两个子进程退出后运行同一合验工具。[准备器检查](../two-device-prepare.spec.ts)覆盖各角色私有程序与拒绝覆盖。[观察插件检查](../two-device-observer.spec.ts)覆盖请求重建、少跑和超额请求、字节上限、持久化分歧、独立目录，以及调用方回合仍活跃时的销毁。[决策记录](../../../.agents/notes/implemented/testing/2026-10-07-independent-web-calibration.zh.md)说明此证据为何与物理设备和模型实验分开。

<a id="dev-note"></a>
## 开发说明

无。
