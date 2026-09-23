#!/usr/bin/env node
/** Stage checksummed portable artifacts and a pinned shell installer for static hosting. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describeClusterSecret, validateClusterSecret } from './agentharness-cluster.mjs'

const root = resolve(import.meta.dirname, '..')
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function privateIpv4(hostname) {
  if (isIP(hostname) !== 4) return false
  const parts = hostname.split('.').map(Number)
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254)
    || parts[0] === 127
}

/** Accept HTTPS origins and explicit private IPv4 HTTP origins used by the LAN publisher. */
export function validateReleaseBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`invalid release base URL ${JSON.stringify(value)}`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('release base URL cannot contain credentials, a query, or a fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateIpv4(url.hostname))) {
    throw new Error('release base URL must use HTTPS, except for an explicit private IPv4 LAN address')
  }
  return url.href.replace(/\/$/u, '')
}

/** Normalize a portable manifest platform and architecture into its release target. */
export function portableTarget(platform, architecture) {
  const target = `${platform}-${architecture}`
  if (!SUPPORTED_TARGETS.has(target)) throw new Error(`unsupported portable target ${JSON.stringify(target)}`)
  return target
}

function validateStageOutput(output) {
  const normalized = resolve(output)
  if (normalized === root || root.startsWith(`${normalized}${sep}`)) {
    throw new Error(`release output cannot contain the repository root: ${normalized}`)
  }
  return normalized
}

async function resetStageOutput(output) {
  let exists = true
  try {
    await stat(output)
  } catch (error) {
    if (error?.code === 'ENOENT') exists = false
    else throw error
  }
  if (exists) {
    let marker
    try {
      marker = await readFile(resolve(output, '.agentharness-release-root'), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`refusing to replace unowned release output: ${output}`)
      throw error
    }
    if (marker !== 'AgentHarness static release directory\n') throw new Error(`refusing to replace unowned release output: ${output}`)
    await rm(output, { recursive: true, force: true })
  }
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, '.agentharness-release-root'), 'AgentHarness static release directory\n')
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Inspect a portable archive without extracting its runtime payload. */
export async function inspectPortableArchive(path) {
  let raw
  try {
    raw = execFileSync('tar', ['-xOf', path, './agentharness-portable.json'], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`cannot read agentharness-portable.json from ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = JSON.parse(raw)
  if (manifest.product !== 'AgentHarness' || typeof manifest.version !== 'string') {
    throw new Error(`${path} is not an AgentHarness portable archive`)
  }
  const target = portableTarget(manifest.platform, manifest.arch)
  const expectedNode = `runtime/${manifest.platform === 'win32' ? 'node.exe' : 'node'}`
  if (manifest.runtime?.node !== expectedNode) throw new Error(`${path} does not contain the declared bundled Node runtime`)
  const archiveStat = await stat(path)
  return { path: resolve(path), manifest, target, sha256: await sha256(path), size: archiveStat.size }
}

function renderClusterSetup(clusterSecret) {
  if (clusterSecret !== undefined) {
    return [
      `cluster_secret=${shellLiteral(validateClusterSecret(clusterSecret))}`,
      'if ! printf \'%s\\n\' "$cluster_secret" | AGENTHARNESS_ACTIVE_ROOT="$payload" "$payload/runtime/node" "$payload/agentharness.mjs" cluster join --secret-stdin; then',
      '  fail "cluster credential does not match this installation; run agentharness cluster join --secret-stdin --replace explicitly to switch clusters"',
      'fi',
      'unset cluster_secret',
    ]
  }
  return [
    'if AGENTHARNESS_MESH_SECRET= AGENTHARNESS_ACTIVE_ROOT="$payload" "$payload/runtime/node" "$payload/agentharness.mjs" cluster status >/dev/null 2>&1; then',
    '  printf \'Keeping the existing AgentHarness cluster credential.\\n\'',
    'else',
    '  cluster_secret=${AGENTHARNESS_MESH_SECRET:-}',
    '  if [ -z "$cluster_secret" ]; then',
    '    [ -r /dev/tty ] || fail "cluster join secret is required; rerun in an interactive terminal or set AGENTHARNESS_MESH_SECRET"',
    '    command -v stty >/dev/null 2>&1 || fail "cluster join secret input requires stty"',
    '    printf \'AgentHarness cluster join secret (input hidden): \' >/dev/tty',
    '    stty -echo </dev/tty || fail "could not hide cluster join secret input"',
    '    trap \'stty echo </dev/tty 2>/dev/null || :; cleanup\' EXIT HUP INT TERM',
    '    IFS= read -r cluster_secret </dev/tty || fail "could not read cluster join secret"',
    '    stty echo </dev/tty || fail "could not restore terminal input"',
    '    trap cleanup EXIT HUP INT TERM',
    '    printf \'\\n\' >/dev/tty',
    '  fi',
    '  [ -n "$cluster_secret" ] || fail "cluster join secret cannot be empty"',
    '  if ! printf \'%s\\n\' "$cluster_secret" | AGENTHARNESS_MESH_SECRET= AGENTHARNESS_ACTIVE_ROOT="$payload" "$payload/runtime/node" "$payload/agentharness.mjs" cluster join --secret-stdin; then',
    '    fail "could not persist the supplied cluster join secret"',
    '  fi',
    '  unset cluster_secret',
    'fi',
  ]
}

/** Render an immutable installer; omitting the secret requires an existing credential or hidden terminal input. */
export function renderInstallScript({ baseUrl, version, artifacts, clusterSecret: suppliedClusterSecret, artifactBaseUrl }) {
  const normalizedBaseUrl = validateReleaseBaseUrl(baseUrl)
  const archiveBaseUrl = validateReleaseBaseUrl(artifactBaseUrl ?? `${normalizedBaseUrl}/releases/${version}`)
  const clusterSetup = renderClusterSetup(suppliedClusterSecret)
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) throw new Error(`invalid portable version ${JSON.stringify(version)}`)
  const targets = Object.keys(artifacts).filter(target => /^(?:darwin|linux)-/u.test(target)).sort()
  if (targets.length === 0) throw new Error('at least one macOS or Linux portable artifact is required')
  const targetCases = targets.map((target) => {
    const artifact = artifacts[target]
    if (!/^(?:darwin|linux)-(?:arm64|x64)$/u.test(target)) throw new Error(`invalid portable target ${JSON.stringify(target)}`)
    if (!/^agentharness-[a-z0-9-]+\.tgz$/u.test(artifact.file)) throw new Error(`invalid archive filename for ${target}`)
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) throw new Error(`invalid SHA-256 for ${target}`)
    return `  ${target}) archive=${shellLiteral(artifact.file)}; expected_sha=${shellLiteral(artifact.sha256)} ;;`
  })
  return [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    '',
    `base_url=${shellLiteral(normalizedBaseUrl)}`,
    `version=${shellLiteral(version)}`,
    '',
    'fail() { printf \'agentharness installer: %s\\n\' "$*" >&2; exit 1; }',
    'need() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }',
    'case "$base_url" in http://*) printf \'Warning: installing over trusted-LAN HTTP; the connection does not authenticate the release server.\\n\' >&2 ;; esac',
    '',
    'need curl',
    'need tar',
    'need mktemp',
    'need uname',
    'need ln',
    'need mv',
    '',
    'case "$(uname -s)" in',
    '  Darwin) os=darwin ;;',
    '  Linux) os=linux ;;',
    '  *) fail "unsupported operating system: $(uname -s); this installer supports macOS and Linux" ;;',
    'esac',
    'case "$(uname -m)" in',
    '  arm64|aarch64) arch=arm64 ;;',
    '  x86_64|amd64) arch=x64 ;;',
    '  *) fail "unsupported CPU architecture: $(uname -m)" ;;',
    'esac',
    'target="$os-$arch"',
    'case "$target" in',
    ...targetCases,
    '  *) fail "no AgentHarness $version artifact was published for $target" ;;',
    'esac',
    '',
    'install_root=${AGENTHARNESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agentharness}',
    'bin_dir=${AGENTHARNESS_BIN_DIR:-$HOME/.local/bin}',
    'versions_dir="$install_root/versions"',
    'temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/agentharness-install.XXXXXX")',
    'cleanup() { rm -rf "$temp_dir"; }',
    'trap cleanup EXIT HUP INT TERM',
    'archive_path="$temp_dir/$archive"',
    '',
    'printf \'Downloading AgentHarness %s for %s...\\n\' "$version" "$target"',
    `curl -fsSL --retry 2 --connect-timeout 10 --max-time 300 ${shellLiteral(archiveBaseUrl)}/"$archive" -o "$archive_path"`,
    'if command -v sha256sum >/dev/null 2>&1; then',
    '  checksum_output=$(sha256sum "$archive_path")',
    'elif command -v shasum >/dev/null 2>&1; then',
    '  checksum_output=$(shasum -a 256 "$archive_path")',
    'else',
    '  fail "missing SHA-256 tool: install sha256sum or shasum"',
    'fi',
    'actual_sha=${checksum_output%% *}',
    '[ "$actual_sha" = "$expected_sha" ] || fail "checksum mismatch for $archive"',
    '',
    'if ! tar -tzf "$archive_path" | while IFS= read -r member; do',
    '  case "$member" in /*|../*|*/../*|*/..) exit 1 ;; esac',
    'done; then',
    '  fail "archive contains an unsafe path"',
    'fi',
    'payload="$temp_dir/payload"',
    'mkdir -p "$payload"',
    'tar -xzf "$archive_path" -C "$payload"',
    '[ -x "$payload/runtime/node" ] || fail "archive is missing its bundled Node runtime"',
    '[ -f "$payload/start.mjs" ] || fail "archive is missing start.mjs"',
    '[ -f "$payload/mcp.mjs" ] || fail "archive is missing mcp.mjs"',
    '[ -f "$payload/agentharness.mjs" ] || fail "archive is missing agentharness.mjs"',
    '[ -f "$payload/agentharness-cluster.mjs" ] || fail "archive is missing agentharness-cluster.mjs"',
    '',
    'if ! "$payload/runtime/node" - "$payload/agentharness-portable.json" "$version" "$os" "$arch" <<\'AGENTHARNESS_MANIFEST_CHECK\'',
    "import { readFileSync } from 'node:fs'",
    'const [path, version, platform, arch] = process.argv.slice(2)',
    "const manifest = JSON.parse(readFileSync(path, 'utf8'))",
    "if (manifest.product !== 'AgentHarness' || manifest.version !== version || manifest.platform !== platform || manifest.arch !== arch) process.exit(1)",
    "if (manifest.runtime?.node !== 'runtime/node') process.exit(1)",
    'AGENTHARNESS_MANIFEST_CHECK',
    'then',
    '  fail "portable manifest does not match the selected release"',
    'fi',
    '',
    ...clusterSetup,
    '',
    'mkdir -p "$versions_dir" "$bin_dir"',
    'release_id="$version-$target-$expected_sha"',
    'release_dir="$versions_dir/$release_id"',
    'if [ ! -d "$release_dir" ]; then',
    '  incoming="$versions_dir/.incoming.$$"',
    '  mv "$payload" "$incoming"',
    '  mv "$incoming" "$release_dir"',
    'fi',
    '[ ! -e "$install_root/current" ] || [ -L "$install_root/current" ] || fail "$install_root/current exists and is not a symbolic link"',
    'current_tmp="$install_root/.current.$$"',
    'rm -f "$current_tmp"',
    'ln -s "versions/$release_id" "$current_tmp"',
    'if ! "$release_dir/runtime/node" - "$current_tmp" "$install_root/current" <<\'AGENTHARNESS_ACTIVATE\'',
    "import { renameSync } from 'node:fs'",
    'const [source, target] = process.argv.slice(2)',
    'renameSync(source, target)',
    'AGENTHARNESS_ACTIVATE',
    'then',
    '  rm -f "$current_tmp"',
    '  fail "could not activate $release_dir"',
    'fi',
    '',
    'shim_tmp="$bin_dir/.agentharness.$$"',
    'cat > "$shim_tmp" <<\'AGENTHARNESS_SHIM\'',
    '#!/bin/sh',
    'set -eu',
    'install_root=${AGENTHARNESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agentharness}',
    'export AGENTHARNESS_ACTIVE_ROOT="$install_root/current"',
    'exec "$install_root/current/runtime/node" "$install_root/current/agentharness.mjs" "$@"',
    'AGENTHARNESS_SHIM',
    'chmod 755 "$shim_tmp"',
    'mv -f "$shim_tmp" "$bin_dir/agentharness"',
    '',
    'command_path="$bin_dir/agentharness"',
    'printf \'Installed AgentHarness %s at %s\\n\' "$version" "$release_dir"',
    'case ":$PATH:" in *":$bin_dir:"*) ;; *) printf \'Add %s to PATH, or use %s directly.\\n\' "$bin_dir" "$command_path" ;; esac',
    'printf \'Start: %s start\\nStatus: %s status\\nLogs: %s logs\\nStop: %s stop\\n\' "$command_path" "$command_path" "$command_path" "$command_path"',
    'if [ "${AGENTHARNESS_NO_START:-0}" != 1 ]; then',
    '  "$command_path" start',
    'else',
    '  printf \'Automatic start skipped because AGENTHARNESS_NO_START=1.\\n\'',
    'fi',
    '"$command_path" mcp-setup',
    '',
  ].join('\n')
}

function renderPowerShellClusterSetup(clusterSecret) {
  const supplied = clusterSecret === undefined
    ? [
        '$ClusterSecret = $env:AGENTHARNESS_MESH_SECRET',
        'if ([string]::IsNullOrWhiteSpace($ClusterSecret)) {',
        '  if (-not [Environment]::UserInteractive) { throw "cluster join secret is required; rerun in an interactive terminal or set AGENTHARNESS_MESH_SECRET" }',
        '  $SecureSecret = Read-Host "AgentHarness cluster join secret" -AsSecureString',
        '  $SecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)',
        '  try { $ClusterSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($SecretPointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($SecretPointer) }',
        '}',
      ]
    : [`$ClusterSecret = ${powershellLiteral(validateClusterSecret(clusterSecret))}`]
  return [
    '$PreviousMeshSecret = $env:AGENTHARNESS_MESH_SECRET',
    'try {',
    '  $env:AGENTHARNESS_MESH_SECRET = $null',
    '  & $NodePath $CommandEntry cluster status *> $null',
    '  $HasCredential = $LASTEXITCODE -eq 0',
    '} finally { $env:AGENTHARNESS_MESH_SECRET = $PreviousMeshSecret }',
    ...clusterSecret === undefined ? [] : ['$HasCredential = $false'],
    'if ($HasCredential) {',
    '  Write-Host "Keeping the existing AgentHarness cluster credential."',
    '} else {',
    ...supplied.map(line => `  ${line}`),
    '  if ([string]::IsNullOrWhiteSpace($ClusterSecret)) { throw "cluster join secret cannot be empty" }',
    '  $StartInfo = [Diagnostics.ProcessStartInfo]::new()',
    '  $StartInfo.FileName = $NodePath',
    '  $StartInfo.Arguments = "`"$CommandEntry`" cluster join --secret-stdin"',
    '  $StartInfo.UseShellExecute = $false',
    '  $StartInfo.RedirectStandardInput = $true',
    '  $StartInfo.RedirectStandardOutput = $true',
    '  $StartInfo.RedirectStandardError = $true',
    '  $StartInfo.EnvironmentVariables["AGENTHARNESS_MESH_SECRET"] = ""',
    '  $ClusterProcess = [Diagnostics.Process]::Start($StartInfo)',
    '  try {',
    '    $ClusterProcess.StandardInput.WriteLine($ClusterSecret)',
    '    $ClusterProcess.StandardInput.Close()',
    '    $ClusterOutput = $ClusterProcess.StandardOutput.ReadToEnd()',
    '    $ClusterError = $ClusterProcess.StandardError.ReadToEnd()',
    '    $ClusterProcess.WaitForExit()',
    '    if ($ClusterProcess.ExitCode -ne 0) { throw "could not persist the supplied cluster join secret: $ClusterError" }',
    '    Write-Host ($ClusterOutput.TrimEnd())',
    '  } finally {',
    '    $ClusterSecret = $null',
    '    $ClusterProcess.Dispose()',
    '  }',
    '}',
  ]
}

/** Render a Windows x64 PowerShell installer with the same credential and checksum rules as install.sh. */
export function renderPowerShellInstallScript({ baseUrl, version, artifacts, clusterSecret, artifactBaseUrl }) {
  const normalizedBaseUrl = validateReleaseBaseUrl(baseUrl)
  const archiveBaseUrl = validateReleaseBaseUrl(artifactBaseUrl ?? `${normalizedBaseUrl}/releases/${version}`)
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) throw new Error(`invalid portable version ${JSON.stringify(version)}`)
  const artifact = artifacts['win32-x64']
  if (artifact === undefined) throw new Error('a win32-x64 portable artifact is required')
  if (!/^agentharness-win32-x64\.tgz$/u.test(artifact.file)) throw new Error('invalid archive filename for win32-x64')
  if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) throw new Error('invalid SHA-256 for win32-x64')
  return [
    '# AgentHarness immutable Windows x64 installer.',
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    `$BaseUrl = ${powershellLiteral(normalizedBaseUrl)}`,
    `$Version = ${powershellLiteral(version)}`,
    `$Archive = ${powershellLiteral(artifact.file)}`,
    `$ExpectedSha = ${powershellLiteral(artifact.sha256)}`,
    'if (-not [Environment]::Is64BitOperatingSystem -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw "this installer supports Windows x64 only" }',
    'if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw "tar.exe is required (included with supported Windows versions)" }',
    '$InstallRoot = if ($env:AGENTHARNESS_INSTALL_ROOT) { $env:AGENTHARNESS_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "agentharness" }',
    '$BinDir = if ($env:AGENTHARNESS_BIN_DIR) { $env:AGENTHARNESS_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "agentharness\\bin" }',
    '$VersionsDir = Join-Path $InstallRoot "versions"',
    '$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("agentharness-install-" + [Guid]::NewGuid().ToString("N"))',
    'New-Item -ItemType Directory -Path $TempDir | Out-Null',
    'try {',
    '  $ArchivePath = Join-Path $TempDir $Archive',
    '  Write-Host "Downloading AgentHarness $Version for win32-x64..."',
    `  Invoke-WebRequest -UseBasicParsing -Uri (${powershellLiteral(archiveBaseUrl + "/")} + $Archive) -OutFile $ArchivePath`,
    '  $ActualSha = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()',
    '  if ($ActualSha -ne $ExpectedSha) { throw "checksum mismatch for $Archive" }',
    '  $Members = & tar.exe -tzf $ArchivePath',
    '  if ($LASTEXITCODE -ne 0) { throw "could not inspect $Archive" }',
    '  foreach ($Member in $Members) {',
    '    $NormalizedMember = $Member.Replace("\\", "/")',
    '    if ($NormalizedMember.StartsWith("/") -or $NormalizedMember -match "^[A-Za-z]:" -or $NormalizedMember -match "(^|/)\.\.(/|$)") { throw "archive contains an unsafe path: $Member" }',
    '  }',
    '  $Payload = Join-Path $TempDir "payload"',
    '  New-Item -ItemType Directory -Path $Payload | Out-Null',
    '  & tar.exe -xzf $ArchivePath -C $Payload',
    '  if ($LASTEXITCODE -ne 0) { throw "could not extract $Archive" }',
    '  $NodePath = Join-Path $Payload "runtime\\node.exe"',
    '  $CommandEntry = Join-Path $Payload "agentharness.mjs"',
    '  foreach ($Required in @($NodePath, (Join-Path $Payload "start.mjs"), (Join-Path $Payload "mcp.mjs"), $CommandEntry, (Join-Path $Payload "agentharness-cluster.mjs"))) { if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) { throw "archive is missing $Required" } }',
    '  $Portable = Get-Content -LiteralPath (Join-Path $Payload "agentharness-portable.json") -Raw | ConvertFrom-Json',
    '  if ($Portable.product -ne "AgentHarness" -or $Portable.version -ne $Version -or $Portable.platform -ne "win32" -or $Portable.arch -ne "x64" -or $Portable.runtime.node -ne "runtime/node.exe") { throw "portable manifest does not match the selected release" }',
    ...renderPowerShellClusterSetup(clusterSecret).map(line => `  ${line}`),
    '  New-Item -ItemType Directory -Force -Path $VersionsDir, $BinDir | Out-Null',
    '  $ReleaseId = "$Version-win32-x64-$ExpectedSha"',
    '  $ReleaseDir = Join-Path $VersionsDir $ReleaseId',
    '  if (-not (Test-Path -LiteralPath $ReleaseDir)) { Move-Item -LiteralPath $Payload -Destination $ReleaseDir }',
    '  $Current = Join-Path $InstallRoot "current"',
    '  $CurrentNext = Join-Path $InstallRoot (".current-" + [Guid]::NewGuid().ToString("N"))',
    '  & cmd.exe /d /c "mklink /J `"$CurrentNext`" `"$ReleaseDir`"" | Out-Null',
    '  if ($LASTEXITCODE -ne 0) { throw "could not create the current-version junction" }',
    '  if (Test-Path -LiteralPath $Current) {',
    '    $CurrentItem = Get-Item -LiteralPath $Current -Force',
    '    if (-not ($CurrentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Current exists and is not a junction" }',
    '    Remove-Item -LiteralPath $Current -Force',
    '  }',
    '  Move-Item -LiteralPath $CurrentNext -Destination $Current',
    '  $CommandPath = Join-Path $BinDir "agentharness.cmd"',
    '  $Shim = "@echo off`r`nset `"AGENTHARNESS_ACTIVE_ROOT=$Current`"`r`n`"$Current\\runtime\\node.exe`" `"$Current\\agentharness.mjs`" %*`r`n"',
    '  [IO.File]::WriteAllText($CommandPath, $Shim, [Text.UTF8Encoding]::new($false))',
    '  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")',
    '  $PathParts = @($UserPath -split ";" | Where-Object { $_ })',
    '  if (-not ($PathParts | Where-Object { $_.TrimEnd("\\") -ieq $BinDir.TrimEnd("\\") })) { [Environment]::SetEnvironmentVariable("Path", (($PathParts + $BinDir) -join ";"), "User") }',
    '  if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\\") -ieq $BinDir.TrimEnd("\\") })) { $env:Path = "$BinDir;$env:Path" }',
    '  Write-Host "Installed AgentHarness $Version at $ReleaseDir"',
    '  Write-Host "Start: $CommandPath start`nStatus: $CommandPath status`nLogs: $CommandPath logs`nStop: $CommandPath stop"',
    '  if ($env:AGENTHARNESS_NO_START -ne "1") { & $CommandPath start; if ($LASTEXITCODE -ne 0) { throw "AgentHarness did not start" } } else { Write-Host "Automatic start skipped because AGENTHARNESS_NO_START=1." }',
    '  & $CommandPath mcp-setup',
    '  if ($LASTEXITCODE -ne 0) { throw "MCP setup failed" }',
    '} finally {',
    '  if (Test-Path -LiteralPath $TempDir) { Remove-Item -LiteralPath $TempDir -Recurse -Force }',
    '}',
    '',
  ].join('\n')
}

/** Parse release staging flags. */
export function parseStageArguments(args) {
  const artifacts = []
  let out = resolve(root, 'dist', 'agentharness-release')
  let baseUrl
  let clusterSecretFile
  let github = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument === '--') continue
    else if (argument === '--github') github = true
    else if (argument === '--artifact' && value !== undefined) { artifacts.push(resolve(value)); index += 1 }
    else if (argument === '--out' && value !== undefined) { out = resolve(value); index += 1 }
    else if (argument === '--base-url' && value !== undefined) { baseUrl = value; index += 1 }
    else if (argument === '--cluster-secret-file' && value !== undefined) { clusterSecretFile = resolve(value); index += 1 }
    else throw new Error(`unknown or incomplete argument ${JSON.stringify(argument)}`)
  }
  if (artifacts.length === 0) throw new Error('at least one --artifact is required')
  if (baseUrl === undefined) throw new Error('--base-url is required')
  return { artifacts, out, baseUrl, clusterSecretFile, github }
}

/** Stage a static release whose manifest declares whether installation embeds or prompts for a credential. */
export async function stagePortableRelease(options) {
  const output = validateStageOutput(options.out)
  const baseUrl = validateReleaseBaseUrl(options.baseUrl)
  if (options.github && (baseUrl.endsWith('.git') || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(baseUrl))) {
    throw new Error('--github requires an HTTPS GitHub repository URL without .git')
  }
  const clusterSecret = options.clusterSecret === undefined
    ? (options.clusterSecretFile === undefined
        ? undefined
        : validateClusterSecret((await readFile(options.clusterSecretFile, 'utf8')).replace(/[\r\n]+$/u, '')))
    : validateClusterSecret(options.clusterSecret)
  const cluster = clusterSecret === undefined ? undefined : describeClusterSecret(clusterSecret)
  const inspected = await Promise.all(options.artifacts.map(inspectPortableArchive))
  const versions = new Set(inspected.map(item => item.manifest.version))
  if (versions.size !== 1) throw new Error(`portable artifacts have different versions: ${[...versions].join(', ')}`)
  const version = inspected[0].manifest.version
  const artifacts = {}
  for (const item of inspected) {
    if (artifacts[item.target] !== undefined) throw new Error(`duplicate portable target ${item.target}`)
    artifacts[item.target] = {
      file: `agentharness-${item.target}.tgz`,
      sha256: item.sha256,
      size: item.size,
    }
  }
  await resetStageOutput(output)
  const versionDirectory = resolve(output, 'releases', version)
  await mkdir(versionDirectory, { recursive: true })
  for (const item of inspected) await cp(item.path, resolve(versionDirectory, artifacts[item.target].file))
  const credential = cluster === undefined
    ? { mode: 'prompt' }
    : { mode: 'embedded', cluster }
  const manifest = { formatVersion: 3, product: 'AgentHarness', version, credential, artifacts }
  await writeFile(resolve(versionDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const installers = {}
  if (Object.keys(artifacts).some(target => /^(?:darwin|linux)-/u.test(target))) {
    installers.shell = resolve(output, 'install.sh')
    await writeFile(installers.shell, renderInstallScript({ baseUrl, version, artifacts, clusterSecret, artifactBaseUrl: options.github ? `${baseUrl}/releases/download/v${version}` : undefined }), { mode: 0o755 })
  }
  if (artifacts['win32-x64'] !== undefined) {
    installers.powershell = resolve(output, 'install.ps1')
    await writeFile(installers.powershell, renderPowerShellInstallScript({ baseUrl, version, artifacts, clusterSecret, artifactBaseUrl: options.github ? `${baseUrl}/releases/download/v${version}` : undefined }))
  }
  return { output, baseUrl, version, credential, manifest, installers, installer: installers.shell ?? installers.powershell }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  stagePortableRelease(parseStageArguments(process.argv.slice(2))).then((result) => {
    const installers = [result.installers.shell === undefined ? undefined : `Shell installer: ${result.baseUrl}/install.sh`, result.installers.powershell === undefined ? undefined : `PowerShell installer: ${result.baseUrl}/install.ps1`].filter(Boolean)
    process.stdout.write(`AgentHarness release ${result.version}: ${result.output}\n${installers.join('\n')}\n`)
  }).catch((error) => {
    process.stderr.write(`agentharness-stage-portable-release: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
