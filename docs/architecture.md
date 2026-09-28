# Junius Architecture

## Positioning

Junius is a **Local Agent** that lets ChatGPT use capabilities of the user's local computer through MCP under explicit user-controlled authorization.

Local files, processes, jobs, browser automation, and Windows desktop computer use are Local Agent capabilities. Junius is not defined by its current command adapter, Workspace model, or authorization mechanism.

Junius's user-facing management surface is a local WebUI rather than a desktop Dashboard. Desktop computer use is a separate Local Agent capability and is already implemented.

```text
Junius
= Local Agent

current capabilities
= files + processes + jobs + browser + desktop computer use

user-facing management
= local WebUI

desktop computer use
= machine-scoped capability, separate from the management UI

Workspace / Capability Registry / grants
= authorization and routing mechanisms

OS sandbox
= separate implementation choice, currently not provided
```

For command execution, the effective authorization is:

```text
Machine capability policy
∩
Workspace capability/argument grants
=
What ChatGPT may ask Junius to execute
```

That policy controls which registered executable may run, which argument shapes are permitted, and which Workspace is used as the working directory. It does not redefine Junius as a command runner and does not isolate the resulting process from the rest of the operating system.

## Stable Host / replaceable Worker

Junius separates the stable public service from the mutable Agent implementation.

```text
public 127.0.0.1:8787 / :8788
            |
            v
      Junius Host
            |
      reverse proxy
            |
            v
      active Worker
      random local ports
```

The Host owns the public listeners and is not run with `tsx watch`. Worker processes own the MCP runtime, authorization/runtime services, browser/desktop adapters, Workspace services, Job Manager, and admin implementation. Each Worker receives a fresh 256-bit internal token when spawned. The Host removes any client-supplied internal-token header and injects the correct token on every private Worker request; Worker MCP, admin, and health endpoints reject missing/incorrect tokens. The token is not included in Supervisor state or logs.

Worker replacement is guarded rather than automatic process restart:

1. debounce a Worker-side source change;
2. run the full `pnpm run check` source validation; each check owns an independent pending validation transaction, so overlapping Host-triggered and manual checks cannot clobber one another;
3. spawn a candidate Worker from the current source tree;
4. require the candidate ready IPC message;
5. require its private HTTP health endpoint to respond correctly;
6. promote it atomically only after those checks pass;
7. keep the previous Worker alive through a rollback window and until routed MCP sessions/in-flight requests drain.

A failed source check or failed candidate startup never changes the active Worker. If the newly active Worker exits while the previous Worker is still retained, the Host promotes the previous Worker again.

The proxy records MCP session IDs returned by Workers. Host-side MCP session routes have a 30-minute idle TTL and are refreshed by requests, preventing abandoned clients from pinning routing state indefinitely. While a route exists, requests carrying that session ID continue to the same Worker across promotion. Modern sessionless MCP calls require an additional resource-affinity layer because process-local resources can otherwise disappear between adjacent tool calls. The Host therefore binds returned Job IDs to their creating Worker and binds named browser sessions. Desktop actions no longer create Worker-local semantic state, so they route directly to the current active Worker and require no Desktop resource affinity. These remaining bindings are lifecycle-managed rather than permanent: browser affinity has a 10-minute idle TTL and access refreshes that TTL. Jobs have no TTL while running. `JobManager` emits a terminal event through Worker IPC when a Job finishes; the Host initially places that Job's routing affinity into a 30-minute fallback result-retention window. After the terminal record and captured streams are atomically persisted, the Worker emits a second `junius-job-history-persisted` IPC message and the Host releases that Job affinity immediately. Later Job operations can then route to the active Worker and lazy-load shared terminal history. If persistence fails, the persisted IPC is never emitted and the 30-minute affinity remains as the fallback. Terminal and persisted events that race ahead of the `start_job` response are retained only for that same 30-minute window, so orphaned race hints are bounded. Retiring Workers are never reaped before the rollback window ends, even if their last resource binding disappears early. Exited Worker diagnostics are also bounded: only the newest 16 exited records are retained. `/__junius/supervisor` exposes current resource bindings with `boundAt`, `lastUsedAt`, and optional `expiresAt` timestamps.

Configuration mutation has an additional Host barrier because affinity can intentionally keep an older Worker alive. Successful admin writes that change Workspace registration/grants or machine-capability enablement are buffered at the Host rather than returned immediately. After the source Worker persists the new state, the Host advances a configuration epoch and invokes the private authenticated `POST /__junius/config-reload` endpoint on every other live Worker. Reload mutates the existing `WorkspaceManager` in place and reconciles machine capabilities, including Browser session cleanup and Desktop ref/helper teardown when those capabilities become disabled. If a live Worker cannot reload, the Host quarantines it by closing it and clearing its routing state; the external mutation response is released only after all remaining live Workers are current. Candidates that were spawned across an epoch change are reloaded before promotion, looping if another mutation lands during that refresh. The public Host never exposes the private reload endpoint.

Host-only files are a separate stability boundary. The Host computes that boundary from the transitive relative-import graph rooted at `src/host.ts`, rather than relying on a hand-maintained filename list; startup control files (`package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `scripts/host-bootstrap.mjs`, `scripts/host-launcher.mjs`, and `scripts/source-validation.mjs`) are also restart-only. Test files and unrelated source remain outside that boundary. If a Host-only change is observed, the Host sets restart-required and does not hot-restart itself. Candidate Worker promotion checks that boundary both after source validation and again after candidate startup, so a Host change that races with an in-progress reload cannot promote a Worker under stale Host code. The local supervisor state endpoint is `/__junius/supervisor`.

Full restart safety is handled by a two-stage persisted last-known-good startup chain, but service lifecycle remains manual. `pnpm dev` / `pnpm start` execute the intentionally tiny live `scripts/host-launcher.mjs`; Junius never invokes those lifecycle commands on its own. The launcher prefers `.junius/runtime/bootstrap/host-bootstrap.mjs`, the last bootstrap that participated in a successful validated Host promotion, and uses the live bootstrap only before that stable copy exists. The bootstrap fingerprints `src`, `python`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and all startup-validation scripts. If live source matches the current validated release, it starts that release without rerunning validation. Full `pnpm run check` uses a begin/commit validation stamp: the fingerprint is captured before the full check and committed only if the fingerprint is identical afterward. On a later restart with changed-but-identical-to-prevalidated source, bootstrap may reuse that stamp only when fingerprint, Node version, platform, and architecture all match. Otherwise it runs the complete `pnpm run check`. Bootstrap still snapshots before validation reuse, verifies source stability again afterward, and only then starts the candidate release. After the candidate Host reports healthy with the expected `releaseId`, the validated bootstrap copy is replaced atomically and `current.json` is advanced. Failed validation or failed candidate startup leaves both persisted pointers unchanged and starts the previous last-known-good release. The newest three Host release snapshots are retained under `.junius/runtime/releases`. `package.json` plus the tiny live launcher are the irreducible entry boundary for the operator's `pnpm dev` invocation itself.

A release Host starts its initial Worker from the same release snapshot, while later hot-reload candidates still come from the live project source. Release snapshots link back to the project's `node_modules` rather than copying dependencies. Desktop helper code follows the release snapshot, but Desktop Python deliberately remains the project-owned `.venv` through `JUNIUS_PROJECT_ROOT`.

## Fixed MCP surface

The current stable MCP tools are:

```text
list_workspaces()
ls(workspace, ...)
read(workspace, ...)
write(workspace, ...)
workspace_apply(workspace, files, verify)
rg(workspace, ...)
workspace_batch(workspace, operations)
playwright_cli(session, command, args)
desktop(session, command, ...)
start_job(workspace, key, args)
get_job(job)
wait_job(job, timeout_ms)
read_job_output(job, stream, offset, limit)
cancel_job(job)
run_command(workspace, key, args)
```

`list_workspaces` exposes registered Workspace IDs, canonical roots, and their current command grants.

`ls`, `read`, `write`, and `rg` are built-in Workspace file operations. Registering a Workspace defines the filesystem scope available to these built-in tools. Their paths are always Workspace-relative and are resolved by Junius rather than passed to a shell. `.junius` runtime/control state and `.git` metadata at any depth are reserved from this generic file surface; Git metadata is accessed only through the Git capability. Recursive `ls` skips these control directories, and `rg` appends Junius protection globs after user globs so a later user include pattern cannot re-enable reserved or configured protected paths.

`workspace_batch` is a read-only orchestration surface over `ls`, `read`, and `rg`. It does not add new filesystem authority. Up to 16 known read operations execute concurrently in one MCP round trip; expected file errors are returned per operation instead of aborting unrelated operations, and bounded result budgets prevent batch amplification.

`workspace_apply` is the write-oriented orchestration surface. It uses the same transactional write implementation as `write`, then optionally performs bounded read-only verification operations in the same MCP round trip.

`run_command` always requires an explicit Workspace ID and separately requires that Workspace's capability/argument grant. There is no global active Workspace.

## Parallel Workspace model

Junius must support multiple Workspaces concurrently.

Each Workspace has:

- a stable Junius-managed ID;
- one canonical root path;
- an independent set of capability grants;
- argument-level authorization for each granted capability.

Example:

```text
default -> C:\Users\Why23\RustroverProjects\Junius
weave   -> C:\Users\Why23\RustroverProjects\Weave
```

Two ChatGPT conversations may invoke different Workspaces at the same time. No activation or Workspace switching step exists.

## WorkspaceProfile

A Workspace grant is not a per-capability boolean.

It contains argument rules:

```ts
type WorkspaceArgumentGrant =
  | { mode: "exact"; args: string[] }
  | { mode: "prefix"; args: string[] }
```

`exact` requires the entire argument vector to match.

`prefix` permits additional trailing arguments after the granted prefix.

Workspace grants only narrow the machine capability. They can never expand the machine-level policy.

## Workspace authorization UX

Authorization belongs to the Workspace that owns the grant. The WebUI therefore does not expose a separate Permissions section.

The user-facing structure is:

```text
Workspace
-> settings
-> capability grants
-> argument rules
```

The persistent/runtime model remains `WorkspaceCapabilityGrant` with `exact` and `prefix` argument rules. The WebUI is only a presentation and editing layer over that existing model.

User-facing labels map as follows:

```text
exact
-> 仅允许这组参数

prefix
-> 允许此前缀参数
```

Rules may be displayed in command-like form for readability, but this does not create a shell-command permission model. The stored and evaluated value remains an argument vector.

The Workspace settings panel also surfaces the corresponding machine-capability state. A persisted Workspace grant remains visible when the machine capability is disabled or unavailable, even though that grant cannot currently authorize execution.

New grants can only target capabilities that are active in the live Capability Registry. Removing one rule preserves the remaining rules for that capability; removing the final rule revokes the capability grant.

Authorization UX v1 is implemented and has been validated through the local WebUI and live command execution.

## Capability Registry

The Capability Registry is machine-level.

Each capability owns:

- a stable capability key;
- its executable path;
- its machine-level argument policy;
- timeout/output limits;
- any fixed launcher arguments required by the adapter.

The model does not supply executable paths or raw command-line strings.

Current built-in capabilities:

### node

Machine policy:

```text
["--version"]
["-p", "process.platform"]
```

### pnpm

Machine policy:

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

`install`, `update`, and `add` reject explicit global-package, working-directory, external state/configuration path, and broader-workspace selector forms (`--global`, `--dir`, `--lockfile-dir`, `--store-dir`, `--state-dir`, `--userconfig`, `--filter`, recursive/workspace-root selectors, and equivalent assignment forms). `add` requires at least one following token. `self-update` accepts no version or one explicit version/tag. `exec` and `dlx` remain outside the machine policy.

This policy constrains pnpm invocation shape, not the implementation of the selected package script. `pnpm run <script>` is therefore an explicit grant to execute Workspace-controlled code with the Junius process user's permissions and inherited environment.

### git

Git is a machine-level `ProcessCapability` and is invoked through the same existing command surface:

```text
run_command(workspace, "git", args)
```

The Git adapter resolves the first matching local Git executable directly from the inherited `PATH` and owns a bounded machine-level argument policy. It does not scan fixed installation directories or use a separate executable override. It supports repository initialization, status, staging, commits, local identity configuration, branch/remote inspection and updates, fetch/push, rev-parse, diff/log, and ls-files.

The policy permits explicit force pushes because local-source-of-truth synchronization can require replacing the remote branch. It does not expose `clean`, `reset --hard`, arbitrary aliases, mirror pushes, or remote branch deletion.

Workspace grants remain required and can only narrow this machine-level Git policy.

Git also performs a synchronous repository preflight inside `prepareProcess()`, so both `run_command` and Job Manager use the same check. The Workspace root must contain its own non-symlink `.git` directory; Junius does not borrow a parent repository or follow a worktree/gitdir redirection outside the Workspace. Repository-local config is parsed through a conservative whitelist of non-executable core/user/remote/branch fields. Unknown or executable local config is rejected with `unsafe_repository_config`. `fetch` and `push` additionally validate the configured local remote URL before process launch. Git runs with `--no-pager`, a disabled hooks path, and commit signing disabled.

## Machine Capability state

Built-in and user-defined process capabilities have persistent machine-level state. Built-ins persist enablement; custom process capabilities additionally persist their executable, bounded argument policy, environment policy, timeout, and output limit.

Current managed keys and scopes:

```text
workspace-scoped
  node
  pnpm
  git
  <custom process capability keys>

machine-scoped
  browser
  desktop
```

For each known key, Junius distinguishes:

```text
enabled
= persisted user preference

available
= adapter/launcher can currently be resolved

active
= enabled and currently usable; process capabilities are present in the live Capability Registry, while browser/desktop pass their service-level execution gate
```

This distinction allows a capability such as pnpm to remain enabled in configuration even when its launcher is temporarily unavailable.

External user-tool executables are resolved from the inherited `PATH` in command-search order. This applies to Node, pnpm, Git, playwright-cli, and ripgrep. `process.execPath`, `PNPM_HOME`, `npm_execpath`, fixed installation-directory scans, and private executable override variables are not launcher fallbacks. Executable paths are treated only as locations; Junius never derives a runtime version from directory or file names. On Windows, a PATH-resolved `.cmd` shim may be inspected to reach the target declared by that shim while preserving `shell: false` execution. Desktop Computer Use is intentionally different: its Python runtime is project-owned and resolves to Junius's own `.venv` beside `python/desktop_helper.py`. OS components such as `%SystemRoot%\System32\taskkill.exe` and Junius-owned internal files are not user-tool discovery and remain explicit internal paths.

The persisted machine state is stored separately from Workspace grants. Current files use schema version 3; the loader also accepts version 1 enablement-only files and version 2 custom-capability files, upgrading either on the next save. Version 2 custom definitions are migrated with `inherit = all` to preserve their previous execution environment; newly created version 3 definitions default to `inherit = none`.

Windows default:

```text
%LOCALAPPDATA%\Junius\machine-capability-state.json
```

Override:

```text
JUNIUS_MACHINE_CAPABILITY_STATE_PATH
```

The WebUI may register custom Workspace-scoped process capabilities, but this does not create a raw command-execution surface. Each custom definition must use a stable non-built-in key, an absolute executable path, an argument vector for fixed launcher arguments, one or more exact/prefix machine-policy rules, an environment policy, and bounded timeout/output limits. Prefix rules cannot be empty. The executable picker only enumerates files found in inherited `PATH`; it is not an arbitrary filesystem browser. Environment inheritance can be `none`, `allowlist`, or `all`; deny-name and deny-prefix filters apply only to inherited values, while explicit key/value overrides are applied afterward. Custom execution still goes through `ProcessCapability`, uses `shell: false`, starts in the selected Workspace, and is intersected with that Workspace's grant. Custom definitions do not create new machine-scoped MCP services; browser/desktop remain explicit built-in service adapters.

Disabling an active Workspace-scoped process capability unregisters it immediately. Updating a custom definition reconciles that registry entry in place across Workers through the normal configuration barrier. Deleting a custom capability unregisters it and removes its machine definition. Workspace grants referencing disabled, changed, or deleted keys are intentionally preserved rather than rewritten. Browser and desktop keep their stable MCP surfaces but reject execution in their service layer while disabled. Re-enabling restores execution when the underlying runtime is available.

Disabling a capability prevents new synchronous commands and jobs from starting through that capability. It does not terminate jobs that were already started.

## Activity Audit

Audit is a shared observational subsystem, not an authorization layer. The admin state exposes the bounded retained event set (up to the configured retention count, capped by the store's 1000-event list bound), and the WebUI performs Workspace/category/status/text filtering locally so search covers the currently retained history rather than only a recent 200-event slice. Worker operations emit bounded event summaries through `AuditStore.record()`; the call returns immediately and persistence continues best-effort. Audit persistence failures are logged locally but do not change the result of the underlying command, Job, file write, Browser/Desktop action, or configuration mutation.

The default Audit root is `<runtime-root>/audit`. Each event is persisted as its own timestamp/UUID JSON file, which avoids a single read-modify-write log file across simultaneously live active and retiring Workers. Readers merge persisted records with each Worker's bounded recent-event cache. Pruning is best-effort and defaults to 1000 entries and 7 days. The Audit root is included in Workspace-file protected paths.

Sensitive data is intentionally excluded or reduced before persistence: stdout/stderr content, file contents/edit text, screenshots, Browser/Desktop text input, and explicit environment-variable values are not stored. Browser navigation removes query/hash. A custom process capability may expose an Audit argv policy of `full`, `redact_all`, or `redact_selected`; selected indexes are zero-based. Workspace-grant configuration events record rule count/modes rather than argument literals.

## Execution path

```text
ChatGPT
  -> MCP
  -> run_command(workspace, key, args)
  -> WorkspaceManager
  -> WorkspaceProfile argument grant
  -> CapabilityRegistry
  -> machine capability argument policy
  -> ProcessCapability
  -> child_process.spawn(executable, args, {
       cwd: Workspace root,
       shell: false
     })
```

Junius uses argument-vector spawning with `shell: false`.

This avoids turning model output into an arbitrary shell command, but it is not sandboxing.

## Process permissions

An authorized process runs with the same operating-system identity and permissions as Junius.

Therefore an authorized executable or package script may access resources available to that user account, including files outside the selected Workspace, network resources, registry state, environment variables, and other local services.

The Workspace root is the process working directory and authorization/routing context. It is **not** an operating-system filesystem boundary.

Junius must not describe this model as:

- filesystem isolation;
- process containment;
- network isolation;
- OS sandboxing;
- escape-proof Workspace confinement.

## Workspace file tools

Junius exposes four short, stable file-tool names:

```text
ls
read
write
rg
```

### ls

Lists a Workspace directory. It can recurse to a bounded depth and returns Workspace-relative paths.

### read

Reads one or more UTF-8 text files with optional line ranges.

Binary files are rejected by the current text-file API.

### write

Creates, replaces, or exact-text edits one or more UTF-8 text files.

Before any file is changed, Junius validates every requested write. Validation and source-file reads are performed before commit and may run concurrently. Duplicate targets are rejected, aggregate/per-file size limits are checked, and the complete next contents are prepared before target replacement begins. Existing files do not require a SHA/version token or prior model-issued `read`, but Junius retains the validated bytes internally and rechecks the target immediately before replacement to reject concurrent external changes.

For partial edits, `write` matches an exact `old_text` string and replaces it with `new_text`. A non-`replace_all` edit must match exactly once, which prevents an ambiguous edit from silently changing the wrong location.

New files may be created under the Workspace with full `content`.

For commit, Junius writes same-directory temporary files first. Existing targets are then moved to temporary backups and the prepared files are renamed into place. A later commit failure triggers reverse best-effort rollback: installed targets are removed, backups are restored, uncommitted temporary files are deleted, and newly created empty directories are cleaned when possible. This provides transactional application semantics without claiming a filesystem-level atomic transaction across multiple files.

### workspace_apply

`workspace_apply` accepts the same bounded multi-file write model as `write`, followed by optional `ls`, `read`, and `rg` verification operations. Verification runs only after a successful commit and is observational; a verification result does not autonomously roll the commit back.

The intended fast path is:

```text
known edits
-> one transactional write commit
-> parallel read/search verification
-> one MCP response
```

This removes the common `write -> read/rg` round trips while keeping the decision about whether the resulting state is acceptable in the calling agent.

### rg

Runs ripgrep with Junius-controlled arguments and a Workspace-scoped search root. Model input supplies the search query and bounded search options, not an arbitrary rg command line.

ripgrep config loading is disabled for this tool.

### File path boundary

These four tools are implemented by Junius and therefore apply their own path checks even though `run_command` is not sandboxed.

They reject absolute paths and `..` traversal. Existing targets are canonicalized and must resolve within the Workspace. New writes validate the nearest existing ancestor before directories are created. Reads do not escape through links, and writes reject symbolic-link/junction parent aliases even when the alias target is still inside the Workspace. After missing directories are created, the canonical write parent chain is checked again; it is checked once more immediately before each staged rename is committed. Directory traversal does not follow symlink entries. The Workspace root `.junius/` directory is reserved for Junius control/runtime state and cannot be entered through `ls`, `read`, `write`, or `rg`. `WorkspaceFilesService` also receives the effective runtime root, Workspace-state file, machine-capability-state file, and Browser state/profile root as protected absolute paths; when one lies inside a Workspace, direct lexical access, canonical-link aliases, directory listing, and ripgrep scanning are blocked. These checks reduce link/TOCTOU escape windows but are not represented as kernel-level `openat`-style path confinement.

This boundary applies only to Junius's built-in file tools. It does not restrict what an executable launched through `run_command` can access.

## Process lifecycle

The current ProcessCapability provides:

- direct executable spawning;
- `shell: false`;
- Workspace cwd;
- stdout/stderr capture;
- maximum output size;
- timeout handling.

Forced-stop paths share one process-termination primitive. On Windows it invokes `%SystemRoot%\\System32\\taskkill.exe /PID <pid> /T /F` directly with `shell: false`, providing descendant process-tree termination. It is used by synchronous ProcessCapability timeout/output-limit handling, Job cancellation, playwright-cli spawn fallback, the persistent browser broker, source validation, Desktop helper teardown, Worker hard-stop fallback, and bounded ripgrep execution. Other platforms currently terminate only the direct child with SIGTERM and then SIGKILL fallback.

Long-running processes use the Job Manager. Running Job control stays with the Worker that owns the live child process and is not reconstructed from a PID after an abrupt process loss. Terminal Jobs are persisted independently from Worker lifetime under `.junius/runtime/jobs/<job-id>/`. Each Job directory contains a small `meta.json` plus separate `stdout.txt` and `stderr.txt` files, so Job listing/status reads do not load captured output. Terminal writes use a temporary per-Job directory and rename it into place only after metadata and both streams are complete. New Workers lazy-load this history when an in-memory Job ID is absent; live in-memory state always wins for IDs owned by the current Worker. Normal Worker shutdown cancels running Jobs and waits for pending terminal-history writes before closing. On-disk history is unlimited by default; `JUNIUS_JOB_HISTORY_MAX_ENTRIES` and `JUNIUS_JOB_HISTORY_MAX_AGE_MS` opt into pruning. The in-memory metadata hot cache remains bounded to 256 entries regardless of disk retention, while Admin state reports history entry count, captured bytes, oldest/newest terminal timestamps, and configured retention.

This persistence is intentionally terminal-history recovery, not process reattachment. An abrupt crash before a running Job reaches and persists a terminal state can still lose that Job's control record, and Junius does not assume that a reused OS PID belongs to the old Job.

## Latency tracing

Modern MCP requests receive a Host-generated trace ID. The Worker measures time spent inside its MCP handler and reports that duration through an internal response header; the Host records total request duration after the upstream response completes. A bounded in-memory ring retains the newest 64 traces and `/__junius/supervisor` exposes `hostTotalMs`, `workerDurationMs`, and `proxyOverheadMs = max(0, hostTotalMs - workerDurationMs)` together with tool and Worker identity.

This tracing path is deliberately outside tool result payloads and does not require Host-side response buffering, so measurement does not materially change the normal streaming/proxy behavior.

## Browser capability

Browser automation is a first-class Local Agent capability and is not attached to a Workspace.

```text
ChatGPT
-> playwright_cli MCP tool
-> PlaywrightCliService
-> persistent CLI broker when compatible
   -> installed CLI's own program client
   -> Playwright CLI daemon
-> spawn fallback when broker is unavailable
-> CLI-managed browser session/profile
```

Junius deliberately keeps this adapter thin. It does not reimplement Playwright's browser/session/page model.

The preferred transport is a persistent Worker-local broker. The broker runs under plain Node, loads the installed `playwright-cli.js` entry's own `program` module once, and serializes repeated command invocations through that client. The browser/session daemon remains Playwright-owned. This removes repeated Node/CLI client startup from ordinary browser actions without creating a second browser-control protocol.

Because Playwright's CLI client module location is version-dependent, the broker reads the installed CLI entry to discover its actual `program` require specifier and canonicalizes the pnpm-linked entry with `realpath` before module resolution. The Worker prewarms this broker after becoming ready but does not start a headed browser until an actual browser command. Broker failure is non-fatal: initialization failure disables the incompatible broker for that Worker, while a runtime failure after readiness only resets the broker. The failed command falls back to the original `shell: false` CLI spawn path, and the next browser command may create a fresh broker.

### MCP surface

Browser capability v1 adds one stable MCP tool:

```text
playwright_cli(session, command, args)
```

`session` maps directly to playwright-cli named sessions. The default is `junius`.

`command` is a Junius allowlist of ordinary navigation, snapshot, element interaction, keyboard/mouse, tab, dialog, and close operations.

The first version intentionally does not expose `eval`, `run-code`, storage mutation, CDP attach, request interception, or arbitrary playwright-cli commands.

### Snapshot/ref flow

The normal model workflow remains playwright-cli's own interaction model:

```text
open/goto
-> snapshot
-> receive refs such as e15
-> click/fill/etc using refs
-> snapshot again when needed
```

For `snapshot`, Junius adds playwright-cli's global `--raw` option so snapshot YAML is returned directly on stdout through MCP.

Junius does not invent a second element-reference format.

### Session persistence and visibility

`open` defaults to playwright-cli `--persistent --headed`.

The persistent profile belongs to the CLI-managed named browser session. It does not reuse the user's ordinary Chrome/Edge browser profile and it does not make browser sessions part of Workspace state.

Headed mode is the Junius default so local browser activity is visible to the user.

### Task lifecycle

A browser task normally follows:

```text
open
-> navigate / snapshot / interact
-> obtain requested result
-> close
-> final response
```

The MCP tool description instructs ChatGPT to close the same named session before giving the final answer unless the user explicitly asks to leave the browser open.

The persistent profile is independent of the browser process lifetime. Closing a session ends the visible browser process/session but does not intentionally discard the CLI-managed persistent profile or its login state.

Task completion is still explicit, but abandoned named browser sessions are bounded independently from task semantics. Each Worker tracks at most 32 named sessions and applies a 10-minute idle timer after a command completes; activity refreshes the timer and in-flight commands suspend expiry. Idle or over-limit sessions are closed through playwright-cli itself, and Worker shutdown waits for pending cleanup. Disabling the Browser machine capability rejects new Browser work immediately and starts the same cleanup path; already in-flight commands are allowed to finish before their session is closed. This idle cleanup ends the browser process/session but preserves the CLI-managed persistent profile. Profile deletion is deliberately not automatic because those files can contain user login/session state.

### Local runtime files

playwright-cli may generate runtime files such as snapshots relative to its working directory. Junius therefore runs it from a dedicated Local Agent state directory rather than a project Workspace.

Windows default:

```text
%LOCALAPPDATA%\Junius\browser
```

Non-Windows uses the corresponding XDG/local state directory.

Browser is machine-scoped. Its MCP tool remains stable, while `PlaywrightCliService` enforces the persisted machine `enabled` gate before launching the CLI. `active` therefore means both enabled and runtime-available.

## Desktop Computer Use

Desktop computer use is also a first-class, machine-scoped Local Agent capability and is independent of Workspace routing.

```text
ChatGPT
-> desktop MCP tool
-> DesktopComputerUseService
-> python/desktop_helper.py
-> screenshot / coordinate mouse / keyboard
```

Desktop perception is screenshot-only. `windows` exposes bounded top-level native window metadata, `screenshot` captures either the full screen or one window, and input actions operate through screen coordinates or window-relative coordinates. The helper rejects window-relative points outside the target window before moving or clicking.

Top-level window enumeration, rectangle lookup, and `focus_window` use Win32 APIs directly. No accessibility tree is inspected and no semantic element refs are created.

Text input uses Windows Unicode `SendInput` keyboard events rather than `pyautogui.write`. This supports arbitrary Unicode text without mutating the clipboard.

Each Worker owns one lazily started persistent Python helper process. The helper is launched with `shell: false` in `--server` mode and speaks a request-ID JSONL protocol over stdio. A helper timeout, crash, output-limit violation, or malformed protocol response rejects outstanding requests and tears the helper process down so a later action can start a clean instance.

Desktop machine state uses the same persisted `enabled` / runtime `available` / derived `active` model as browser. Desktop actions carry a session label for tracing/audit only and do not create Worker-local semantic state, so Desktop no longer participates in Host resource affinity. Disabling the capability closes the persistent helper before the disable operation returns; re-enabling recreates the helper client lazily so the capability remains reversible. The stable MCP surface stays present while disabled and rejects actions before contacting a helper. The admin state exposes whether the helper process is currently running.

## Local WebUI security

The admin WebUI binds to the configured localhost address and is not routed through the Secure MCP Tunnel.

The public Host binds both MCP and Admin to `127.0.0.1`. Before either public port is processed, the Host requires the exact configured local `Host` value, rejects any present browser `Origin` that is not the corresponding local origin, and rejects browser fetch metadata marked `Sec-Fetch-Site: cross-site` or `same-site`. This blocks DNS-rebinding/host-header and hostile browser-origin access at the public ingress while still allowing non-browser MCP/local clients that omit `Origin`. The legacy `start:direct` MCP entry reuses the same Host/Origin guard, so the emergency path does not bypass this ingress protection. That Origin omission for local non-browser clients is deliberate: same-account local processes are inside the OS-local trust boundary unless a future application-level MCP credential layer is added. Both modern buffered MCP POSTs and sessionful streaming MCP requests have a 16 MiB Host-side request-body limit.

The admin HTTP layer additionally enforces:

- same-origin mutation requests when an `Origin` header is present;
- a per-process random admin token on all mutation requests;
- `application/json` for mutation endpoints that accept JSON bodies;
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a restrictive CSP (`default-src 'none'`, same-origin script/style/connect, no forms/base/frames).

`GET /state` returns the current admin token to same-origin WebUI code. `/api/state` deliberately omits it. Browser same-origin policy plus CSP/Host/Origin enforcement prevents an unrelated website from reading or replaying that token, while the custom mutation header also forces cross-origin script requests through preflight. Direct local clients may read `/state` and explicitly supply the token.

Workspace grant mutation validates new rules against the machine policy even when the capability is currently disabled or unavailable. Historical rules that no longer intersect the machine policy are preserved and marked invalid in admin state rather than silently deleted; they may be retained while editing so users can remove them incrementally.

Git adds a repository-local safety preflight shared by `run_command` and Job Manager. The selected Workspace must own its `.git` metadata directly; parent-repository borrowing and `.git` symlink/junction/worktree indirection are rejected. Local Git config is parsed against an allowlist of non-executable repository metadata, and fetch/push refuse configured remotes outside the accepted HTTP(S)/SSH forms. Git system/global config and system attributes are disabled for Junius Git executions; inherited `GIT_*` configuration/helper variables and `SSH_ASKPASS*` are stripped case-insensitively before Junius injects its own non-interactive Git environment. Global `user.name` and `user.email` are read separately through the selected Git executable and used only as identity fallbacks; a safe repository-local identity overrides them. For Windows HTTP(S) fetch/push, Junius selects Git's OpenSSL backend instead of Schannel. It enables Git Credential Manager only when a matching executable exists inside the selected Git installation and passes that helper explicitly in non-interactive mode; arbitrary configured credential helpers remain blocked. This prevents Workspace-controlled attributes or inherited process state from reactivating executable machine-level Git configuration; hooks, pagers, interactive prompting, and commit signing are also disabled. Workspace transactional writes similarly reject symbolic/junction parent aliases and revalidate write parents again immediately before commit.

