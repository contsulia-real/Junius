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

The Host owns the public listeners and is not run with `tsx watch`. Worker processes own the MCP runtime, authorization/runtime services, browser/desktop adapters, Workspace services, Job Manager, and admin implementation.

Worker replacement is guarded rather than automatic process restart:

1. debounce a Worker-side source change;
2. run the full `pnpm run check` source validation;
3. spawn a candidate Worker from the current source tree;
4. require the candidate ready IPC message;
5. require its private HTTP health endpoint to respond correctly;
6. promote it atomically only after those checks pass;
7. keep the previous Worker alive through a rollback window and until routed MCP sessions/in-flight requests drain.

A failed source check or failed candidate startup never changes the active Worker. If the newly active Worker exits while the previous Worker is still retained, the Host promotes the previous Worker again.

The proxy records MCP session IDs returned by Workers. Requests carrying an existing session ID continue to route to that same retiring Worker after a promotion. Modern sessionless MCP calls require an additional resource-affinity layer because process-local resources can otherwise disappear between adjacent tool calls. The Host therefore binds returned Job IDs to their creating Worker, binds named browser sessions, and binds Desktop UIA refs by desktop session. These bindings are lifecycle-managed rather than permanent: browser affinity has a 10-minute idle TTL, Desktop UIA-ref affinity has a 5-minute idle TTL, and access refreshes the relevant TTL. Jobs have no TTL while running. `JobManager` emits a terminal event through Worker IPC when a Job finishes; the Host then places that Job's routing affinity into a 30-minute result-retention window, refreshed by later Job operations. A terminal event that races ahead of the `start_job` response is retained as a hint and applied when the Job ID is bound. Retiring Workers are never reaped before the rollback window ends, even if their last resource binding disappears early. `/__junius/supervisor` exposes current resource bindings with `boundAt`, `lastUsedAt`, and optional `expiresAt` timestamps.

Host-only files are a separate stability boundary. Changes to the Host/Supervisor/proxy/check implementation set a restart-required state rather than hot-restarting the Host. The local supervisor state endpoint is `/__junius/supervisor`.

Full restart safety is handled by a two-stage persisted last-known-good startup chain, but service lifecycle remains manual. `pnpm dev` / `pnpm start` execute the intentionally tiny live `scripts/host-launcher.mjs`; Junius never invokes those lifecycle commands on its own. The launcher prefers `.junius/runtime/bootstrap/host-bootstrap.mjs`, the last bootstrap that participated in a successful validated Host promotion, and uses the live bootstrap only before that stable copy exists. The bootstrap fingerprints `src`, `python`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and both launcher/bootstrap scripts. If live source matches the current validated release, it starts that release without rerunning validation. Otherwise it snapshots the source, resolves pnpm from inherited `PATH`, runs `pnpm run check`, verifies that the source fingerprint did not drift during validation, and then starts the candidate release. After the candidate Host reports healthy with the expected `releaseId`, the validated bootstrap copy is replaced atomically and `current.json` is advanced. Failed validation or failed candidate startup leaves both persisted pointers unchanged and starts the previous last-known-good release. The newest three Host release snapshots are retained under `.junius/runtime/releases`. `package.json` plus the tiny live launcher are the irreducible entry boundary for the operator's `pnpm dev` invocation itself.

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

`ls`, `read`, `write`, and `rg` are built-in Workspace file operations. Registering a Workspace defines the filesystem scope available to these built-in tools. Their paths are always Workspace-relative and are resolved by Junius rather than passed to a shell.

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

Authorization UX v1 is implemented and awaiting local WebUI validation.

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
["run", "<script>"]
["run", "<script>", "--", ...scriptArgs]
```

The pnpm capability does not expose `install`, `add`, `exec`, or `dlx`.

### git

Git is a machine-level `ProcessCapability` and is invoked through the same existing command surface:

```text
run_command(workspace, "git", args)
```

The Git adapter resolves the first matching local Git executable directly from the inherited `PATH` and owns a bounded machine-level argument policy. It does not scan fixed installation directories or use a separate executable override. It supports repository initialization, status, staging, commits, local identity configuration, branch/remote inspection and updates, fetch/push, rev-parse, diff/log, and ls-files.

The policy permits explicit force pushes because local-source-of-truth synchronization can require replacing the remote branch. It does not expose `clean`, `reset --hard`, arbitrary aliases, mirror pushes, or remote branch deletion.

Workspace grants remain required and can only narrow this machine-level Git policy.

## Machine Capability state

Built-in process capabilities have persistent machine-level enablement state.

Current managed keys and scopes:

```text
workspace-scoped
  node
  pnpm
  git

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

The persisted machine state is stored separately from Workspace grants.

Windows default:

```text
%LOCALAPPDATA%\Junius\machine-capability-state.json
```

Override:

```text
JUNIUS_MACHINE_CAPABILITY_STATE_PATH
```

Machine Capability v1 only controls known built-in adapters. It does not allow the WebUI to register arbitrary executable paths, arbitrary argument policies, or raw shell commands.

Disabling an active Workspace-scoped process capability unregisters it immediately. Workspace grants referencing that key are intentionally preserved rather than rewritten. Browser and desktop keep their stable MCP surfaces but reject execution in their service layer while disabled. Re-enabling restores execution when the underlying runtime is available.

Disabling a capability prevents new synchronous commands and jobs from starting through that capability. It does not terminate jobs that were already started.

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

They reject absolute paths and `..` traversal. Existing targets are canonicalized and must resolve within the Workspace. New writes validate the nearest existing ancestor before directories are created. Directory traversal does not follow symlink entries.

This boundary applies only to Junius's built-in file tools. It does not restrict what an executable launched through `run_command` can access.

## Process lifecycle

The current ProcessCapability provides:

- direct executable spawning;
- `shell: false`;
- Workspace cwd;
- stdout/stderr capture;
- maximum output size;
- timeout handling.

Current synchronous ProcessCapability timeout termination targets the directly spawned process. Junius does not claim general descendant process-tree containment for synchronous commands.

Long-running processes use the implemented Job Manager described below.

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

Junius does not use an inactivity timer to infer task completion because pauses between agent steps are not a reliable task boundary.

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
-> Windows UI Automation / screenshot / mouse / keyboard
```

The semantic path is preferred:

```text
windows
-> inspect(handle)
-> session-local refs such as d3
-> invoke / set_value / focus
```

`inspect` maps helper-internal element paths to session-local refs in Node. A new inspect refreshes those refs for that named desktop session.

When semantic UI Automation is not useful, the capability can take screenshots and perform coordinate mouse/keyboard operations. If a window handle is supplied, mouse coordinates are relative to that window and the helper rejects coordinates outside the window rectangle before moving or clicking.

Text input uses Windows Unicode `SendInput` keyboard events rather than `pyautogui.write`. This supports arbitrary Unicode text without mutating the clipboard.

Each Worker owns one lazily started persistent Python helper process. The helper is launched with `shell: false` in `--server` mode and speaks a request-ID JSONL protocol over stdio. Imports and Windows automation initialization therefore occur once per Worker rather than once per desktop action. Node keeps UIA ref/session state; Python remains an execution helper rather than the authority for Junius session semantics. A helper timeout, crash, output-limit violation, or malformed protocol response rejects outstanding requests and tears the helper process down so a later action can start a clean instance.

Desktop machine state uses the same persisted `enabled` / runtime `available` / derived `active` model as browser. A disabled desktop capability keeps the stable MCP surface but rejects actions before contacting the helper. The admin state also exposes whether the persistent helper process is currently running.

## Local WebUI security

The admin WebUI binds to the configured localhost address and is not routed through the Secure MCP Tunnel.

The admin HTTP layer additionally enforces:

- the configured local `Host` value;
- same-origin mutation requests when an `Origin` header is present;
- a per-process random admin token on all mutation requests;
- `application/json` for mutation endpoints that accept JSON bodies.

`GET /state` returns the current admin token to same-origin WebUI code. Browser same-origin policy prevents an unrelated website from reading that token, while the custom mutation header also forces cross-origin script requests through preflight. Direct local clients may read `/state` and explicitly supply the token.

Workspace grant mutation validates new rules against the machine policy even when the capability is currently disabled or unavailable. Historical rules that no longer intersect the machine policy are preserved and marked invalid in admin state rather than silently deleted; they may be retained while editing so users can remove them incrementally.

