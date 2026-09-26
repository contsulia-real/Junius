# Junius Architecture

## Positioning

Junius is a **Local Agent** that lets ChatGPT use capabilities of the user's local computer through MCP under explicit user-controlled authorization.

Local files and processes are the first implemented capabilities. Browser and later desktop/UI capabilities belong to the same architecture. Junius is not defined by its current command adapter, Workspace model, or authorization mechanism.

```text
Junius
= Local Agent

current capabilities
= files + processes

planned capability families
= browser + other local-computer capabilities

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

Current timeout termination targets the directly spawned process. Junius does not currently guarantee descendant process-tree termination.

Long-running job management remains future work.

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

## Local admin surface

The local admin HTTP surface is a temporary Dashboard stand-in.

It is responsible for:

- listing current state;
- registering/removing Workspaces;
- setting/revoking Workspace capability grants.

It remains local and is not exposed through the Secure MCP Tunnel.

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

The next architecture work should focus on:

1. broader Local Agent capability coverage;
2. long-running job/process lifecycle management;
3. browser capability;
4. Dashboard-based Workspace and capability management;
5. persistent machine-level capability configuration;
6. clearer authorization UX and review flows;
7. later desktop/UI capabilities where appropriate;
8. capability-specific adapters where generic process execution is insufficient.

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

