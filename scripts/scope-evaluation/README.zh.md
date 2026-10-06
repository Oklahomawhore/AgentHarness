# Scope 协作评测

[English](README.md) | 中文

## 摘要

本参考说明 scope 协作的受控产物检查与原生 Session 校准。独立的[普通 Agent JSON 试验](data-study/README.zh.md) 接受自主生成的不可执行产物，并提供显式模型执行入口。受控检查不衡量产品收益。

独立的[原有 Session 协议](continuity-study/README.zh.md) 检查一个持续接收者在初始工作、更正和贡献撤回之间的自动采用。

独立的[每端 Web 校准](two-device/README.zh.md)使用各自的正式 Web 进程、普通文件工具及只读真实请求证据。

## 目录

- [离线验证](#offline-verification)
- [原生 Session 校准](#native-session-calibration)
- [Docker 执行](#docker-execution)
- [证据与限制](#evidence-and-limits)
- [真实研究要求](#live-study-requirements)
- [开发备注](#dev-note)

<a id="offline-verification"></a>
## 离线验证

使用仓库已安装的依赖和支持的 Node 运行时。输出目录必须不存在；命令拒绝替换既有结果。在仓库根目录执行：

```sh
pnpm exec tsx scripts/scope-evaluation/run.ts --output /tmp/scope-evaluation-offline --seed 20261003
```

输出包含冻结清单、案例字节、检查器源码和各案例结果。命令成功表示受控正确实现通过，已知错误变体失败。清单始终记录零次模型试验、缺失的模型用量和费用，以及没有真实研究注册。执行后再次检查源码摘要；变化会使结果无效。

案例覆盖必填字段改名、有 body 时字段必填的可选 body、来源冲突、连续更正与语义不变的授权更新，以及来源撤回。前端检查器观察实际执行的请求。QA 检查器要求正确实现通过、每个指定错误变体因断言失败；无效测试和执行失败不能算成功识别变体。

<a id="native-session-calibration"></a>
## 原生 Session 校准

使用 Node 24，以及当前 checkout 已构建的公开包和 native addon。这个显式启用的检查通过共享启动器运行四个命名 `dsh` profile，使用私有 home 与独立 peer 身份。在仓库根目录执行：

```sh
DSH_NATIVE_EVALUATION=1 node node_modules/vitest/vitest.mjs run scripts/scope-evaluation/native-run.spec.ts --maxWorkers=1
```

该检查覆盖 F1 的无共享（`N`）、接收者定制事实（`R`），以及共同工具返回屏障处的取消。普通来源写入经过已安装的贡献 hooks。协调器核对来源收据与 owner 持久事件之后，才同时放行两个接收者。在 `R` 中，下一次实际请求必须包含已捕获的 owner revision；`N` 不接收 scope 快照。每个接收者实际调用读取、写入和公开项目测试工具。QA 公开测试针对初始实现执行，可能报告断言失败；这类反馈与最终隐藏判分不同。

[Runner](native-run.ts)保留实际请求、工具结果、原始 JSONL Session、来源／owner 收据证据与产物摘要。保存的 Session 字节经严格恢复后，必须能从各请求对应的事件前缀重建实际请求。取消会停在被阻塞的工具返回处，不产生下一次请求或产物结果；四个 Host 都必须无需强制终止而结束。原生检查验证被动的下一步骤投递，不产生自动 pulse。

[原生 CLI](native-cli.ts)依次接受 `--output` 指定新结果目录、`--seed` 指定案例种子、`--docker-config` 指定显式 Docker 配置 JSON 文件。它在 `N` 和 `R` 中运行 F1，封存每组产物后再做隐藏 Docker 判分，并单独运行取消对照。manifest（元数据清单）记录评测源码摘要、解析后的已构建入口摘要、案例身份和 Docker 镜像摘要。最终检查再次比较已记录的评测源码；这不会冻结完整依赖图，也不会重新核对每项已构建依赖。结果保持零次真实模型试验。

两个对照组执行同一份经过审核的工具程序，包括已登记的正确输出字节。因此，`N` 产物正确不能说明模型能够推断缺失事实。这些运行校准运行时，并保持零次模型试验、用量与费用未知、没有真实研究注册。该检查不执行完整的五案例、四对照组质量比较。

<a id="docker-execution"></a>
## Docker 执行

[判分 API](oracle.ts)接受显式 `docker` 执行选项，仍只运行同一注册表中的受控案例。它要求 POSIX 宿主、本地 Docker Unix 端点，以及已在本地、由摘要标识的官方 Node 镜像。runner 不拉取镜像，也不读取用户的 Docker 凭据。调用方通过 [DockerProgramRequest](docker-execution.ts)提供可执行文件路径、资源额度、输出上限和清理时限。

每个程序只能看到一个只读角色目录和执行辅助文件。QA 额外获得一个可写判定文件。容器没有网络，根文件系统只读，以非 root 用户运行，移除 capabilities，并限制内存、CPU、进程、临时存储和输出。判分器及其他角色目录不挂载。结果保留实际检查的容器身份、限制、退出状态和删除确认；清理失败会拒绝操作。强制杀死控制宿主进程可能留下容器，不在自动删除保证内。

Docker 限制执行范围，但不认证候选测试报告。Node 测试运行器与候选测试共用报告进程。因此两种执行模式都保留注册表限制，不暴露任意产物判分入口。参见[执行决策](../../.agents/notes/implemented/testing/2026-10-03-scope-native-evaluation.zh.md)。

<a id="evidence-and-limits"></a>
## 证据与限制

判分器只接受已登记的受控案例。任意源码字符串和重新构造的案例对象都会被拒绝。这一限制防止离线入口悄悄变成未审核模型代码的执行器。受控检查验证判分机制；它们不是模型试验、协作成功率或抵御恶意程序的安全测试。

文件工作台授予精确相对文件名及字节额度。它拒绝路径穿越和符号链接，并原子替换写入。它没有 shell 或模型代码执行方法。这些检查不能隔离另一个执行者同时修改目录树的行为，也不是执行沙箱。

五个合成案例不能证明需求、跨机器可靠性或成本节省。在这些案例表现良好的字段选择规则，仍可能在其他 API 或自然语言决策上失败。原生校准覆盖一个固定来源变化案例和两个对照组，不能确立有代表性的协作成功率。

<a id="live-study-requirements"></a>
## 真实研究要求

真实 runner 需要命名 `dsh` profile、生产采样与投递、各对照组相同的准入时点及授权输入、不可访问的判分器和其他项目，以及固定的 provider、模型、提示词和预算。它必须记录实际模型请求、工具、用量、人工介入和失败试验。参见[应用启动规则](../../docs/architecture.zh.md)与[决策记录](../../.agents/notes/implemented/testing/2026-10-03-scope-artifact-oracle.zh.md)。

四个计划对照组为无共享、原准入 publication 投影、一份共享摘要、接收者定制事实。每组使用相同的完整上下文字节限制。来源编辑轨迹固定；前端与 QA 会话组成一个样本。原生下一请求行为与空闲启动分别研究。离线运行完成不代表可以用受控 provider 响应替代缺失的真实证据。

独立的[语义试验](semantic-pilot/README.zh.md)冻结六次辅助摘要调用及人工审阅标准。其本地 HTTP 校准检查生产提供方调用，同时将真实模型尝试次数记录为零。

<a id="dev-note"></a>
## 开发备注

无。
