# Junius

Architecture: [docs/architecture.md](docs/architecture.md)

Junius is a Local Agent that lets ChatGPT use local-computer capabilities through MCP under user-controlled authorization.

Its scope is broader than command execution: local files, processes, jobs, browser automation, and Windows desktop computer use are Local Agent capabilities. Authorization, Workspaces, and capability policies are implementation mechanisms of the Local Agent, not the product definition.

Junius's user-facing management interface is a local WebUI rather than a desktop Dashboard. Desktop computer use is an independent Local Agent capability and is already implemented; it does not imply a desktop-native management UI.

The current implementation does not provide an OS security sandbox.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client`
- `playwright-cli` / `@playwright/cli` for browser capability
- Windows desktop capability: the project `.venv` with Python plus `pywinauto`, `PyAutoGUI`, Pillow, and Windows bindings

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
- `JUNIUS_MACHINE_CAPABILITY_STATE_PATH`
- `JUNIUS_BROWSER_STATE_PATH`
- `JUNIUS_DESKTOP_HELPER_PATH`

The Secure MCP Tunnel routes only the MCP endpoint. The admin surface remains local.

`pnpm dev` and `pnpm start` are manual lifecycle commands. They enter a tiny live launcher (`scripts/host-launcher.mjs`) that prefers the previously validated bootstrap copy at `.junius/runtime/bootstrap/host-bootstrap.mjs`; only when no validated bootstrap exists yet does it run the live `scripts/host-bootstrap.mjs`. The bootstrap then selects which validated Host release to launch. Junius does not autonomously start or restart its own MCP service. The Host owns the public MCP/admin ports and runs the mutable Local Agent implementation in supervised Worker processes. `pnpm start:direct` remains as a legacy/emergency direct entry and does not provide hot-swap or last-known-good startup protection.

## Host / Worker runtime

The public service no longer runs directly inside the mutable Agent process:

```text
ChatGPT / WebUI
  -> Junius Host (:8787 / :8788)
  -> active Worker (random localhost ports)
  -> MCP/admin implementation
```

The Host itself is not run under `tsx watch`. It watches Worker-side source changes and performs a guarded reload sequence:

```text
source change
-> pnpm run check
-> spawn candidate Worker
-> wait for ready IPC message
-> HTTP health check
-> atomically promote candidate
-> keep previous Worker during rollback/drain window
```

If source validation or candidate startup fails, the active Worker is unchanged. A newly promoted Worker that exits during the rollback window causes the Host to fall back to the previous live Worker. Existing MCP session IDs remain routed to their original retiring Worker. For modern sessionless MCP calls, the Host also keeps resource affinity for Job IDs, named browser sessions, and Desktop UIA refs so hot swaps do not move process-local state to the wrong Worker. Resource affinity is bounded: browser bindings expire after 10 minutes of inactivity, Desktop UIA-ref bindings expire after 5 minutes of inactivity, and Jobs remain pinned indefinitely while running. When a Worker reports that a Job reached a terminal state, its result/output affinity enters a 30-minute retention window that is extended by subsequent Job reads or queries. Retiring Workers are never reaped before the rollback window ends.

Host-only implementation files are deliberately not hot-applied. Editing them marks the Host as requiring a restart; it does not restart the Host automatically. A restart is performed only when the operator explicitly stops/starts Junius. On the next manual `pnpm dev` / `pnpm start`, the launcher first selects the validated bootstrap copy when available. The bootstrap fingerprints the Host/Worker source plus both launcher/bootstrap scripts, compares that fingerprint with the persisted validated release, and starts an unchanged validated release directly. Changed source is snapshotted, validated with `pnpm run check`, started on the real Host path, and promoted only after `/__junius/host-health` succeeds. A successful promotion atomically refreshes the validated bootstrap copy before advancing `.junius/runtime/current.json`; failed validation or candidate startup leaves both the previous bootstrap and previous last-known-good Host release intact. The newest three Host releases are retained under `.junius/runtime/releases`. Supervisor state is available locally at `/__junius/supervisor`, and health/supervisor responses expose the active `releaseId`. `package.json` and the tiny launcher remain the unavoidable manual-entry boundary for a `pnpm dev` command itself.

## Execution model

Junius exposes stable MCP tools:

```text
list_workspaces()
ls
read
write
workspace_apply
rg
workspace_batch
playwright_cli
desktop
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

Workspace-scoped process capabilities (`node`, `pnpm`, and `git`) require both a Workspace grant and the machine capability policy; the effective permission is their intersection. Browser and desktop are machine-scoped capabilities: they do not belong to a Workspace and are controlled by their persisted machine-level enablement plus runtime availability.

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

The built-in `node` capability resolves Node directly from the inherited `PATH` in normal command-search order. Junius does not infer a Node version from the executable path and does not fall back to the Node binary that happened to launch Junius when `PATH` has no Node.

The capability currently permits only:

```text
["--version"]
["-p", "process.platform"]
```

JavaScript-based pnpm and Playwright launchers use the same PATH-resolved Node executable, so changing the Node selected by `PATH` takes effect on the next Worker start without changing Junius configuration.

### pnpm

Junius registers a `pnpm` capability when it can resolve a usable pnpm command from the inherited `PATH`. On Windows, a PATH-resolved `pnpm.cmd` shim is inspected only to reach the target it itself declares; Junius does not scan `PNPM_HOME`, `npm_execpath`, Corepack directories, or neighboring install trees.

Machine-level pnpm policy permits:

```text
["--version"]
["run", "<script>"]
["run", "<script>", "--", ...scriptArgs]
```

It does not expose `install`, `add`, `exec`, or `dlx`.

pnpm runs directly in the selected Workspace. Junius does not add `--dir` indirection or a sandbox portal.

### git

Junius registers a `git` machine capability when it can resolve a usable Git executable from the inherited `PATH`, using normal command-search order and the first matching `git.exe`/`git`. It does not scan Program Files or use a separate Git-path fallback. Git is exposed through the existing `run_command(workspace, key, args)` path, not through a separate MCP tool.

The machine policy covers normal repository-development and synchronization operations:

```text
--version
init [-b <branch>]
status
add
commit -m <message>
config --get user.name/user.email
config --local user.name/user.email <value>
branch
remote
fetch
push [--force|--force-with-lease] [-u|--set-upstream] <remote> <branch>
rev-parse
diff
log
ls-files
```

The policy intentionally does not expose destructive forms such as `git clean`, `git reset --hard`, arbitrary Git aliases, mirror pushes, or remote branch deletion.

A Workspace must still explicitly grant the Git argument ranges it needs. Machine capability policy and Workspace grants remain an intersection.

For an explicit local-source-of-truth synchronization, Junius can authorize a flow such as:

```text
git init -b main
git add -A
git commit -m "..."
git remote add origin <url>
git push --force --set-upstream origin main
```

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
$state = Invoke-RestMethod http://127.0.0.1:8788/state
$state | ConvertTo-Json -Depth 20
```

Mutation requests require the current local admin token returned by `/state`. The browser WebUI adds it automatically. For direct PowerShell calls:

```powershell
$headers = @{
  "X-Junius-Admin-Token" = $state.adminToken
}
```

Register a Workspace:

```powershell
$body = @{
  id = "weave"
  rootPath = "C:\\Users\\Why23\\RustroverProjects\\Weave"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Headers $headers `
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
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body `
  http://127.0.0.1:8788/workspaces/weave/grants/pnpm
```

Revoke one capability grant:

```powershell
Invoke-RestMethod -Method Delete `
  -Headers $headers `
  http://127.0.0.1:8788/workspaces/weave/grants/pnpm
```

Remove a Workspace:

```powershell
Invoke-RestMethod -Method Delete `
  -Headers $headers `
  http://127.0.0.1:8788/workspaces/weave
```

The admin server validates its configured localhost Host header, rejects cross-origin mutation requests, requires the per-process admin token for mutations, and requires application/json for JSON request bodies. The WebUI remains local-only and is not exposed through the Secure MCP Tunnel.

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

Machine Capability v1 is implemented and locally validated.

Authorization UX v1 is implemented and locally validated.

Desktop Computer Use v1 is implemented and locally validated with UI Automation plus screenshot/mouse/keyboard fallback.

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
- `write` creates, replaces, or exact-text edits UTF-8 files through the transactional multi-file commit path; no version token or prior `read` is required.
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
pnpm check:bootstrap && pnpm typecheck && pnpm test
```

The current full check covers 100 tests across the validated launcher/bootstrap chain, manual last-known-good Host bootstrap, Host/Worker proxying, layered latency tracing, bounded hot-swap affinity, Job terminal IPC, PATH-based launcher resolution, read batching, transactional Workspace writes, persistent browser-broker transport, and Windows desktop-helper behavior. The real Desktop Python integration uses Junius's project-local `.venv`.

The black-box flow used the Job Manager path rather than waiting synchronously in `run_command`, and it did not modify project files, permissions, or configuration.


## Browser capability

Junius uses the locally installed `playwright-cli` as its browser execution layer. It does not reimplement Playwright through a second browser framework.

The MCP surface adds one thin tool:

```text
playwright_cli
```

The tool accepts a named browser session, one whitelisted `playwright-cli` command, and that command's validated arguments.

The current allowlist covers ordinary browser navigation and interaction, including navigation, snapshots, ref-based element actions, keyboard/mouse input, dialogs, tabs, and close. It intentionally does not expose arbitrary evaluation, CDP attachment, storage mutation, request interception, or arbitrary CLI commands.

Browser sessions are named, headed, and persistent by default. Runtime browser state lives in Junius's own state directory rather than a project Workspace or the user's normal browser profile. The `playwright-cli` command itself is discovered from inherited `PATH`; Junius does not use a separate executable override or scan package-manager installation trees.

For compatible `@playwright/cli` JavaScript installations, each Worker prewarms a persistent Node broker after the Worker becomes ready, without opening a browser window. The broker loads the installed CLI's own `program` client once and reuses it for later commands while the Playwright-managed browser daemon/session remains authoritative. Junius discovers the local CLI's actual program-module specifier from its installed entry file and resolves pnpm links through the entry's real path, so it follows the locally installed CLI version rather than hard-coding one Playwright internal path. Initialization incompatibility disables the broker for that Worker and Browser falls back to the existing one-process-per-command CLI transport. A broker that was already ready but later times out, crashes, exceeds its transport output limit, or suffers a pipe/protocol failure is treated as recoverable: the current command falls back to spawn and the next browser command can rebuild a fresh broker.

On the current Windows development machine, the verified broker path reduced repeated `snapshot` calls from roughly 0.36–0.60 s of local execution to 13–15 ms, and `tab-list` from roughly 0.40–0.65 s to 17 ms. Browser `open` still includes the cost of starting/navigating the headed browser and therefore remains much heavier than later commands.

Browser is machine-scoped. Its persisted `enabled` preference combines with runtime `available` state to produce `active`; it does not use Workspace grants. The Host keeps a named browser session on the Worker that owns it across hot swaps and releases that affinity when the session is closed. An otherwise-idle browser affinity also expires after 10 minutes; the Playwright named session itself remains managed by Playwright, while the Host stops pinning the retired Junius Worker.

## Latency tracing

For modern MCP calls, Junius assigns a Host trace ID and the Worker reports its own handler duration in response metadata. The Host keeps the newest 64 completed traces in memory and exposes them at `/__junius/supervisor`. Each trace includes the tool name, Worker ID, HTTP status, total Host-observed duration, Worker duration, and derived proxy/transport overhead. Tracing does not rewrite tool result bodies or force streaming responses into an additional buffering layer.

## Desktop Computer Use

Junius exposes Windows desktop automation through the stable `desktop` MCP tool.

The preferred path is semantic Windows UI Automation:

```text
windows -> inspect -> element refs -> invoke / set_value / focus
```

For games and custom-rendered interfaces where UI Automation is insufficient, Junius falls back to screenshots plus bounded mouse and keyboard actions.

Desktop element refs are scoped to a named desktop session and are rebuilt by `inspect`. Screenshots may target the full screen or one native window. When a window handle is supplied for a mouse action, coordinates are window-relative and must remain inside that window's rectangle.

Text input uses Windows Unicode `SendInput` events rather than `pyautogui.write`, so non-ASCII input is supported without relying on clipboard mutation.

The Python helper now runs as a persistent JSONL server inside each Worker. Desktop Computer Use is bound to Junius's project-local `.venv` (`.venv/Scripts/python.exe` on Windows) rather than an arbitrary Python discovered from `PATH`; the helper script itself is the Junius-owned `python/desktop_helper.py`. After a Worker becomes ready, Junius opportunistically prewarms both the Desktop helper and the Playwright broker in the background. This loads Python/`pywinauto`/PyAutoGUI and the Playwright CLI client before the first action while still leaving the headed browser itself lazy until an actual browser `open` command. If the Desktop helper times out, crashes, or violates its response protocol, Junius terminates it and the next request starts a clean helper process.

Desktop UIA refs remain Worker-local. The Host therefore binds a named desktop session to the Worker that performed `inspect`; a later `inspect` is the explicit migration boundary to the current active Worker.

Desktop is machine-scoped like browser. It has persisted `enabled`, runtime `available`, and derived `active` state and does not use Workspace grants.

## Workspace batching and transactional writes

`workspace_batch` executes up to 16 independent `ls`, `read`, and `rg` operations in one MCP round trip. The operations run concurrently, expected Workspace-file failures are isolated per operation, and per-result/aggregate response budgets prevent one batch from returning unbounded data. Each sub-operation and the whole batch report `durationMs` so Junius can distinguish local execution time from external MCP round-trip latency.

`write` now uses the same transactional multi-file commit path used by `workspace_apply`: all targets are resolved and read in parallel, duplicate targets and size limits are checked, complete next-file contents are prepared in memory, and same-directory temporary files are fully written before any target replacement starts. Immediately before replacement, Junius rechecks existing target contents so an IDE or another process cannot silently change a file between validation and commit.

During commit, existing targets are renamed to temporary backups and prepared files are renamed into place. If a later replacement fails, Junius walks the staged set in reverse and attempts to restore the backups and remove newly created targets. This is a best-effort application-level transaction; Junius does not claim the filesystem provides one atomic commit across multiple files.

`workspace_apply` combines that write phase with optional post-commit `ls`, `read`, and `rg` verification in the same MCP round trip. Verification operations are observational: their results are returned to the caller, but Junius does not infer success criteria or autonomously undo an otherwise successful commit.

