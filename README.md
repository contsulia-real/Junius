# Junius

**Local capabilities for ChatGPT over MCP.**

Junius is a local MCP capability service for ChatGPT chat. It exposes controlled access to local files, processes, background jobs, browser automation, and Windows desktop interaction while keeping authorization and execution on the user's machine.

ChatGPT provides the reasoning, planning, and conversational layer. Junius does not run its own autonomous agent loop: it provides the MCP tools, authorization model, local execution, process lifecycle, audit trail, and management surface that let ChatGPT act on the local environment.

> [!WARNING]
> Junius is **not an OS security sandbox**. An authorized executable runs with the permissions of the operating-system user that started Junius. Read the [Security boundary](#security-boundary) before granting capabilities to untrusted Workspaces.

Architecture: [docs/architecture.md](docs/architecture.md) · Security policy: [SECURITY.md](SECURITY.md)

## What it exposes

- Workspace-scoped file access with bounded `ls`, `read`, `write`, `rg`, and transactional batch operations.
- Explicitly authorized local process capabilities such as Node, pnpm, Git, and user-defined executables.
- Background Jobs with persisted history and Windows crash containment.
- Browser computer use through a bounded Playwright CLI adapter.
- Windows desktop computer use through screenshots plus bounded mouse and keyboard actions.
- A local-only WebUI for Workspaces, capabilities, Jobs, Audit, Browser, and Desktop state.

Junius is currently developed and fully validated on Windows. Some process/file/browser paths are portable, but Windows desktop control and Windows Job Object crash containment are platform-specific.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client` for connecting the local MCP endpoint to ChatGPT
- `playwright-cli` / `@playwright/cli` for the Browser capability
- Optional Windows Desktop capability: Python with the packages in [requirements-desktop.txt](requirements-desktop.txt)

## Quick start

```powershell
git clone https://github.com/contsulia-real/Junius.git
cd Junius
pnpm install
pnpm run check
pnpm dev
```

For Windows Desktop computer use:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-desktop.txt
```

Default local endpoints:

- MCP: `http://127.0.0.1:8787/mcp`
- Local WebUI: `http://127.0.0.1:8788/`
- Local admin state: `http://127.0.0.1:8788/state`

To use Junius from ChatGPT, route only the MCP endpoint through OpenAI Secure MCP Tunnel (`tunnel-client`) and point the tunnel at `http://127.0.0.1:8787/mcp`. The management WebUI and admin API remain loopback-only and are not routed through the tunnel.

Optional environment variables:

- `JUNIUS_MCP_PORT`
- `JUNIUS_ADMIN_PORT`
- `JUNIUS_WORKSPACE_ID`
- `JUNIUS_WORKSPACE_ROOT`
- `JUNIUS_WORKSPACE_STATE_PATH`
- `JUNIUS_MACHINE_CAPABILITY_STATE_PATH`
- `JUNIUS_BROWSER_STATE_PATH`
- `JUNIUS_DESKTOP_HELPER_PATH`
- `JUNIUS_AUDIT_PATH`
- `JUNIUS_AUDIT_MAX_ENTRIES`
- `JUNIUS_AUDIT_MAX_AGE_MS`

`pnpm dev` and `pnpm start` are manual lifecycle commands. They enter a tiny live launcher (`scripts/host-launcher.mjs`) that prefers the previously validated bootstrap copy at `.junius/runtime/bootstrap/host-bootstrap.mjs`; only when no validated bootstrap exists yet does it run the live `scripts/host-bootstrap.mjs`. The bootstrap then selects which validated Host release to launch. Junius does not autonomously start or restart its own MCP service. The Host owns the public MCP/admin ports and runs the mutable capability-service implementation in supervised Worker processes. `pnpm start:direct` remains as a legacy/emergency direct entry and does not provide hot-swap or last-known-good startup protection. Its MCP HTTP entry still enforces the same exact loopback Host/Origin request guard as the supervised Host, so the emergency path does not bypass localhost browser-request protection.

## Host / Worker runtime

The public service no longer runs directly inside the mutable Worker implementation:

```text
ChatGPT / WebUI
  -> Junius Host (:8787 / :8788)
  -> active Worker (random localhost ports, per-Worker private token)
  -> MCP/admin implementation
```

Each Worker gets a fresh 256-bit internal token at spawn time. The Host strips any client-supplied internal-token header and injects the correct token when proxying to the Worker. Private Worker MCP, admin, and health endpoints reject requests without that token, so random Worker ports cannot be used to bypass the Host boundary.

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

If source validation or candidate startup fails, the active Worker is unchanged. Full source validation uses independent pending transaction files keyed to each check invocation, so a Host-triggered validation and a manual `pnpm run check` can overlap without overwriting or deleting each other's begin state. A transaction still refuses to commit if the source fingerprint or runtime environment stamp changed after its own begin. A newly promoted Worker that exits during the rollback window causes the Host to fall back to the previous live Worker. Existing MCP session IDs remain routed to their owning Worker while their Host route is active; those routes have a 30-minute idle TTL, refreshed by requests, so abandoned MCP sessions cannot pin routing state forever. For modern sessionless MCP calls, the Host keeps resource affinity for Job IDs, named browser sessions, and active Desktop control sessions so hot swaps do not move process-local state to the wrong Worker. A successful Desktop `control_begin` binds `desktop:<session>` to the Worker that created the helper-side takeover scope; all later Desktop calls for that session stay on that Worker across promotion, and a successful `control_end` releases the binding. Desktop control bindings do not use an idle TTL because their lifetime is explicit; Worker exit removes the binding as the crash fallback. Resource affinity remains bounded elsewhere: browser bindings expire after 10 minutes of inactivity, and Jobs remain pinned indefinitely while running. When a Worker reports that a Job reached a terminal state, its result/output affinity first enters a 30-minute fallback retention window. After that Worker confirms the terminal history was persisted successfully, the Host releases the Job affinity immediately so later reads can route to any active Worker and lazy-load the shared history. Unbound terminal/persisted Job race hints also expire after the same 30-minute fallback window. Retiring Workers are never reaped before the rollback window ends, and only the newest 16 exited Worker records are retained for diagnostics.

Admin configuration mutations are synchronized across every live Worker before the public admin response is allowed to succeed. The Worker that handled the mutation persists the new Workspace or machine-capability state first; the Host then asks every other active/retiring Worker to reload that shared state through a private authenticated endpoint. A Worker that cannot reload is quarantined and removed from routing instead of continuing with stale authorization. Configuration changes racing with candidate startup advance a Host-side epoch; a candidate that may have loaded an older snapshot is refreshed to the latest epoch before promotion. This keeps old MCP sessions and Browser/Desktop affinity routes subject to current grants and machine-level enablement.

Host-only implementation files are deliberately not hot-applied. Editing them marks the Host as requiring a restart; it does not restart the Host automatically. A restart is performed only when the operator explicitly stops/starts Junius. On the next manual `pnpm dev` / `pnpm start`, the launcher first selects the validated bootstrap copy when available. The bootstrap fingerprints the Host/Worker source plus its startup-control scripts, compares that fingerprint with the persisted validated release, and starts an unchanged validated release directly. A successful full `pnpm run check` records the exact source fingerprint, Node version, platform, and architecture. When changed source is later restarted with that same already-validated fingerprint, bootstrap reuses the full-check result instead of rerunning the test suite; otherwise it runs `pnpm run check` normally. In either case the source is snapshotted, fingerprint stability is rechecked, the candidate is started on the real Host path, and promotion still requires `/__junius/host-health` to succeed. A successful promotion atomically refreshes the validated bootstrap copy before advancing `.junius/runtime/current.json`; failed validation or candidate startup leaves both the previous bootstrap and previous last-known-good Host release intact. The newest three Host releases are retained under `.junius/runtime/releases`. Supervisor state is available locally at `/__junius/supervisor`, and health/supervisor responses expose the active `releaseId`. `package.json` and the tiny launcher remain the unavoidable manual-entry boundary for a `pnpm dev` command itself.

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

Workspace-scoped process capabilities (`node`, `pnpm`, `git`, and user-defined custom process capabilities) require both a Workspace grant and the machine capability policy; the effective permission is their intersection. Browser and desktop are machine-scoped capabilities: they do not belong to a Workspace and are controlled by their persisted machine-level enablement plus runtime availability.

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

Git receives an additional repository preflight before both synchronous execution and background Job startup. Junius requires repository metadata to be self-contained under the selected Workspace root, rejects `.git` symlink/junction/worktree indirection outside that root, rejects repository-local executable/config-extension settings such as credential helpers, SSH command overrides, filters, and includes, and validates configured fetch/push remote URLs before network operations. Git system/global config and system attributes are disabled during repository operations, inherited `GIT_*` variables and `SSH_ASKPASS*` are stripped case-insensitively, and Junius then injects only its own non-interactive Git environment. The only global Git values imported separately are `user.name` and `user.email`; repository-local identity still takes precedence.

Workspace reads reject links that resolve outside the Workspace. Workspace writes also reject symbolic/junction parent aliases even when they ultimately resolve back inside the Workspace, and transactional commits revalidate the write parent immediately before installation to narrow path-replacement races. The root `.junius/` control directory and `.git` metadata at any depth are reserved from Workspace file tools; Git metadata is accessed only through the Git capability. Production also protects the effective Junius runtime root, Workspace-state file, machine-capability-state file, and Browser state/profile root when any of those configured paths fall inside a registered Workspace; `ls` hides them and `rg` excludes them before scanning. User-supplied `rg` globs are applied before Junius protection globs, so later user include rules cannot re-enable `.junius`, `.git`, or other protected paths.

It also inherits the Junius host environment. Therefore an authorized project script can observe environment variables available to Junius.

`pnpm run <script>` is explicitly an authorization to execute the Workspace's own package-script code. Junius constrains the pnpm command shape and script name, but it does not sandbox or freeze the contents of that script. A Workspace whose package scripts can be modified should therefore be treated as executable code, not as passive data.

Synchronous ProcessCapability timeout and output-limit termination share the same process-termination primitive as Job Manager. On Windows, Junius invokes `%SystemRoot%\\System32\\taskkill.exe /PID <pid> /T /F` directly with `shell: false`, so the spawned process tree is terminated before the synchronous call returns. Other platforms currently use direct-child SIGTERM followed by SIGKILL fallback.

The `Workspace` concept is therefore an authorization/routing boundary, not an OS access-control boundary.

The public MCP listener is intentionally loopback-only and rejects hostile `Host` values, any present non-local browser `Origin`, and browser requests marked `Sec-Fetch-Site: cross-site` or `same-site`. Non-browser local clients may omit `Origin`; therefore processes already running on the same operating-system account are part of Junius's local trust boundary. Secure MCP Tunnel supplies the OpenAI-side private transport/authentication boundary, but Junius does not currently require an additional application-level bearer token on the loopback MCP endpoint. Sessionless and sessionful MCP request bodies are both capped at 16 MiB at the Host; the sessionful path enforces this while streaming rather than buffering the entire request.

## Capabilities

### custom process capabilities

The local WebUI can create, edit, enable/disable, and delete user-defined Workspace-scoped process capabilities. A custom definition owns a stable key, description, absolute executable path, optional fixed argument vector, machine-level exact/prefix argument rules, environment policy, timeout, and output limit. The executable is always launched directly with `shell: false`; Junius never accepts a raw shell command string. Prefix rules must contain at least one argument. The WebUI can discover candidate executables from the Host's inherited `PATH`, but it does not expose arbitrary filesystem browsing; manual absolute paths remain supported.

A custom capability is only `available` when its configured absolute executable currently exists as a file. It becomes `active` only when it is enabled and available, at which point it is registered in the live Capability Registry. Every Workspace still requires an explicit grant for that key, and each Workspace rule must be a subset of the custom machine policy. Environment inheritance is independently bounded: new definitions default to inheriting no Host variables, and may opt into all variables or a case-insensitive allowlist, then remove inherited names/prefixes and apply explicit overrides. Explicit values are passed directly to the child process and are never shell-expanded. Custom capabilities can also control how their argument vector is represented in Audit: record all arguments, redact the entire vector, or redact selected zero-based indexes. This affects only Audit representation, not authorization or execution. Deleting a custom capability unregisters it and removes its machine definition, but existing Workspace grants are intentionally retained as invalid historical rules so they can be reviewed or removed explicitly.

Machine capability state files written by current Junius use version 3. Version 1 enablement-only files and version 2 custom-capability files are read transparently and are upgraded on the next save. Version 2 custom definitions retain their historical inherit-all environment behavior during migration; newly created version 3 definitions default to no inherited environment.

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
["typecheck"]
["lint"]
["test"]
["build"]
["install", ...allowedArgs]
["update", ...packagesAndOptions]
["self-update", optionalVersion]
["add", packageOrOption, ...packagesAndOptions]
["run", "<script>"]
["run", "<script>", "--", ...scriptArgs]
```

`install`, `update`, and `add` reject explicit global-package, working-directory, external state/configuration path, and broader-workspace selector forms such as `--global`, `--dir`, `--lockfile-dir`, `--store-dir`, `--state-dir`, `--userconfig`, `--filter`, and recursive/workspace-root selectors. `add` requires at least one following package/option token. `self-update` accepts either no version or one explicit version/tag. Arbitrary execution commands such as `exec` and `dlx` remain unavailable.

pnpm runs directly in the selected Workspace. Junius does not add `--dir` indirection or a sandbox portal. The package-script body remains trusted Workspace code; the argument policy does not claim to sandbox what that script itself executes.

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

Before a repository command is prepared, the Git capability also performs a repository-local safety preflight. Git metadata must be self-contained under the Workspace root rather than borrowed from a parent repository or redirected through a `.git` symlink/worktree file. Local Git config is restricted to a small non-executable whitelist covering core repository metadata, user identity, remote URLs/refspecs, and branch tracking. Repository-local executable configuration such as credential helpers, SSH commands, filters, diff/textconv commands, includes, or other unrecognized keys is rejected. `fetch`/`push` additionally require the selected repository-local remote URL to use the bounded HTTP(S)/SSH forms accepted by Junius. Git system/global config and system attributes are disabled during repository operations, inherited `GIT_*` and `SSH_ASKPASS*` injection variables are stripped case-insensitively, and Junius then injects its own non-interactive Git environment. Global `user.name` / `user.email` are resolved separately as safe identity-only fallbacks, while repository-local identity overrides them. On Windows, HTTP(S) fetch/push uses Git's OpenSSL backend to avoid Schannel revocation-service availability becoming a hard dependency. Git Credential Manager is enabled only when the selected Git installation contains its executable, remains non-interactive, and is injected by Junius rather than accepted from repository/global config. Git is launched with `--no-pager`, hooks redirected to Junius's disabled-hooks directory, and commit signing disabled for this capability.

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
  rootPath = "C:\\Projects\\Weave"
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

The admin server validates its configured localhost Host header, rejects cross-origin mutation requests, requires the per-process admin token for mutations, and requires application/json for JSON request bodies. Admin responses are `no-store`, `nosniff`, deny framing/referrers, and use a restrictive same-origin CSP. `/api/state` omits the mutation token; only same-origin WebUI state at `/state` carries it. The WebUI remains local-only and is not exposed through the Secure MCP Tunnel.

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

Junius remains a general local MCP capability service. The current file/process tools are part of the capability surface, not the boundary of the project.

The local WebUI Dashboard v1 is implemented and locally validated.

Machine Capability v1 is implemented and locally validated.

Authorization UX v1 is implemented and locally validated.

Desktop Computer Use v1 is implemented and locally validated with screenshot-based perception plus bounded mouse/keyboard control.

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

The built-in file tools reject absolute paths, `..` traversal, and existing paths that canonicalize outside the registered Workspace. Reads may follow a link only when its canonical target remains inside the Workspace. Writes do not traverse symbolic-link/junction parent aliases at all: new/existing write parents are canonicalized after directory creation and revalidated again immediately before transactional commit. This narrows filesystem TOCTOU/link-escape windows without claiming OS-level `openat`/handle-based atomic path confinement. This is a boundary implemented by the file tools themselves; it does not turn `run_command` into a sandbox.

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

This validates the intended ChatGPT-to-Junius MCP interaction model for the first file/process capability set.



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

A job keeps running under the Worker that created it until it exits or is cancelled. `get_job` returns current status, payload PID, exit information, and captured-output sizes. `wait_job` waits for up to 60 seconds per call. `read_job_output` reads stdout or stderr with an offset cursor. On Windows, `start_job` does not return until a Junius guardian has established a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object and confirmed that the payload is contained by it.

Captured stdout and stderr are bounded to 4 Mi characters per stream. The job itself continues running if capture is truncated.

`cancel_job` performs best-effort termination. On Windows Junius invokes `taskkill.exe /T /F` directly with `shell: false` to terminate the target process tree. Other platforms currently terminate the direct child with SIGTERM and then SIGKILL if necessary.

Running Job control remains process-local and Junius deliberately does not reattach to a naked PID after Worker/Host loss. Before payload launch, Job Manager persists a small owner-scoped running marker. On Windows, a separate guardian owns the kill-on-close Job Object and monitors both the Worker and Host process handles; loss of either causes the guardian to close the Job Object and Windows terminates the contained payload tree. When a Worker exits, the Host synchronously converts only that Worker's remaining markers to terminal `interrupted` records before releasing its routing affinity. On full Host startup, any markers left by the previous Host instance are recovered before the first Worker starts. This records `message: worker_or_host_lost` without guessing that a reused PID still belongs to the old Job.

Terminal Job history is persisted by default under `.junius/runtime/jobs/<job-id>/` (or under `<JUNIUS_RUNTIME_ROOT>/jobs/<job-id>/` when the runtime root is overridden) with separate `meta.json`, `stdout.txt`, and `stderr.txt` files. A later Worker or manually restarted Junius instance can still `get_job`, `wait_job`, `read_job_output`, list, or idempotently `cancel_job` for completed, cancelled, failed, or interrupted historical Jobs. Normal Worker shutdown still cancels running Jobs and waits for terminal history to flush before exit. History retention is opt-in: by default Junius does not automatically delete terminal history. `JUNIUS_JOB_HISTORY_MAX_ENTRIES` and `JUNIUS_JOB_HISTORY_MAX_AGE_MS` enable explicit count/age pruning; Admin `/state` and the WebUI expose the current entry count, captured-output size, and active retention policy. The hot metadata cache is bounded to 256 entries so unlimited on-disk history does not become unlimited resident memory.

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
node scripts/source-validation.mjs begin && pnpm check:bootstrap && pnpm typecheck && pnpm test && node scripts/source-validation.mjs commit
```

The current full check covers the validated launcher/bootstrap chain, manual last-known-good Host bootstrap, Host/Worker proxying, layered latency tracing, bounded hot-swap affinity, Job terminal IPC, owner-scoped interrupted recovery, Windows Job Object crash containment, persistent terminal history, Windows process-tree termination, PATH-based launcher resolution, read batching, transactional Workspace writes, persistent browser-broker transport, concurrent source-validation transactions, Workspace root canonicalization, and screenshot-only Windows desktop-helper behavior. The real Desktop Python integration uses Junius's project-local `.venv`.

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

Browser is machine-scoped. Its persisted `enabled` preference combines with runtime `available` state to produce `active`; it does not use Workspace grants. The Host keeps a named browser session on the Worker that owns it across hot swaps and releases that affinity when the session is closed. Browser lifecycle is bounded at both layers: Host affinity expires after 10 idle minutes, while each Worker also tracks at most 32 named browser sessions and automatically executes `close` after 10 idle minutes. Activity refreshes the Worker timer, in-flight commands are never closed mid-command, and Worker shutdown waits for pending session cleanup. Disabling the Browser machine capability rejects new Browser work immediately, closes idle tracked sessions during the disable operation, and closes any session that was already in-flight as soon as that command finishes; re-enabling remains supported. The WebUI exposes current session count, idle TTL, limit, and any cleanup error. Closing or idle-expiring a session intentionally preserves playwright-cli's persistent profile data, including login state; Junius does not automatically delete those profiles.

## Activity Audit

Junius keeps a unified, bounded local activity history for user-visible execution and configuration changes. The WebUI exposes this as **活动记录**, with local filtering by Workspace, category, status, and free-text search across operation/object/summary/metadata fields. Each event stays compact by default and can be expanded to inspect its event ID, timestamp, scope, duration, and already-sanitized metadata. Audit currently covers synchronous capability execution, Job start/terminal/cancel, Workspace writes and `workspace_apply`, Browser and Desktop MCP actions, Workspace registration/removal, grant changes, and machine-capability create/edit/remove/enable/disable.

Audit is observational and best-effort: recording is not part of authorization and an Audit persistence failure does not fail or roll back the user operation. Each Worker appends independent event files into the shared Audit directory rather than rewriting one shared log, so active and retiring Workers can safely record during hot swaps. Recent events are also kept in bounded memory for immediate visibility. By default Junius retains at most 1000 events for at most 7 days; `JUNIUS_AUDIT_MAX_ENTRIES` and `JUNIUS_AUDIT_MAX_AGE_MS` override those limits, while `JUNIUS_AUDIT_PATH` overrides the storage directory. The effective Audit directory is protected from generic Workspace file tools.

Audit intentionally stores summaries rather than captured content. Process stdout/stderr are represented only by sizes; Workspace writes record paths and create/edit metadata, not file contents or edit text; Browser fill/type text and Desktop text input are redacted; Browser navigation strips URL query/hash; screenshots and page/desktop content are not copied into Audit; custom capability environment-variable values never enter Audit. Custom capabilities can additionally redact all argv values or selected argv indexes.

## Latency tracing

For modern MCP calls, Junius assigns a Host trace ID and the Worker reports its own handler duration in response metadata. The Host keeps the newest 64 completed traces in memory and exposes them at `/__junius/supervisor`. Each trace includes the tool name, Worker ID, HTTP status, total Host-observed duration, Worker duration, and derived proxy/transport overhead. Tracing does not rewrite tool result bodies or force streaming responses into an additional buffering layer.

## Desktop Computer Use

Junius exposes Windows desktop automation through the stable `desktop` MCP tool.

Desktop perception is screenshot-only. The tool can list top-level native windows, capture the full screen or one native window, focus a top-level window, and perform bounded coordinate mouse / keyboard / text input. Keyboard sequences can be sent with `key_macro` in one local operation; any key pressed down by that macro and not explicitly released is released before the macro returns, including on failure. Desktop control is task-scoped rather than action-scoped. A caller must open a control scope with `control_begin` before the first desktop action and close the same named session with `control_end` before the task finishes, whether it succeeds, cannot be completed, or ends in an error. For that entire scope Junius shows a local topmost, click-through banner reading **“ChatGPT 正通过 Junius 操作电脑”** at the top center of the virtual desktop. Four thin topmost edge windows animate their opacity as a breathing-light effect. The top and bottom edges own the four corners; the left and right edges start below the top edge and stop above the bottom edge so layered transparency never overlaps at a corner. The indicator is intentionally visible in screenshots as well as on the physical display so its presence can be verified during black-box testing. If the indicator windows cannot be created, shown, or hidden when the scope closes, the lifecycle call fails instead of silently losing disclosure.

When a window handle is supplied for a screenshot or mouse action, coordinates are window-relative and must remain inside that window's rectangle. Without a handle, screenshot and mouse coordinates are screen-relative. Junius does not maintain semantic element refs or inspect application accessibility trees.

Direct `type` input uses Windows Unicode `SendInput` events rather than `pyautogui.write`, but some applications reject injected Unicode input. Junius therefore also exposes explicit Unicode-text `clipboard_read` / `clipboard_write` primitives; callers can combine `clipboard_write` with a `key_macro` such as Ctrl+V when paste semantics are more reliable. Clipboard contents and Desktop text remain redacted from Audit.

The Python helper runs as a persistent JSONL server inside each Worker. Desktop Computer Use is bound to Junius's project-local `.venv` (`.venv/Scripts/python.exe` on Windows) rather than an arbitrary Python discovered from `PATH`; the helper script itself is the Junius-owned `python/desktop_helper.py`. The helper uses Win32 APIs for top-level window metadata/focus and PyAutoGUI for screenshots and coordinate input. After a Worker becomes ready, Junius opportunistically prewarms both the Desktop helper and the Playwright broker in the background. If the Desktop helper times out, crashes, or violates its response protocol, Junius terminates it and the next request starts a clean helper process.

Desktop has no semantic element refs, but its named `control_begin` / `control_end` session is a user-disclosure lifecycle scope owned by the helper process; a helper/Worker exit destroys the native indicator windows automatically. Desktop is machine-scoped like browser. It has persisted `enabled`, runtime `available`, and derived `active` state and does not use Workspace grants.

## Workspace batching and transactional writes

`workspace_batch` executes up to 16 independent `ls`, `read`, and `rg` operations in one MCP round trip. The operations run concurrently, expected Workspace-file failures are isolated per operation, and per-result/aggregate response budgets prevent one batch from returning unbounded data. Each sub-operation and the whole batch report `durationMs` so Junius can distinguish local execution time from external MCP round-trip latency.

`write` now uses the same transactional multi-file commit path used by `workspace_apply`: all targets are resolved and read in parallel, duplicate targets and size limits are checked, complete next-file contents are prepared in memory, and same-directory temporary files are fully written before any target replacement starts. Immediately before replacement, Junius rechecks existing target contents so an IDE or another process cannot silently change a file between validation and commit.

During commit, existing targets are renamed to temporary backups and prepared files are renamed into place. If a later replacement fails, Junius walks the staged set in reverse and attempts to restore the backups and remove newly created targets. This is a best-effort application-level transaction; Junius does not claim the filesystem provides one atomic commit across multiple files.

`workspace_apply` combines that write phase with optional post-commit `ls`, `read`, and `rg` verification in the same MCP round trip. Verification operations are observational: their results are returned to the caller, but Junius does not infer success criteria or autonomously undo an otherwise successful commit.

