# Agent Note: 相互独立的 npm 发布族

Status: implemented

[English](2026-08-10-npm-release-sequences.md) | 中文

## 问题

dsh 运行时、vendored 框架与原生包需要独立的版本目标和经过验证的产物，避免每次产品发布都连带重发所有框架与二进制。

`packages/*/*` 与 `apps/*` 包含 dsh 运行时包；`vendor/*` 保存九个 rescope 后的 Cordis 框架包，版本线沿用上游；`native/system/packages/*` 使用独立的平台打包工具。三组的变更节奏与构建要求不同：dsh 跟随产品，vendor 跟随上游同步与本地修改，原生二进制需要按平台构建。若三组共用版本和触发条件，就会强制发布无关改动。

可发布成员不能保留 `private: true`。内部版本范围也必须在打包后成立：`pnpm pack` 会替换 `workspace:` 引用，却保留手写范围。例如，`^0.0.1` 等于 `>=0.0.1 <0.0.2`，既排除 `0.0.2`，也排除 `0.0.1-rc.1` 等预发布版本。workspace 安装成功不能证明打包后的消费方能够解析这些范围。

独立的[按 commit 定址的基线工具](../../../../scripts/publish-npm-baseline.ts)包含 harness 与 vendor 包，并提供 pack、publish、verify 及组合 release 命令。本文的发布族工作流使用仓库记录的族版本与 `scripts/release/` 下的脚本，不采用该工具的时间戳／commit 版本方案。

本记录讨论保留的 `@deepseek-ai` 发布族工具。此 fork 的 `@sandboxbreak/agentharness` 引导包、稳定 tag、可携带产物与 npm 认证由[公开发布准备](../../../../docs/public-release.zh.md)负责。

## 决策

### 三条独立序列

dsh、vendor 与 native/system 发布族各自维护版本规则。发布 dsh 不会发布 vendor 或 native/system。保留的 dsh 与 vendor 工作流可为验证打包其他族的依赖，但不会把它们加入本族发布集。native/system 提供本地发布工具，本 checkout 没有它的托管 npm 发布工作流。`landlock-run-release.yml` 属于独立的 `native/landlock-run` 发布族。

| 序列 | 成员 | 版本基线 | tag | workflow |
|---|---|---|---|---|
| dsh | 非私有的非 experimental `packages/*/*` 与 `apps/*`，加上[显式公开的实验性包选择](../../../../scripts/experimental-package-policy.ts) | 成员、私有 dsh workspace 与根共用一个 SemVer | `dsh-v<版本>` | `release.yml`：手动 pack 与可选发布 |
| vendored framework | 非私有的 `vendor/*` 成员，当前为九个包 | 每包保留自己的版本线；bump 为完整发布族规划版本 | `vendor-<包名>-v<版本>`（每包一个） | `release-vendor.yml`：手动 pack 与可选发布 |
| native/system | `native/system/packages/*` | 发布成员共用独立版本 | `node-addon-system-v<版本>` | [本地发布工具与平台验证](../../../../native/system/docs/release.md)；没有对应的托管发布工作流 |

保留的发布族脚本面向 npm 的 `@deepseek-ai` scope。manifest 通过 `publishConfig.access` 决定预期访问级别，私有 workspace 不进入成员发现。[公开访问的理由](../../archived/process/2026-08-13-public-vendor-and-native-sequences.md)解释了该策略；命令行 `--access` 会覆盖各 manifest 的选择。这些声明不能证明 registry 当前已有的内容或向该 scope 发布的权限。

### 版本由本地命令写进仓库，CI 只核对与上传

本地 bump 命令计算目标版本，更新相应 manifest 与 lockfile，并提交这些文件。发布操作者在 commit 合入 `main` 后创建 tag；保留的发布族工作流只验证与上传，不写版本 commit。native/system 有自己的 bump 与 commit 工具，要求由其[发布指南](../../../../native/system/docs/release.md)说明。

`release:dsh` 接受 `major`、`minor`、`patch` 或显式版本，并更新可发布族、`packages/*/*` 与 `apps/*` 下的私有 manifest，以及 workspace 根。私有成员没有发布 tag，仍不进入 pack 与 publish；共享 bump 保持 workspace 版本一致（[理由](../../archived/process/2026-09-03-workspace-version-coherence-gate.md)）。`0.0.1-alpha.1`、`0.0.1-canary.1`、`0.0.1-rc.1` 等显式预发布版本走同一条验证路径。dsh 将 `alpha` 和 `canary` 映射到同名 npm dist-tag，其他预发布版本映射到 `next`，稳定版沿用 npm 默认的 `latest`。其他族保留各自的 dist-tag 规则。

基础版本号相同时，SemVer 按字典序比较字母数字型预发布标识：`alpha` 小于 `canary`，`canary` 小于 `rc`，所有预发布版本都小于稳定版本。npm dist-tag 是可变别名，不参与版本优先级比较。

### vendor：独立版本线与完整发布族推进

vendored 包保留沿用上游的独立版本线。bump 从 manifest 与最新匹配的仓库 tag 中选择较高的基础版本号；稳定基线递增 patch，而带 tag 的预发布版可为后续预发布或稳定版保留同一组数字。没有匹配 tag 时，以下上游基线展示首次 bump 的目标：

| 包 | 示例上游基线 | 初次 bump 目标 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

仓库 tag 在重新同步后保留版本基线：已有 `4.0.1` tag 时，若上游恢复为 `4.0.0-rc.8`，只看 manifest 会再次计算出 `4.0.1`。`--prerelease rc.1` 在 `next` 上预留排练版本；带 tag 的 `4.0.1-rc.1` 为稳定版保留 `4.0.1`。脚本自行比较 SemVer，不依赖 Git 的 refname 版本排序。

每个发现的 vendor 成员都参与版本计划。[完整 vendor 发布族](../simplification/2026-10-26-complete-vendor-release-family.zh.md)只接替本记录中按 payload 变更选包的决策，并说明为何不能在不同仓库状态下复用未变成员的版本。本记录中每包独立版本线、tag、payload 策略与 registry integrity 核对仍是独立决策。

tag 是仓库中的版本预留，不是 npm 接受发布的证明。bump 读取 Git tag，不查询 registry。因此，失败的发布可能留下没有对应 registry 版本的 tag；publisher 通过下述核对确定 registry 的实际状态，不把 tag 当作上传成功。

`vendor/cordis` 包含 `src`，因为 exports 声明了 `"./src/*"`；省略这些文件会把已安装消费方指向不存在的路径。vendored payload 策略保留这项上游导出选择。

### 发布消费已打包产物，由 registry 决定上传、跳过或失败

发布族 publisher 是由托管工作流组合使用的本地命令，不是 GitHub 专用 API。它读取所给打包目录的 `publish-order.txt`，再把每个 tarball 的包版本与 registry 按三态比对。工作流 tag 验证是独立的前置步骤，直接调用 publisher 不会补上该步骤：

| 状态 | 处置 |
|---|---|
| registry 上没有该版本 | 发布 |
| 已有该版本，且 tarball 的 sha512 等于记录的 `dist.integrity` | 跳过：这是同一批产物的重跑 |
| 已有该版本，但 integrity 不同 | 失败退出，报「内容已变但版本未 bump」 |

第三态拦住「改了代码却没 bump 版本」。前两态给出幂等——同一个 artifact 重跑 publish 不会重复发布，也不需要人工挑拣包。同一条规则还解决了「一次 vendor 发布携带多个 tag，而 workflow 只能从一个 ref 触发」的矛盾：workflow 从不从触发它的 tag 去推断该发哪些包。

native/system 的独立 publisher 也使用逐 tarball 的 registry integrity 核对与既有发布顺序。裸 `npm publish` 循环会在部分发布后的重跑中卡在已经发布的版本上。该 publisher 不执行 tag 或完整 prebuild 验证，也不配置 npm 凭据；这些前提由[原生发布指南](../../../../native/system/docs/release.md)说明。

registry 的两个行为决定了「怎么尝试一次发布」。写入之间至少间隔两秒并带退避重试，因为连续背靠背发多个包会超出 registry 自身的处理速度，换来 `E409 Failed to save packument`。而每次重试都先重查 registry：报出来的失败可能对应一次其实已经落地的写入，所以「该版本现在存在且 integrity 与本 tarball 相同」算作已发布，而不是又一个待放置的版本。

### workspace 内部引用走 `workspace:` 协议

dsh 与 vendor 家族的 workspace 引用使用 `workspace:^`，由打包过程替换为匹配目标版本的范围。原生家族内部的 `workspace:*` 引用发布成精确版本，使入口与其平台包版本一致。

`scripts/check-workspace-constraints.ts` 要求这个协议，所以新包无法再引入硬写的范围；同理，invariant companion 规则要求 `@deepseek-ai/dsh-invariants` 用 `workspace:^`。

### 发布依赖门面使用显式策略

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 按已发布的 Client 与 Host 用法分类 workspace 关系。[发布依赖门面与有限 peer 中继](2026-08-26-published-dependency-faces.zh.md)记录选包规则与理由。

`pnpm run benchmark:npm-resolution` 使用当前安装的 npm 手动测量该依赖图。`pnpm run benchmark:npm-resolution:next` 还会逐个尝试每个可达且未配置的 Host 包，再串行复测领先候选。两个命令都使用回环 metadata registry 并拒绝包归档请求，因此耗时不包含包下载。调度器负载与 metadata 完成顺序会使墙钟阈值失去确定性，所以两个命令都不进入聚合门禁。

### optional 依赖绝不在模块作用域被加载

`optionalDependencies` 中的依赖或在 `peerDependenciesMeta` 中标记为 optional 的 peer，可以不出现在安装树中。模块作用域的值 import 会把这种允许的缺失变成所有到达该模块的消费方的加载失败。workspace 安装可能掩盖问题，启动探针也不会执行所有可选能力，因此任一检查通过都不能证明每条可选路径安全。

[`verify-optional-dependency-imports`](../../../../scripts/verify-optional-dependency-imports.ts) 堵掉这个洞。它从每个包自己的 manifest 读取「这个包允许谁缺失」，再扫描会发布出去的文件——`packages/*/*/src/` 与 `apps/*/src/`——且两个编译门面各扫一遍。`vendor/` 不在范围内，那是[受 vendoring 政策管辖](../../../../vendor/README.md)的固定上游源码。值与类型的判定对着绑定好的 Program 做，而不是看 import 写法，因为 `verbatimModuleSyntax` 是关的：编译器本来就会消除绑定解析为类型的 import，所以 `import type {}`、`import {}`、内联 `type` 说明符、以及解析为类型的具名绑定都不产生产物、一律放行，而裸 import、值绑定、星号 re-export 会被保留、一律报错。只有 type 相位会消除 import：`import defer` 仍然解析并链接它的模块，只推迟求值，所以门禁把它算作一次加载。

报错会点名这个包、点名是哪条声明把它标成 optional 的，并按顺序给出出路——把它作为类型引入（声明合并需要的仅此而已），或者调整写法让模块作用域不再需要这个包。动态 `import()` 只是把失败推迟到首次使用，它属于那种确实需要这个包、并且自己处理缺失的调用方；会想到它，往往说明这个依赖并不 optional，所以门禁不把它作为解法给出。

### 发布族对象

保留的 dsh/vendor 工具把**发布族**建模为一组共享成员发现、版本规则、tag 命名、payload 验证与发布计划的包。新增发布族必须明确这些策略；托管发布通道仍需独立配置工作流，不会因新增一个类自动获得。

| 对象 | 职责 |
|---|---|
| `ReleaseFamily` | 一族的身份：成员发现、版本基线、tag 前缀、打包 payload 规则、已安装入口 |
| `ReleaseMember` | 一个可发布包：目录、包名、版本、manifest |
| `publishOrder` | 先将安装依赖排在消费方之前，再满足可兼容的 peer 顺序，同层按包名排序；报告安装环，并点名被放弃的 peer 排序边。[npm v7+ 默认安装 peer](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies)：放弃排序边不取消兼容约束，因此完整发布族尚未发布时，安装仍可能失败 |
| `pack` | 把整族打进一个目录并记录上传顺序 |
| `verify` | 族的版本基线、完整打印出来的发布顺序；发布时还要求本次运行来自该族的 tag、且成员可发布 |
| `verify-packed-install` | 为声明了已安装可执行入口的家族安装 tarball 并运行该入口；否则跳过消费方安装 |
| `publish` | 上面那三态 |
| `process` / `tarball` | 启动命令、读取打包 tarball 的唯一正家，其中的入口守卫让每个脚本都可被 import |

dsh 族套用仓库的发布 payload 策略（拒绝源码与声明映射）。vendored 族保留上游 payload，因为那些 manifest 导出 `./src/*`，去掉 `src` 会发出一个导出映射指向不存在文件的包。

### 工作流结构：手动打包与显式选择发布

`release.yml` 与 `release-vendor.yml` 只接受 `workflow_dispatch`，`publish` 默认为 false。pack job 在不持有 npm 发布凭据的情况下构建、验证版本与 payload、记录完整上传顺序，并把本族目录上传为一份 artifact。全部 tarball 都在写 registry 前准备好，但后续上传序列不是原子的。

当 `publish=true` 时，版本验证要求匹配的发布族 tag。依赖 pack 的 publish job 使用 `npm-publish` environment，下载本次运行已验证的 artifact，不构建或重新打包，直接发布这些字节。run 按 ref 分组；两个 publish job 共用全局 `Release-publish` 分组，因为 dist-tag 是 registry 的共享状态。publish 步骤从 `NPM_TOKEN` 获得 `NODE_AUTH_TOKEN`；审批规则、凭据有效性与 scope 所有权需要在 checkout 外核实。dsh 发布后，若交付更高的写入格式，操作者更新 [Session 发布记录](../../../../docs/session-format-status.zh.md#updating-the-record)。

dsh 验证也安装 vendored 族的打包产物，因此不依赖 registry 已存在匹配的框架版本。只有 dsh artifact 进入其 publish job；仅用于验证的依赖 tarball 不加入 dsh 发布集。

该验证还提供来自 `native/landlock-run` 的独立 Landlock Run 入口，它是沙箱的普通依赖；其可选平台包则被省略。验证覆盖缺少这些可选二进制时的启动，不覆盖其执行，也不覆盖 native/system 的完整平台矩阵。按目录内容读取 tarball，可以提供这些仅用于验证的跨族依赖，而不把目录内容当作发布顺序。

已安装消费方探针会捕获 npm 的 HTTP 诊断信息，并在安装失败时输出。即使 npm 将 peer manifest 获取失败报告为版本未定义的 `ERESOLVE`，日志中仍能看到 registry 响应码和缓存状态。

### 发布元数据

| 项 | 内容 |
|---|---|
| 发布成员 | 发现时排除 `private: true`；manifest 拥有 `publishConfig.access` 与包含包目录的 `repository` 元数据 |
| 依赖协议 | workspace 引用遵循各家族的协议策略，由 `check-workspace-constraints.ts` 与 invariant companion 规则强制 |
| `vendor/README.md` | 记录「`src` 加入 `cordis` 的 `files`」这条本地修改 |

### 与先前提案的关系

对这些发布族序列，本记录接替[以产物为先的 npm 基线发布](../../rejected/process/2026-08-04-artifact-first-npm-baseline-publication.zh.md)中的版本方案与发布集边界，不采用该提案的时间戳／commit 预发布版本或 `dev-<base>` dist-tag。共同原则仍成立：分离 pack 与 publish、发布经过验证的 tarball，并验证 payload 与已安装产物。独立的基线工具不改变发布族策略。

## 曾考虑的替代方案

**`<base>-<时间戳>-<短 SHA>` 版本号。** 曾计划用于持续 dev 发布。它与「把发布版本留在仓库里」冲突：版本内嵌 commit SHA，而把版本写回会产生新的 commit，于是 SHA 只能指向被发布的父 commit，这条链要靠约定解释。改用数字版本后，`0.0.1-rc.1` 这类预发布号已经覆盖「先验证再正式发」。

**用 `vendor/published.json` 账本记录版本与 commit。** 这会新增一份必须与 registry 保持一致的状态文件。每包 tag 已提供所需的仓库 commit 指针和版本基线，不需要第二份账本，但 tag 仍不能证明发布成功。

**事件级 tag（`vendor-r1`、`vendor-r2`）。** 为「一次发布事件携带多个包版本」准备。既然由 registry 决定发什么，workflow 就不再从 tag 推断集合，per-package tag 够用，而且每个 tag 携带的是它自己那个包的真实版本。

**把九个 vendored 包统一到一条 `4.0.x` 版本线。** 这会丢弃上游版本血缘：cosmokit 从 `1.8.1` 跳到 `4.0.1`，`^1.8.1` 等内部上游范围会立刻失配，必须改写 manifest。完整发布族推进不要求采用这种统一版本方案。

**推进全部 vendored 成员，而不是按 payload 变更选择。** 本记录最初偏好按 payload 选择，以免内容逐字节未变的成员也消耗版本号：每包 tag 加目录 diff 使选择机制较小。它考虑 manifest 的 `files`、npm 总会发布的元数据及受跟踪的构建输入，因为生成的 `lib/` 不在 Git 中，不能漏掉只有源码的改动。该选择机制还核对 tag 所指版本是否存在于 registry，否则失败上传留下的 tag 可能使未发布的包被永久跳过；核对受 registry 可见性与凭据限制，无法访问时只能报告未验证的基线。[后继决策](../simplification/2026-10-26-complete-vendor-release-family.zh.md)接受额外版本，以避免跨仓库状态复用版本。原有的版本膨胀代价仍是取舍，不是对后继决策的新拒绝。

**只按版本号判断「是否已发布」，不比对内容。** 参照流程根本不查 registry：publish 逐个上传，重复版本由 npm 拒绝。只按版本号跳过会漏掉「改了代码没 bump」，而这是唯一会安静地把旧字节留在 registry 上的错误。代价是引入一次 registry 查询和对构建可复现性的依赖。

**在打包后安装验证中加入本地 registry。** 仅解包 tarball 并用普通 Node 运行会绕过版本范围解析。本决策保留从 `file:` tarball 执行 npm 安装，而不增加发布服务器：前者执行依赖范围解析，既有测试覆盖产物行为。原拒绝还依赖自动发布排练与 PR 仅做 pack 的检查，但这些触发假设不描述当前的手动工作流。上文可选解析基准使用的回环 metadata registry 测量的是另一件事。

**按入口闭包挑选子集。** 最初从 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-web-frontend` 仅沿依赖遍历时，217 个包中漏掉 61 个，包括运行所需的 `@deepseek-ai/cordis-plugin-group` 与 `@deepseek-ai/cordis-plugin-logger-console`。插件按 `cordis.yml` 中的名字挂载，因此代码依赖本身不能证明安装后的组合可用；缩小选择范围需要持续证明没有漏掉挂载包。公开发布也会让额外成员对组织外可见。`python/`、`docs/` 与 `website/` 仍不属于这些 npm 发布族。

**把按 commit 定址的基线工具扩展为发布族工作流入口。** 本决策选择仓库记录的族版本与无凭据产物准备，而不是原有的组合发布路径。当前基线工具已有独立命令，也包含 vendor；这些事实不替代发布族版本规则。payload 验证保留共享实现，已安装产物探针仍属于发布族验证。

**一个 workflow 用 `family` 输入选择序列。** 两套版本模型塞进一个文件，会让 concurrency 组、tag 前缀、排练触发条件全部分叉成条件表达式。一族一个文件更短也更好读。

**在发布期改写依赖范围。** 与协议相比，改写逻辑只在 CI 执行过，本机 `pnpm install` 看不出它是否正确，而且每次发布都要重来一遍。

**在 CI 里执行 bump 并把版本推回仓库。** 需要给 workflow 仓库写权限，且发布分支上的版本 commit 会与人的 commit 竞争。bump 与 commit 留在本地，CI 只核对与上传。

## 后果

发布模块保护入口，因此 import 规划或发布逻辑不会执行发布。所属测试覆盖 tag 命名、版本计算、发布排序与环报告、registry integrity 以及各族 payload 策略。完整 vendor 发布族选择删除按 payload 变更选包的机制；先前对源码与构建输入的理由保留在上文替代方案中。

手动请求的 dsh 排练把本族与仅供验证的 tarball 安装到一次性 consumer，再用普通 Node 执行 `dsh --version`。它检查打包文件与依赖解析，不检查交互或原生能力行为。vendor 没有已安装的可执行入口，因此其通用入口验证步骤会报告无入口可运行并直接返回，不执行独立的 consumer 安装。

代价：

- **tag 与 registry 状态可能分离。** bump 从 Git 历史预留版本，不验证上传成功。操作者按 registry 实际状态处理失败或部分发布，publisher 拒绝已存在但字节不同的版本。
- **版本基线依赖可见 tag。** tag 不完整时，上游重新同步可能使 bump 复用已预留的版本号。发布族工作流用 `fetch-depth: 0` 提供历史，本地发布准备也需要同等 tag 可见性。
- **workspace 协议影响已发布范围。** 它保留本地 workspace 解析方式，却改变 tarball 中产出的 semver 引用，因此需要安装后消费方验证。
- **发布需要外部授权。** 公开访问声明不授予 npm scope 权限。托管 dsh/vendor job 依赖有效的 `NPM_TOKEN` 与 environment 配置，native/system 工具不提供托管认证策略。
- **仓库元数据不是 provenance 授权。** manifest 的 `repository` 字段不会配置 npm Trusted Publishing、OIDC 权限或 registry 所有权；这些设置需要选定的发布工作流与账户相匹配。独立的 AgentHarness 流程由其自身记录负责。
- **重新打包可能改变 integrity。** 工作流把一份已验证 artifact 原样交给 publish，不重新构建，但这不能证明同一 commit 的另一轮构建或打包逐字节相同。路径或时间戳可能导致不同 sha512 并明确失败。逐文件内容哈希可容忍归档元数据差异，但会放弃精确 tarball 身份；保留的 publisher 比较 tarball integrity。
- **较旧且尚未发布的稳定版可能使 `latest` 回退。** 在较新版本之后发布它，会应用 npm 的稳定版默认 dist-tag。已存在且相同的版本会被跳过，不移动 tag；预发布排练使用各自非 `latest` 的策略。
- **完整发布族的影响范围较大。** payload 缺陷可能影响多个成员，逐个上传也可能留下 peer 要求暂时无法安装的部分发布族。完整的预发布排练可降低风险，但不能使发布成为原子操作。
