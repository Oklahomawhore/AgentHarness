# Agent Note: Web 浏览器预期输出的必需 CI 门禁

Status: implemented

[English](2026-07-30-web-browser-snapshot-ci-gate.md) | 中文

## 问题

[无密钥 Web 浏览器 e2e 车道](2026-07-24-web-gui-browser-e2e-lane.zh.md)只由本地 `pnpm run test:web` 运行，PR CI 不比较 `snapshots/web/` 或 `apps/web/tests/expected/` 下的 Web 预期输出。因此，改变用户可见 Web 输出的 PR 可以在漏刷预期输出时保持绿色；后来任意分支显式运行 `DSH_SNAPSHOT=refresh`，都会替前序变更补账并产生与本分支无关的 diff。普通本地运行已经默认使用只读 replay，缺口是 PR 级的强制执行，而不是禁止 refresh 写入。

## 决策

Linux PR 的 `node 24 / consumers` job 运行完整 Web 浏览器 replay/compare 套件。[scripts/run-gates.ts](../../../../scripts/run-gates.ts) 注入 `DSH_SNAPSHOT=replay`，因此不一致会直接失败，不会改写预期输出。[当前工作流](../../../../.github/workflows/ci.yml)不设置 `DSH_WEB_SNAPSHOT_WORKERS`，选择串行的 `test:web:built` 命令。

消费方 job 负责构建，因此 `apps/web/dist` 和包的 `lib/` 目录会保留在其工作区中供浏览器套件使用。CI 按锁文件选定的 Playwright 版本安装 Chromium 及其系统依赖。[托管 CI 决策](../process/2026-10-25-agentharness-hosted-ci.zh.md)拥有一次性运行器选择；工作流没有浏览器缓存恢复或热备 job。

本地 `pnpm run test:web` 仍先构建，再串行运行完整浏览器套件；`test:web:built` 是已有构建产物的串行执行入口。开发者只在确认用户可见输出有意变化后显式运行 `DSH_SNAPSHOT=refresh pnpm run test:web`，评审每一处预期输出 diff，再以 replay 模式复验不再写文件。

显式设置大于一的 `DSH_WEB_SNAPSHOT_WORKERS` 会选择 `test:web:ci`。其[协调器](../../../../scripts/run-web-snapshots.ts)先以独立的串行 Vitest 调用运行 `hmr-live.e2e.ts` 与 `cordis-tool-round.e2e.ts`，再按指定 worker 数在同一个池中运行其余文件。HMR 会修改已构建的工作区状态；Cordis 拥有对生命周期时序敏感的批准与 steering 序列。每个子进程继承 stdio，外围门禁通过 `run-gates` 流式传递输出。这个可选协调器不设定当前 CI 的 worker 预算。

必需的浏览器比较在 Linux 消费方 job 中运行，因为这些场景面向 POSIX。原生 Windows 和 Node 兼容性 job 不安装 Chromium。必需的 CI 判定依赖消费方 job 成功，因此浏览器比较失败会使该判定失败。

历史本地 replay 测得六个 worker 耗时约 65–71 秒，十二个 worker 约 50 秒。这些测量描述对应配置，不代表当前托管运行器的容量。浏览器快照等待 `built-package-invariants`；独立门禁在各自前置条件结束后可以重叠运行。

## 曾考虑的替代方案

**继续只要求本地运行。** 已否决：执行依赖开发者记忆，正是陈旧 golden 跨 PR 漂移的原因，不能保证产生行为变化的 PR 自己携带预期输出 diff。

**让 CI 以 `refresh` 模式运行后检查工作树。** 已否决：写后比较把断言机制变成生成器，若工作树检查接入有误，就可能把回归变成能够通过的预期输出更新；replay 直接比较已有 golden，失败面更小。

**新建独立 browser job 并重新构建全仓。** 已否决：它会重复依赖安装和发布构建。现有 Linux 消费方 job 已负责该构建，并已被统一的 required verdict 聚合。

**把 HMR 与 Cordis 也放进并行池。** 不予采用，因为 HMR 会修改共享的已构建状态，Cordis 批准 continuation 则需要串行预检。其余全部文件共用一个有界池；专用长文件进程会增加调度代码，并在这些文件结束后让缩减后的部分 worker 预算闲置。

**用 jsdom 快照代替真实 Chromium。** 已否决：jsdom 不覆盖浏览器、HTTP/SSE 承载及真实客户端插件包的组合；它仍可用于快速的下层反馈，但不能替代组装后的浏览器链路。

## 后果

每个符合触发条件的 PR 都比较当前 Web 组装与已提交的浏览器预期输出。成本是在消费方 job 中安装 Chromium 并运行完整浏览器套件；已有构建会被复用。worker 预算变更需要完整端到端测量，不能依据运行中耗时估算。门禁不声称跨平台浏览器一致性。Playwright/Chromium 升级若改变 ARIA 输出，需要显式 refresh 并评审结果。
