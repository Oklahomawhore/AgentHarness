# Support matrix

| Platform package suffix | Native build host | Payload |
|---|---|---|
| linux-x64 | Linux x64 with musl-gcc | static Landlock executable; glibc and musl system.node |
| linux-arm64 | Linux arm64 with musl-gcc | static Landlock executable; glibc and musl system.node |
| darwin-x64 | macOS x64 with cc | system.node |
| darwin-arm64 | macOS arm64 with cc | system.node |

Complete native-family acceptance requires exercising the same Node-API v8 addon bytes under Node 20, 22, 24, and 26 on each declared platform/libc. This repository does not configure that independent native-family CI; [release tooling](release.md#publication-tools) and current-platform rehearsals do not establish this complete matrix. macOS builds target 11.0 or later. Linux binding selection uses the running Node process's libc; the static launcher serves both libc variants.

Landlock additionally requires an enforcing Linux kernel. The functional probe determines full, partial, or unusable enforcement; kernel version alone is not an availability guarantee.

Windows has neither a Landlock launcher nor this POSIX addon. The Harness retains its existing Windows semaphore implementation. Other CPU/OS combinations have no declared platform package: Landlock probes unusable, and flock acquisition rejects. New platform support requires a native builder and installed-artifact verification.
