# Junius

Architecture: [docs/architecture.md](docs/architecture.md)

Junius is a Local Agent that lets ChatGPT call explicitly authorized local-computer capabilities through MCP.

Junius is an **authorization-controlled local executor**, not an OS security sandbox.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client`

## Run

```powershell
pnpm install
pnpm check
pnpm dev
```

Default local endpoints:

- MCP: `http://127.0.0.1:8787/mcp`
- Local-only admin surface: `http://127.0.0.1:8788`

Optional environment variables:

- `JUNIUS_MCP_PORT`
- `JUNIUS_ADMIN_PORT`
- `JUNIUS_WORKSPACE_ID`
- `JUNIUS_WORKSPACE_ROOT`
- `JUNIUS_WORKSPACE_STATE_PATH`

The Secure MCP Tunnel routes only the MCP endpoint. The admin surface remains local.

## Execution model

Junius exposes stable MCP tools:

```text
list_workspaces()
ls
read
write
rg
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

The admin API is temporary; the final Dashboard persistence format is not frozen.

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

Junius deliberately keeps the MCP surface stable while capabilities and Workspace policy remain runtime data.

The next work should focus on:

- real capability coverage;
- long-running jobs and process lifecycle;
- Dashboard-based Workspace/capability management;
- persistent machine capability configuration;
- clearer authorization UX.

OS-level sandboxing is not part of the current Junius execution model.

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
- `read` reads UTF-8 text files and returns a SHA-256 for stale-write protection.
- `write` validates the whole batch before writing. Existing files require the SHA-256 returned by `read`; it supports either full replacement or exact-text edits.
- `rg` searches with ripgrep using Junius-controlled arguments and a Workspace-scoped target.

The built-in file tools reject absolute paths, `..` traversal, and existing paths that canonicalize outside the registered Workspace. This is a boundary implemented by the file tools themselves; it does not turn `run_command` into a sandbox.

The `rg` tool requires a usable `rg` executable on the Junius process PATH.
