# Junius

<p align="center">
  <img src="icon.svg" alt="Junius" width="128" height="128" />
</p>

**English** | [简体中文](README.zh-CN.md)

**Keep working in ChatGPT Chat after Work runs out.**

Junius is a finished Windows application and local MCP execution service for ChatGPT. It gives ChatGPT access to your local Workspace files, processes, background Jobs, Git, browser automation, Windows desktop interaction, and local Agent Skills.

## Install Junius

Junius supports **Windows only**.

Prerequisites:

- Node.js 20+ with npm/npx
- Python 3.10+

> **Security:** Junius is not an operating-system sandbox. Commands and processes launched through Junius run with the permissions of the Windows user that started Junius.

Install the local Junius application with PowerShell:

```powershell
irm 'https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1' | iex
```

This command installs and starts the **local Junius application**. Connecting ChatGPT through OpenAI Secure MCP Tunnel is a separate step described below.

The bootstrap URL currently tracks `main`. The bootstrap then selects the newest published non-draft GitHub Release, including prereleases, downloads `junius-windows.tgz` and `SHA256SUMS.txt`, verifies the package SHA-256, and runs the packaged installer. The checksum verifies the downloaded package against the checksum published in the same Release; it is an integrity check, not an independent signature or trust root.

The installer:

- installs Junius under `%LOCALAPPDATA%\Junius\app`;
- creates the application virtual environment from your existing Python;
- installs locked application dependencies;
- validates the installed runtime;
- creates `%LOCALAPPDATA%\Junius\bin\junius.cmd` and adds that bin directory to the current user's `PATH`;
- registers Junius for the current user's Windows logon;
- starts Junius immediately and waits for Host health.

Normal installation does not require administrator elevation.

### Verify the installation

Run:

```powershell
junius --help
irm http://127.0.0.1:8787/__junius/host-health
```

The bootstrap also adds the Junius bin directory to the PowerShell session that ran the install command, so `junius` is available immediately after installation.

A working installation returns JSON with:

- `ok: true`
- a non-empty `activeWorkerId`

That means the local Junius application is running. ChatGPT connectivity is not complete until the Secure MCP Tunnel and personal MCP connection are configured.

## Contents

- [Connect Junius to ChatGPT](#connect-junius-to-chatgpt)
- [First use](#first-use)
- [What Junius provides](#what-junius-provides)
- [MCP tool surface](#mcp-tool-surface)
- [Update](#update)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Supported scope](#supported-scope)
- [Development](#development)

## Connect Junius to ChatGPT

Junius keeps its MCP server on loopback. ChatGPT connects through **OpenAI Secure MCP Tunnel**.

1. Create or select a tunnel in OpenAI Platform tunnel settings.
2. Install and configure the current OpenAI `tunnel-client` on the same Windows machine.
3. Point the tunnel profile at the exact Junius MCP endpoint:

   ```text
   http://127.0.0.1:8787/mcp
   ```

4. Run `tunnel-client doctor`, then enable or check the tunnel health listener. The current client defaults to `127.0.0.1:8080`. Confirm:

   ```text
   /health?details=true
   ```

   reports both `live: true` and `ready: true`. Junius probes `127.0.0.1:18080` and `127.0.0.1:8080` by default. If your health listener is elsewhere, set `JUNIUS_TUNNEL_HEALTH_URL` to its full health URL.

5. Keep `tunnel-client run` running while you use Junius.
6. In ChatGPT, open **Plugins**, select the plus button, and add an MCP connection in Developer mode.
7. Choose **Tunnel** as the connection type and select the corresponding Secure MCP Tunnel.
8. Review the discovered Junius tools and create the personal connection.

Do **not** point the tunnel at bare `http://127.0.0.1:8787`. Only `/mcp` belongs on the tunnel. `/__junius/*` routes are local diagnostics.

Current OpenAI documentation:

- ChatGPT developer platform: https://developers.openai.com/chatgpt
- Plugins quickstart: https://developers.openai.com/plugins/quickstart
- Connect and test a plugin: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

### You are done when

The setup is complete when all four statements are true:

1. `http://127.0.0.1:8787/__junius/host-health` reports `ok: true`.
2. Tunnel health reports both `live: true` and `ready: true`.
3. ChatGPT discovers the Junius MCP tools.
4. A simple Junius tool call from ChatGPT succeeds against your machine.

## First use

Create a Workspace for the directory you want Junius to operate in:

```text
create_workspace(
  id = "weave",
  root_path = "C:\Projects\Weave"
)
```

Then use the same Workspace ID:

```text
run_command(
  workspace = "weave",
  executable = "git",
  args = ["status", "--short", "--branch"]
)
```

A Workspace is a stable ID plus a canonical local root path. It supplies the working directory for process execution and the root boundary for built-in file tools. It is **not** a process sandbox.

## What Junius provides

Junius is an execution service, not a second policy engine. ChatGPT and the user decide what should happen; Junius executes the selected local operation and reports the result.

Main capabilities:

- Workspace file inspection and mutation
- direct process execution and bounded command batching
- background Jobs for long-running work
- Git snapshot / stage-review / commit helpers
- local Agent Skills
- browser automation
- Windows desktop computer use
- persistent Junius prompt overrides
- installed-copy update checks and updates

The installed Junius Host listens on:

```text
http://127.0.0.1:8787
```

with:

```text
MCP:        /mcp
Health:     /__junius/host-health
Supervisor: /__junius/supervisor
```

There is no management Web UI.

## MCP tool surface

The current MCP surface is:

- Operating contracts: `load_junius_contracts`
- Prompt overrides: `get_junius_prompts`, `set_junius_prompt`, `reset_junius_prompt`
- Workspaces: `list_workspaces`, `create_workspace`, `delete_workspace`
- Workspace reads: `ls`, `read`, `rg`, `workspace_batch`
- Workspace mutations: `write_file`, `apply_patch`, `delete_file`, `move_file`, `copy_file`, `mkdir`, `workspace_mutate`
- Agent Skills: `list_skills`, `read_skill`, `install_skill`, `remove_skill`
- Processes: `run_command`, `run_commands`
- Jobs: `start_job`, `get_job`, `wait_job`, `read_job_output`, `cancel_job`
- Git: `git_snapshot`, `git_prepare_commit`, `git_commit`
- Installed-copy updates: `check_junius_update`, `update_junius`
- Computer use: `playwright_cli`, `desktop`
- Turn / observability plumbing: `junius_turn_begin`, `junius_turn_end`, `junius_observability_panel`, `close_junius_test_window`

The source-tree test connection does not expose installed-copy update tools.

For behavior, arguments, routing, persistence, Worker affinity, audit, Computer Use internals, and prompt lifecycle, see [docs/architecture.md](docs/architecture.md).

## Update

From an installed Junius CLI:

```powershell
junius update --check
junius update
junius restart
```

ChatGPT can also use `check_junius_update` and `update_junius` against an installed copy. An MCP self-update returns `restartRequired: true` rather than terminating its own active tool call; restart Junius outside that active call.

Re-running the PowerShell installer is also a supported in-place update path.

## Uninstall

Junius does not currently have a dedicated uninstall command. To remove the installed copy and its per-user local state:

```powershell
$health = Invoke-RestMethod http://127.0.0.1:8787/__junius/host-health -ErrorAction SilentlyContinue
if ($health.pid) { taskkill /PID $health.pid /T /F | Out-Null }

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Junius /f

$juniusBin = "$env:LOCALAPPDATA\Junius\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$userPath = (($userPath -split ";") | Where-Object {
  $_.Trim().TrimEnd([char]92) -ine $juniusBin.TrimEnd([char]92)
}) -join ";"
[Environment]::SetEnvironmentVariable("Path", $userPath, "User")

Remove-Item "$env:LOCALAPPDATA\Junius" -Recurse -Force
```

This removes the installed application, startup registration, Workspace registration, prompt overrides, and other Junius state stored under `%LOCALAPPDATA%\Junius`.

Your project directories and files registered as Workspaces are not deleted.

## Troubleshooting

**Port 8787 is already in use**

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

Stop or reconfigure the conflicting process before starting Junius.

**`junius` is not recognized**

Re-run the installer. A current installation creates `%LOCALAPPDATA%\Junius\bin\junius.cmd`, adds that directory to the user `PATH`, and makes it available in the invoking PowerShell session.

**Python is not found**

```powershell
python --version
py -0p
```

Junius requires an existing Python 3.10+ installation; the installer does not download Python.

**Junius is installed but the tunnel is not ready**

Run `tunnel-client doctor` and check the configured health listener directly. It must report both `live: true` and `ready: true`. If the listener is not on `127.0.0.1:18080` or `127.0.0.1:8080`, set `JUNIUS_TUNNEL_HEALTH_URL`.

**ChatGPT does not discover tools**

Confirm the tunnel targets exactly `http://127.0.0.1:8787/mcp`, the tunnel is ready, Developer mode is enabled for the account/workspace, and then reconnect the personal MCP connection.

**Junius needs a restart**

```powershell
junius restart
```

## Supported scope

Junius is a **Windows-only personal/local MCP product** for **ChatGPT Plus and higher**. Free and Go are not supported target tiers.

Junius is intentionally not a public-directory plugin. GitHub Releases distribute the local application; each user creates their own machine-specific Secure MCP Tunnel and personal ChatGPT MCP connection.

<a href="https://www.producthunt.com/products/junius?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-junius" target="_blank" rel="noopener noreferrer"><img alt="Junius - Keep working in ChatGPT Chat after Work runs out | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1270641&amp;theme=neutral&amp;t=1791214371048"></a>

## Development

Repository development uses pnpm 12.6.0:

```powershell
pnpm install
pnpm dev
```

`pnpm dev` starts the contributor-only source test instance on `127.0.0.1:18787`. Installed Junius remains the normal application on `127.0.0.1:8787`.

Run project validation with:

```powershell
pnpm run check
```

Release/distribution validation:

```powershell
pnpm run check:release
```

Implementation and maintainer details belong in [docs/architecture.md](docs/architecture.md), not in this getting-started README.

## Project docs

- [Architecture](docs/architecture.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE)

## License

[ISC](LICENSE).
