# 公开发行准备

[English](public-release.md) | 中文

本文说明 AgentHarness npm 启动包及本分支的公开发布。公开仓库为 [Oklahomawhore/AgentHarness](https://github.com/Oklahomawhore/AgentHarness)；npm 包名所有权和认证仍是独立的发行前提。

## 用户安装

`npx --yes @sandboxbreak/agentharness` 安装固定版本的便携发行包，其中包含本分支的 DeepSeek Harness 运行时和 Node.js，然后启动本地 Web 界面。npx 需要 Node.js，各平台还需要[根 README](../README.zh.md)所列工具。DeepSeek Harness 已包含在便携依赖闭包中，用户无需另行安装上游 npm 包。启动包没有 npm postinstall hook。

全新安装生成独立集群凭据。已有凭据保持不变；加入其他团队使用 `agentharness cluster join --secret-stdin`。用户自行填写模型 API key。安装器配置受支持的 MCP 客户端，保留冲突配置。重复运行相同启动包会再次下载其固定版本。安装后的命令用于查看状态、日志和关闭服务。

## 自动发行

[AgentHarness release 工作流](../.github/workflows/agentharness-release.yml)仅在推送稳定版本 tag `vMAJOR.MINOR.PATCH` 时发布新版本。tag 指向的提交必须可从 `main` 到达，否则工作流拒绝发布；[分支协作流程](development.zh.md#agentharness-branch-workflow)规定在经过审查和验证的准确 `main` 提交上打 tag。该提交可以早于当前分支顶端，无需是 release 分支的合并提交。产物和 npm 版本取自 tag，重跑同一 run 仍使用该版本。分支推送和 Pull Request 不启动这一发布矩阵，工作流也不向源码提交版本变更。

五个平台在各自原生 runner 上构建和执行打包 smoke：macOS arm64/x64、Linux arm64/x64、Windows x64。全部成功后创建草稿 Release，上传便携归档、两个安装器、npm tarball、manifest 和 SHA256SUMS，再公开已推送的 tag。工作流从独立的 Release 附件接口核验文件名，只重试缺失文件；已完整的同版本 Release 保持不变。发布权限仅授予 Release job。其他 CI 工作流保持原有触发方式；AgentHarness 的自动发布不依赖上游 runner 或账号。

如果已公开的 Release 缺少附件，可以手动运行同一工作流，填写成功的 tag run ID 作为 `repair_run_id`、稳定版本 tag 作为 `repair_tag`。修复 job 下载五个平台已通过的构建产物，重新生成 npm 启动包和校验文件，只上传缺失文件并核验附件名称。手动运行不会重新构建运行时，也不会发布新版本。

产物位于本仓库 GitHub Releases。公开 npm 启动包的安装器使用 `https://github.com/Oklahomawhore/AgentHarness/releases/download/v<version>/`，并固定归档校验值。手工复现 staging：

```sh
pnpm run stage:agentharness-npx -- \
  --artifact dist/agentharness-portable/agentharness-darwin-arm64.tgz \
  --out dist/agentharness-public-release \
  --base-url https://github.com/Oklahomawhore/AgentHarness --github
```

其他目标重复传入 `--artifact`。本地构建可通过 `AGENTHARNESS_RELEASE_VERSION` 指定便携发行版本，源码 workspace 包版本不变。省略 `--github` 时继续支持原静态托管目录。

## npm 认证

GitHub Release 自动发布不需要个人令牌，使用工作流的 `GITHUB_TOKEN`。npm 用户 `sandboxbreak` 拥有 `@sandboxbreak` scope。npm 的 Trusted Publisher 授权 `Oklahomawhore/AgentHarness` 的 `agentharness-release.yml` 直接发布 `@sandboxbreak/agentharness`。npm job 具有 `id-token: write` 权限，不接收 `NPM_TOKEN`；将仓库变量 `AGENTHARNESS_NPM_PUBLISH` 设为 `true` 即可在版本 tag 触发时启用它。

npm job 在 GitHub Release 成功后下载已发布的原始 tarball，核验 SHA256SUMS，再以 provenance 和 `latest` tag 发布。版本已存在时，只有 registry 完整性与发布包一致才通过。npm 失败不会删除 GitHub Release，配置修复后可重跑失败 job。npm 扫描新发布的版本时，公开安装可能需要等待数分钟。认证规则见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 源码公开

根目录 `.env` 仅供本地使用；`.env.example` 不含 API key。此公开仓库从全新的 Git 历史开始。导出其他源码工作区时，应撤销已泄露的凭据；从当前索引移除文件不会移除旧提交、标签或其他 ref。导出不含旧 Git 元数据的源码：

```sh
pnpm run export:agentharness-public
```

导出器从已跟踪和未被忽略的工作区文件创建新的 `dist/agentharness-public-source`，保留内部符号链接，排除环境文件和 Git 元数据，并拒绝识别出的凭据及与本地密钥完全相同的值。输出目录已存在时会拒绝执行。检查旁边的 audit JSON，在导出目录内初始化新仓库；不要推送原仓库的分支、标签或 mirror。启发式扫描不能替代全面密钥审计；此导出明确舍弃上游 Git 历史，同时保留许可证与署名文件。

内部验收仓库地址通过明确的环境变量提供。可选 Azure provider 工作流使用仓库变量 `DSH_PI_AI_OPENAI_BASE_URL`。上游 issue、社区、发行及文档链接仍指向上游；创建 GitHub 仓库后配置本分支的支持渠道和发行工作流。公开前检查已记录的诊断、浏览器快照、Agent Notes 和截图是否包含个人或业务信息。
