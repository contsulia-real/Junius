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

### git

Git is a machine-level `ProcessCapability` and is invoked through the same existing command surface:

```text
run_command(workspace, "git", args)
```

The Git adapter resolves a local Git executable and owns a bounded machine-level argument policy. It supports repository initialization, status, staging, commits, local identity configuration, branch/remote inspection and updates, fetch/push, rev-parse, diff/log, and ls-files.

The policy permits explicit force pushes because local-source-of-truth synchronization can require replacing the remote branch. It does not expose `clean`, `reset --hard`, arbitrary aliases, mirror pushes, or remote branch deletion.

Workspace grants remain required and can only narrow this machine-level Git policy.

## Machine Capability state

Built-in process capabilities have persistent machine-level enablement state.

Current managed keys:

```text
node
pnpm
git
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

