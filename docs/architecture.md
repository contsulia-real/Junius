# Junius Architecture

## Positioning

Junius is a **Local Agent** that lets ChatGPT use capabilities of the user's local computer through MCP under explicit user-controlled authorization.

Local files, processes, jobs, and browser automation are Local Agent capabilities. Junius is not defined by its current command adapter, Workspace model, or authorization mechanism.

Junius's user-facing management surface is a local WebUI rather than a desktop Dashboard. This UI choice is independent of whether desktop-automation capabilities are added later.

```text
Junius
= Local Agent

current capabilities
= files + processes + jobs + browser

user-facing management
= local WebUI

desktop automation capability
= separate product/capability decision

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

## Fixed MCP surface

The current stable MCP tools are:

```text
list_workspaces()
ls(workspace, ...)
read(workspace, ...)
write(workspace, ...)
rg(workspace, ...)
playwright_cli(session, command, args)
start_job(workspace, key, args)
get_job(job)
wait_job(job, timeout_ms)
read_job_output(job, stream, offset, limit)
cancel_job(job)
run_command(workspace, key, args)
```

`list_workspaces` exposes registered Workspace IDs, canonical roots, and their current command grants.

`ls`, `read`, `write`, and `rg` are built-in Workspace file operations. Registering a Workspace defines the filesystem scope available to these built-in tools. Their paths are always Workspace-relative and are resolved by Junius rather than passed to a shell.

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

## Machine Capability state

Built-in process capabilities have persistent machine-level enablement state.

Current managed keys:

```text
node
pnpm
```

For each known key, Junius distinguishes:

```text
enabled
= persisted user preference

available
= adapter/launcher can currently be resolved

active
= capability is currently present in the live Capability Registry
```

This distinction allows a capability such as pnpm to remain enabled in configuration even when its launcher is temporarily unavailable.

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

Disabling an active capability unregisters it immediately. Workspace grants referencing that key are intentionally preserved rather than rewritten. Therefore the effective authorization becomes unavailable while disabled and returns if the capability is re-enabled.

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

Before any file is changed, Junius validates every requested write. Existing files can be replaced or edited directly; there is no SHA/version token and no required prior `read`.

For partial edits, `write` matches an exact `old_text` string and replaces it with `new_text`. A non-`replace_all` edit must match exactly once, which prevents an ambiguous edit from silently changing the wrong location.

New files may be created under the Workspace with full `content`.

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

## Browser capability

Browser automation is a first-class Local Agent capability and is not attached to a Workspace.

```text
ChatGPT
-> playwright_cli MCP tool
-> PlaywrightCliService
-> locally installed playwright-cli
-> CLI-managed browser session/profile
```

Junius deliberately keeps this adapter thin. It does not reimplement Playwright's browser/session/page model.

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

`JUNIUS_BROWSER_STATE_PATH` can override this location.

### Launcher resolution

Junius first uses `JUNIUS_PLAYWRIGHT_CLI_PATH` when provided, then searches normal local executable locations/PATH.

It can launch native executables or JavaScript CLI entries through the current Node executable. On Windows it also resolves npm-style `playwright-cli.cmd` shims to their underlying `playwright-cli.js` entry so execution remains `shell: false`.

Browser capability v1 is implemented and black-box verified through ChatGPT.

## Job Manager

Long-running process work is separated from synchronous `run_command`.

The stable job lifecycle is:

```text
start_job
-> get_job / wait_job
-> read_job_output
-> cancel_job when needed
```

### Authorization

`start_job(workspace, key, args)` reuses the exact same authorization path as `run_command`:

```text
Workspace lookup
-> Workspace capability grant
-> Workspace argument grant
-> machine capability lookup
-> machine capability argument policy
-> prepared process
```

There is no second job-specific permission model.

Only process-backed capabilities expose a prepared process and can be started as jobs.

### Runtime state

Job state is intentionally process-local in v1. Junius does not persist job IDs across restart and does not claim it can reattach to processes created by an earlier Junius process.

Each running job records:

- stable job ID for the lifetime of the Junius process;
- Workspace and capability key;
- PID;
- running/succeeded/failed/cancelled state;
- start/end time and exit information;
- bounded stdout/stderr capture.

Each output stream is capped at 4 Mi characters. Truncating captured output does not terminate the job.

### Waiting and output

`wait_job` waits for completion for at most 60 seconds in one MCP call and otherwise returns the current running state.

`read_job_output` uses character offsets so the model can incrementally consume stdout or stderr without receiving the full log on every call.

### Cancellation

Cancellation is best-effort process termination, not sandbox containment.

On Windows, Junius directly launches the system `taskkill.exe` with `/PID <pid> /T /F` and `shell: false` so descendants are included.

On non-Windows platforms, the current implementation sends SIGTERM to the direct child and escalates to SIGKILL after two seconds if it has not exited. It does not currently claim full descendant-process-tree termination there.

Graceful Junius shutdown asks the Job Manager to cancel jobs that are still running.

Job Manager v1 is implemented and black-box verified through ChatGPT.

## Workspace persistence

Workspace registration and grants are persisted outside the repository.

Default Windows state path:

```text
%LOCALAPPDATA%\Junius\workspace-state.json
```

The path may be overridden with:

```text
JUNIUS_WORKSPACE_STATE_PATH
```

The state file is internal versioned Junius state, not a public configuration contract.

Current persisted data contains:

- Workspace ID;
- canonical root path;
- capability grants;
- argument grant rules.

Workspace registration/removal and grant changes are persisted immediately. Writes are serialized.

## Local WebUI and admin surface

Junius uses a local WebUI as its user-facing management interface. A desktop-native Dashboard is out of scope. Desktop automation is a separate Local Agent capability question and is not decided by the Dashboard implementation.

Dashboard v1 is served directly by the existing local admin HTTP server at:

```text
http://127.0.0.1:8788/
```

It has no separate frontend build/runtime dependency.

The WebUI/admin surface currently provides:

- Overview runtime summary;
- Workspace registration/removal and per-Workspace capability authorization settings;
- machine capability status, launcher/policy inspection, Workspace usage, and persistent enable/disable controls;
- Job Manager listing, stdout/stderr inspection, and cancellation;
- browser adapter availability/state inspection.

`GET /state` remains the compatibility state endpoint. `GET /api/state` aliases it for the WebUI.

The WebUI uses the same in-memory managers and persistent Workspace state as the MCP/runtime path. It is not a second configuration store.

It remains bound to the local machine and is not exposed through the Secure MCP Tunnel.

Dashboard v1 is implemented and locally validated.

## Desktop Automation architecture

Desktop automation is a first-class Local Agent capability and is independent from the local WebUI Dashboard.

The chosen direction is a thin Python computer-use helper:

```text
ChatGPT
-> desktop MCP tool
-> Junius TypeScript adapter
-> Python helper
   -> pywinauto
   -> PyAutoGUI
-> local desktop
```

### Semantic layer

`pywinauto` provides the semantic Windows automation layer.

It is used when an application exposes usable Win32 or UI Automation controls, allowing the helper to inspect and interact with controls using application/window/control semantics instead of screen coordinates.

### Visual/input layer

`PyAutoGUI` provides the general fallback layer:

```text
screenshot
mouse move / click / drag
keyboard press / down / up / type
scroll
```

This layer is required for games, custom-rendered applications, canvas-style interfaces, and other applications whose meaningful UI is not exposed through UI Automation.

A visual fallback task therefore follows a computer-use loop such as:

```text
capture current window/screen
-> model interprets image
-> mouse/keyboard action
-> capture again
-> verify resulting state
```

OCR or image-template matching is not a required architectural foundation. They may be added only when a concrete task benefits from them.

### Responsibility boundary

Junius owns:

- MCP exposure;
- request validation;
- permission/state policy;
- helper lifecycle;
- structured result/error transport.

The Python helper owns:

- pywinauto integration;
- PyAutoGUI integration;
- screenshot capture;
- local desktop input primitives.

Junius should not duplicate those mature libraries with its own Win32/UIA/input framework.

The Dashboard remains a local WebUI. Desktop automation does not introduce a desktop-native Dashboard.

Desktop Automation v1 is planned but not yet implemented.

## Secure MCP Tunnel

ChatGPT reaches the MCP endpoint through OpenAI Secure MCP Tunnel / `tunnel-client`.

The local admin surface remains local-only.

## Removed sandbox direction

The previous MXC-based ProcessContainer work has been removed from the current Junius architecture.

Removed from the production direction:

- `@microsoft/mxc-sdk`;
- MXC ProcessContainer execution;
- sandbox filesystem policies;
- Workspace portal/junction indirection;
- sandbox regression probes;
- MXC hard-link residual-risk handling.

Reason: the sandbox path introduced substantial compatibility and operational complexity for normal local-agent workloads, including pnpm path canonicalization failures. Junius therefore does not currently use MXC as its process-isolation layer.

This changes the current security implementation only. It does not change Junius's product positioning as a Local Agent.

## Current priorities

Machine Capability v1 is implemented and locally validated.

Authorization UX v1 is implemented and locally validated.

The next architecture milestone is Desktop Automation v1.

OS-level sandboxing is not part of the current execution implementation.

## Verified execution status

The current non-sandbox execution architecture has passed a real black-box MCP test with two Workspaces.

The same ChatGPT request caused Junius to route:

```text
Junius -> pnpm run check
Weave   -> pnpm run typecheck
```

The Junius command completed successfully. The Weave command reached TypeScript and returned a project compilation diagnostic with a nonzero exit code.

Therefore the following current architecture path is verified in real use:

```text
project-name resolution
-> list_workspaces
-> explicit Workspace routing
-> Workspace argument grant
-> machine capability policy
-> direct ProcessCapability
-> Workspace cwd
-> pnpm
-> project tool
-> stdout/stderr/exit-code propagation
```

A project command returning a nonzero exit code is treated as workload output, not evidence of a Junius routing/execution failure when the underlying tool actually ran and its diagnostics were returned.

## Verified Workspace file-tool status

The first Local Agent file capability set has passed real black-box validation through ChatGPT.

The tested user-level workflows covered:

```text
project-name resolution
-> ls
-> read
-> rg
-> write(create)
-> write(exact-text edit)
-> Workspace path rejection outside the registered root
```

The user did not need to provide internal Workspace IDs, capability keys, raw MCP calls, SHA values, revisions, or version tokens.

The same test session also confirmed that the existing multi-Workspace command path continued to route Junius and Weave independently.

This verifies the intended separation:

```text
built-in file tools
-> Junius-enforced Workspace-relative file boundary

run_command
-> authorized local process execution
-> no claim of OS sandbox containment
```

Workspace Files v1 is therefore considered implemented and black-box verified.



## Verified Job Manager status

Job Manager v1 has passed real black-box validation through ChatGPT.

The validated interaction was:

```text
user asks for Junius full check as a background task
-> start_job
-> job status inspection
-> captured output inspection
-> wait_job
-> terminal succeeded state
```

The verified execution returned exit code `0` and ran the real Junius full-check path (`pnpm typecheck && pnpm test`). The observed suite completed with 32 passing tests and no failures, cancellations, or skips.

This confirms that the background process path, job identity, status transitions, captured output, wait semantics, and existing Workspace/capability authorization work together through the real MCP surface.


## Verified Browser capability status

Browser capability v1 has passed real black-box validation through ChatGPT using the local `playwright-cli` installation.

The observed lifecycle confirmed:

```text
natural-language browser task
-> playwright_cli
-> visible headed browser
-> CLI-managed named/persistent session
-> browser interaction
-> requested result obtained
-> close session
-> final response
```

This verifies the core browser adapter path and the intended task lifecycle. The browser remains a first-class Local Agent capability independent of Workspace command execution, while playwright-cli continues to own browser/session mechanics.


## Verified Machine Capability status

Machine Capability v1 has passed local validation through the WebUI and runtime path.

The validated lifecycle was:

```text
WebUI capability disable
-> remove from live Capability Registry
-> preserve Workspace grants
-> block new capability execution

WebUI capability enable
-> restore live Capability Registry entry
-> preserved Workspace grants become effective again

Junius restart
-> persisted enabled/disabled preference restored
```

This confirms the intended separation between machine-level capability state, runtime availability, live registry membership, and Workspace authorization.
