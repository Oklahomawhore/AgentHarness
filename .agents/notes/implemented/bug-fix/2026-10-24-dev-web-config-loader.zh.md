# Agent Note：Web 开发 watcher 的配置加载

Status: implemented

[English](2026-10-24-dev-web-config-loader.md) | 中文

## 问题

在 Node 22.22 上，tsdown 自动选择的 native 配置加载器会安装同步模块钩子；配置导入 CommonJS 依赖时，这些钩子与 tsx 冲突。它的 `tsx` 加载器也会让真实开发启动中的工作区配置未经转换就进入 Node，导致 `import type` 在首次构建前失败，ESM-only 进程启动器同样如此。根配置通过 Typert 生成器导入 TypeScript，客户端工作区配置则含有类型语法，因此 watcher 必须同时支持这两种配置。

## 决策

[watcher](../../../../scripts/dev-web.ts) 通过 `node scripts/dev-web.ts --poll` 运行。Node 擦除这份开发脚本的类型；tsdown 负责配置加载，不再叠加外层 tsx 钩子。在受支持的 Node 版本上，其默认加载器为 native。包配置文件及构建产物保持不变，不新增依赖。

该方式仅适用于开发 watcher 及其源码导入，目前为[客户端构建环境辅助模块](../../../../scripts/client-build-environment.ts)。这些文件必须使用可擦除的 TypeScript、显式相对扩展名和已安装包的导出；Node 不应用 tsconfig paths。[Node 22.19 文档说明了此支持](https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html)。[dsh 源码启动器](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md) 仍需 tsx 处理参数属性、装饰器和运行时枚举。这里不引入 transform-types 标志或按版本切换的启动路径。

## 考虑过的替代方案

**在 native 配置加载器外保留 tsx。** 配置导入 CommonJS 依赖时，这种组合会失败。

**使用 `tsx` 配置加载器。** 真实工作区在完整和 ESM-only tsx 启动器下均失败。选择 ESM-only tsx 无法解决该加载器的工作区加载失败。

**使用 `unrun` 配置加载器。** 它能够加载配置文件，但当前共享客户端预设的包发现失败。watcher 的源码可以直接通过 Node 运行，无须额外的打包加载器。

**自建配置加载器。** tsdown 已提供持续维护的加载器，支持所需的 TypeScript 和 CommonJS 输入；本地实现会重复承担该职责。

## 影响

tsdown 继续负责配置依赖，包括[客户端预设](../../../../packages/client/tsdown.client.ts)等共享辅助模块。源码编辑仍会触发自动重新构建。

[所属脚本的回归测试](../../../../scripts/dev-web.spec.ts) 在没有外层模块钩子的全新 Node 进程中启动真实 watcher 函数，并在根配置和两个工作区配置中使用 CommonJS 依赖、`createRequire`、共享 TypeScript 辅助模块、type-only import、类型注解和 `satisfies`。测试验证每份配置都影响实际写出的 bundle，并等待 watcher 释放及子进程自然关闭。源码重建用例覆盖后续编辑；[浏览器 HMR 用例](../../../../apps/web/tests/hmr-live.e2e.ts) 覆盖声明的 `dev:web` 启动器和受支持的 Web profile。

浏览器用例还验证编辑后的文本确实进入 TypeScript 输出。它先恢复源码并停止托管进程，再逐字节恢复浏览器产物，以及被编辑包的 `lib/types` 目录和 `tsconfig.tsbuildinfo`。它随后检查恢复的路径和字节，并独立于产物列表检查 locale 输出。

`check:node-compat` 通过[门禁运行器](../../../../scripts/run-gates.ts)的 `dev-web-config-smoke` 门禁执行此配置回归。
