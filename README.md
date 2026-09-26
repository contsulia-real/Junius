# Junius

Architecture: [docs/architecture.md](docs/architecture.md)

Junius is a Local Agent that lets ChatGPT use local-computer capabilities through MCP under user-controlled authorization.

Its scope is broader than command execution: local files, processes, jobs, and browser automation are Local Agent capabilities. Authorization, Workspaces, and capability policies are implementation mechanisms of the Local Agent, not the product definition.

Junius's user-facing management interface is a local WebUI rather than a desktop Dashboard. This Dashboard choice is separate from any future decision about desktop-automation capabilities.

The current implementation does not provide an OS security sandbox.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client`
- `playwright-cli` / `@playwright/cli` for browser capability

## Run

```powershell
pnpm install
pnpm check
pnpm dev
```

Default local endpoints:

- MCP: `http://127.0.0.1:8787/mcp`
- Local WebUI Dashboard: `http://127.0.0.1:8788/`
- Local admin state API: `http://127.0.0.1:8788/state`

Optional environment variables:

- `JUNIUS_MCP_PORT`
- `JUNIUS_ADMIN_PORT`
- `JUNIUS_WORKSPACE_ID`
- `JUNIUS_WORKSPACE_ROOT`
- `JUNIUS_WORKSPACE_STATE_PATH`
- `JUNIUS_PLAYWRIGHT_CLI_PATH`
- `JUNIUS_BROWSER_STATE_PATH`

The Secure MCP Tunnel routes only the MCP endpoint. The admin surface remains local.

## Execution model

Junius exposes stable MCP tools:

```text
list_workspaces()
ls
read
write
rg
playwright_cli
start_job
get_job
wait_job
read_job_output
cancel_job
run_command(workspace, key, args)
```

The execution path is:

```text
ChatGPT
  -> list_workspaces when project resolution is needed
  -> run_command(workspace, key, args)
  -> WorkspaceManager lookup by stable Workspace ID
  -> that Workspace's argument grant
  -> Machine Capability Registry
  -> machine capability argument policy
  -> ProcessCapability
  -> spawn(executable, args, { shell: false, cwd: Workspace })
```

There is no global active Workspace. Multiple Workspaces can execute concurrently.

A Workspace grant and the machine capability policy are both required. The effective permission is their intersection.

A Workspace ID is not a filesystem path. The model cannot provide an executable path or a raw shell command line.

## Security boundary

Junius does **not** provide filesystem, network, registry, UI, token, or process-tree isolation.

An authorized executable runs with the permissions of the Junius process. It can access anything the operating-system user account can access unless the executable itself applies additional restrictions.

The current process adapter:

- uses a registry-owned executable path;
- passes arguments as a vector with `shell: false`;
- starts the process with the selected Workspace as `cwd`;
- enforces machine-level argument policy;
- enforces per-Workspace argument grants before launch;
- applies timeout and captured-output limits.

It also inherits the Junius host environment. Therefore an authorized project script can observe environment variables available to Junius.

Timeout termination currently targets the directly spawned process only. Junius does not claim process-tree containment.

The `Workspace` concept is therefore an authorization/routing boundary, not an OS access-control boundary.

## Capabilities

### node

The built-in `node` capability currently permits only:

```text
["--version"]
["-p", "process.platform"]
```

### pnpm

Junius registers a `pnpm` capability when it can resolve a usable pnpm launcher.

Machine-level pnpm policy permits:

```text
["--version"]
["run", "<script>"]
["run", "<script>", "--", ...scriptArgs]
```

It does not expose `install`, `add`, `exec`, or `dlx`.

pnpm runs directly in the selected Workspace. Junius does not add `--dir` indirection or a sandbox portal.

## Workspace discovery

`list_workspaces()` returns registered Workspace IDs, canonical roots, and each Workspace's capability grants.

When the user names a project rather than an internal Workspace ID, ChatGPT should use `list_workspaces` first and then call `run_command` with the resolved Workspace ID.

## Per-Workspace argument grants

A grant is argument-scoped rather than a simple boolean.

Example:

```text
default:
  pnpm --version
  pnpm run check

weave:
  pnpm --version
  pnpm run typecheck
```

Even though the machine-level pnpm capability understands `run <script>`, `weave` cannot run `pnpm run check` unless that argument shape is explicitly granted to `weave`.

Grant rules support:

- `exact`: the complete argument vector must match.
- `prefix`: the configured prefix must match; trailing arguments are permitted.

A Workspace grant can only narrow a machine capability. It cannot expand the machine-level argument policy.

## Local admin

Inspect all registered Workspaces and machine capabilities:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state |
  ConvertTo-Json -Depth 20
```

Register a Workspace:

```powershell
$body = @{
  id = "weave"
  rootPath = "C:\\Users\\Why23\\RustroverProjects\\Weave"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  http://127.0.0.1:8788/workspaces
```

Grant selected pnpm arguments:

```powershell
$body = @{
  arguments = @(
    @{ mode = "exact"; args = @("--version") }
    @{ mode = "exact"; args = @("run", "typecheck") }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  http://127.0.0.1:8788/workspaces/weave/grants/pnpm
```

Revoke one capability grant:

```powershell
Invoke-RestMethod -Method Delete `
  http://127.0.0.1:8788/workspaces/weave/grants/pnpm
```

Remove a Workspace:

```powershell
Invoke-RestMethod -Method Delete `
  http://127.0.0.1:8788/workspaces/weave
```

The local admin API is the backend for the planned Junius WebUI. The WebUI will remain local-only and will not be exposed through the Secure MCP Tunnel.

## Workspace state persistence

Workspace registration and per-Workspace grants are persisted outside the repository.

Default Windows location:

```text
%LOCALAPPDATA%\Junius\workspace-state.json
```

Override it with:

```text
JUNIUS_WORKSPACE_STATE_PATH
```

The state file is internal, versioned Junius state rather than a public configuration contract.

Current shape:

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "example",
      "rootPath": "C:\\path\\to\\project",
      "grants": []
    }
  ]
}
```

Startup behavior:

- If the state file exists, Junius restores Workspace IDs, roots, and grants.
- If it does not exist, Junius creates the configured initial Workspace and writes the first state file.
- An invalid existing state file fails startup rather than silently discarding authorization state.
- Workspace registration/removal and grant changes are written immediately.
- Writes are serialized so concurrent admin changes do not race.

## Current direction

Junius remains a general Local Agent. The current file/process tools are the first local capabilities, not the boundary of the product.

The local WebUI Dashboard v1 is implemented and locally validated.

The next work should focus on:

- persistent machine capability configuration;
- clearer authorization UX;
- broader Local Agent capability coverage where it provides concrete value.

OS-level sandboxing is not part of the current execution implementation.

## Verified end-to-end execution

The authorization-controlled direct execution path has been verified through ChatGPT against two registered Workspaces.

Observed black-box result:

- Junius Workspace: `pnpm run check` completed with exit code `0`; TypeScript checking and the project test suite completed successfully.
- Weave Workspace: `pnpm run typecheck` reached the project's TypeScript compiler and returned exit code `2` with a real project compilation diagnostic.

This verifies that Workspace discovery/routing, per-Workspace pnpm grants, direct `ProcessCapability` execution, working-directory selection, and stdout/stderr/exit-code propagation operate through the real MCP path.

The Weave compiler failure is project-level output, not a Junius execution-layer failure.



## Workspace file tools

Junius exposes four built-in Workspace file operations:

```text
ls
read
write
rg
```

- `ls` lists Workspace-relative directory entries with bounded recursion.
- `read` reads UTF-8 text files with optional line ranges.
- `write` directly creates, replaces, or exact-text edits UTF-8 files; no version token or prior `read` is required.
- `rg` searches with ripgrep using Junius-controlled arguments and a Workspace-scoped target.

The built-in file tools reject absolute paths, `..` traversal, and existing paths that canonicalize outside the registered Workspace. This is a boundary implemented by the file tools themselves; it does not turn `run_command` into a sandbox.

The `rg` tool requires a usable `rg` executable on the Junius process PATH.

## Verified Workspace file tools

The built-in Workspace file tools have passed real black-box ChatGPT validation.

Verified behavior:

- `ls` resolved the Junius project by name and listed its directory structure.
- `read` read `package.json` and returned the project's scripts.
- `rg` located all references to `WorkspaceFilesService` with file/position information.
- `write` created a new root-level text file without requiring a prior read, SHA, revision, or version token.
- `write` then performed an exact-text edit that changed only the requested line.
- The same natural-language workflow did not require the user to provide a Workspace ID, capability key, raw tool call, or filesystem path outside the project context.
- A request to read the parent directory of the registered Workspace was rejected by the built-in file-tool path boundary.
- Multi-Workspace command routing continued to work for Junius and Weave.

This validates the intended Local Agent interaction model for the first file/process capability set.



## Job Manager

Long-running local processes use the Job Manager instead of blocking `run_command`.

Stable MCP tools:

```text
start_job
get_job
wait_job
read_job_output
cancel_job
```

`start_job` uses the same Workspace capability and argument authorization as `run_command`. Only process-backed capabilities can be started as jobs.

A job keeps running in the Junius process until it exits or is cancelled. `get_job` returns current status, PID, exit information, and captured-output sizes. `wait_job` waits for up to 60 seconds per call. `read_job_output` reads stdout or stderr with an offset cursor.

Captured stdout and stderr are bounded to 4 Mi characters per stream. The job itself continues running if capture is truncated.

`cancel_job` performs best-effort termination. On Windows Junius invokes `taskkill.exe /T /F` directly with `shell: false` to terminate the target process tree. Other platforms currently terminate the direct child with SIGTERM and then SIGKILL if necessary.

Job state is currently process-local. Restarting Junius clears the Job Manager registry; v1 does not attempt to reattach to processes from a previous Junius instance.

Job Manager v1 is implemented and black-box verified through ChatGPT.


## Verified Job Manager

Job Manager v1 has passed real black-box ChatGPT validation.

Observed workflow:

```text
natural-language request
-> start background Junius project check
-> inspect job status
-> read captured output
-> wait for completion
-> report final result
```

The verified job completed with status `succeeded` and exit code `0`. The background command executed the Junius full check:

```text
pnpm typecheck && pnpm test
```

The observed test run completed with 32 tests passed, 0 failed, 0 cancelled, and 0 skipped.

The black-box flow used the Job Manager path rather than waiting synchronously in `run_command`, and it did not modify project files, permissions, or configuration.


## Browser capability

Junius uses the locally installed `playwright-cli` as its browser execution layer. It does not reimplement Playwright through a second browser framework.

The MCP surface adds one thin tool:

```text
playwright_cli
```

The tool accepts a named browser session, one whitelisted `playwright-cli` command, and that command's validated arguments.

The current allowlist covers ordinary browser navigation and interaction:

```text
open
goto
snapshot
find
click
dblclick
fill
type
press
keydown
keyup
hover
select
check
uncheck
drag
dialog-accept
dialog-dismiss
resize
go-back
go-forward
reload
mousemove
mousedown
mouseup
mousewheel
tab-list
tab-new
tab-close
tab-select
close
```

Arbitrary JavaScript/code execution, storage mutation, CDP attachment, request interception, and arbitrary CLI commands are not exposed in this first version.

Browser sessions are independent of Workspaces. The default session is `junius`; callers may use other valid named sessions when concurrent browser state is needed.

`open` defaults to playwright-cli persistent and headed modes so the CLI-managed profile can keep its browser state across browser restarts while the local browser window remains visible. This profile is separate from ordinary Chrome/Edge user profiles.

The normal browser-task lifecycle is `open -> interact -> close`. ChatGPT should close the same named session before returning its final answer unless the user explicitly asks to leave the browser open. Closing the browser session does not discard the persistent profile or its login state.

`snapshot` is invoked through playwright-cli's raw-output mode so the snapshot YAML and element refs are returned directly through MCP rather than requiring Junius to read a generated snapshot file.

Junius runs playwright-cli with a dedicated local state working directory:

```text
%LOCALAPPDATA%\Junius\browser
```

On non-Windows systems it uses the equivalent XDG/local state directory. Override it with `JUNIUS_BROWSER_STATE_PATH`.

This keeps playwright-cli runtime artifacts such as generated snapshots outside registered project Workspaces.

Launcher discovery supports a native executable, the JavaScript entry point, and Windows npm-style `.cmd` shims that resolve to the real `playwright-cli.js` entry. `JUNIUS_PLAYWRIGHT_CLI_PATH` can explicitly provide the launcher/entry when automatic discovery is insufficient.

Browser capability v1 is implemented and black-box verified through ChatGPT.


## Verified Browser capability

Browser capability v1 has passed real black-box ChatGPT validation against the user's local `playwright-cli` installation.

Verified behavior:

- Junius resolved and used the local `playwright-cli` adapter through MCP.
- Browser activity opened in a visible headed local window.
- The browser used a named persistent CLI session/profile.
- ChatGPT could drive the browser through the allowed playwright-cli workflow.
- The browser session was closed when the requested browser task completed.
- Closing the session did not redefine the persistent profile as disposable state.

This validates the intended thin-adapter Local Agent model: Junius delegates browser automation to the mature local playwright-cli tool instead of reimplementing a second browser framework.


## Local WebUI Dashboard

Junius serves a local WebUI directly from the existing admin server:

```text
http://127.0.0.1:8788/
```

It requires no separate frontend build step and adds no frontend framework/runtime dependency.

Dashboard v1 contains:

- Overview: Workspace, process-capability, running-job, and browser status summaries.
- Workspaces: register and remove Workspace roots.
- Permissions: add/remove argument-scoped capability grant rules and revoke a Workspace capability grant.
- Capabilities: inspect currently registered machine-level process capabilities.
- Jobs: inspect runtime jobs, read captured stdout/stderr, and cancel running jobs.
- Browser: inspect local playwright-cli availability and its Junius state directory.

The WebUI uses the same Workspace manager, grant persistence, Job Manager, and PlaywrightCliService state as MCP/runtime code. It is not a parallel configuration system.

Existing admin routes remain compatible. `/api/state` is also available as an alias of `/state` for WebUI-style API access.

Dashboard v1 is implemented and locally validated.
