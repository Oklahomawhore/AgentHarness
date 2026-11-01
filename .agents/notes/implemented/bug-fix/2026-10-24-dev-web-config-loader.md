# Agent Note: Config loading in the Web development watcher

Status: implemented

English | [中文](2026-10-24-dev-web-config-loader.zh.md)

## Problem

On Node 22.22, tsdown's automatically selected native config loader installs synchronous module hooks that conflict with tsx when a config imports a CommonJS dependency. Its `tsx` loader also leaves typed workspace configs untransformed in the real development launch: `import type` fails before the initial build, including under an ESM-only process launcher. The root config reaches TypeScript through the Typert generator, and client workspace configs contain type-only syntax, so the watcher must load both forms.

## Decision

[The watcher](../../../../scripts/dev-web.ts) runs as `node scripts/dev-web.ts --poll`. Node strips this development script's types; tsdown owns configuration loading without an outer tsx hook. Its default loader is native on the supported Node versions. Package configuration files and build outputs stay unchanged, and no dependency is added.

This applies only to the development watcher and its source imports, currently [the client build environment helper](../../../../scripts/client-build-environment.ts). These files must use erasable TypeScript, explicit relative extensions and installed package exports; Node does not apply tsconfig paths. [Node 22.19 documents this support](https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html). The [dsh source launcher](../architecture/2026-07-29-dsh-source-launch-tsx-esm.md) still needs tsx for its parameter properties, decorators and runtime enums. No transform-types flag or version-dependent launch path is introduced.

## Alternatives considered

**Keep tsx around the native config loader.** The combination fails when configurations import CommonJS dependencies.

**Use the `tsx` config loader.** The real workspace fails with both full and ESM-only tsx launchers. Selecting ESM-only tsx does not resolve that loader's workspace failure.

**Use the `unrun` config loader.** It loads the configuration files but fails package discovery in the current shared client preset. The watcher does not need an additional bundling loader when its own source can run directly under Node.

**Own a config loader.** tsdown already exposes a maintained loader supporting the required TypeScript and CommonJS inputs; a local implementation would duplicate that responsibility.

## Consequences

tsdown retains responsibility for configuration dependencies, including shared helpers such as [the client preset](../../../../packages/client/tsdown.client.ts). Source edits retain automatic rebuilding.

[The owner-local regression](../../../../scripts/dev-web.spec.ts) starts the real watcher function in a fresh Node process without an outer module hook, with CommonJS dependencies, `createRequire`, a shared TypeScript helper, type-only imports, annotations and `satisfies` in the root and two workspace configs. It verifies each config affects its written bundle and awaits watcher disposal and natural child-process closure. The source-rebuild case covers subsequent edits; [the browser HMR case](../../../../apps/web/tests/hmr-live.e2e.ts) covers the declared `dev:web` launcher and supported Web profile.

The browser case also verifies the edited text reaches TypeScript output. It restores the source and stops its managed processes before restoring browser artifacts and the edited package's `lib/types` tree and `tsconfig.tsbuildinfo` byte for byte. It checks the restored paths and bytes, including the locale output independently of the artifact list.

`check:node-compat` runs this configuration regression through the `dev-web-config-smoke` gate in [the gate runner](../../../../scripts/run-gates.ts).
