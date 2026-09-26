# Junius

Junius is a Local Agent that lets ChatGPT call explicitly authorized local-computer capabilities through MCP.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client`
- Windows for the current MXC ProcessContainer runtime path

Junius pins:

```text
@microsoft/mxc-sdk 0.8.0
```

## Run

```powershell
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

The initial Workspace ID defaults to `default`. If `JUNIUS_WORKSPACE_ROOT` is not set, the current process working directory is used as that initial Workspace root. Additional Workspaces can be registered through the local admin surface without replacing or activating a global Workspace.

The Secure MCP Tunnel routes only the MCP endpoint. The admin surface remains local.

## MCP schema migration

`run_command` now requires an explicit `workspace` ID:

```text
run_command(workspace, key, args)
```

This is a deliberate schema change required for parallel multi-Workspace routing. Because the current ChatGPT personal-app flow snapshots the MCP tool schema, recreate the Junius App once after pulling this change. Future Workspace registration and permission changes remain runtime data and do not require another App recreation.

## Fixed MCP command model

The current ChatGPT personal-app flow snapshots the MCP tool catalog when the app is created. Runtime `tools/list_changed` and reconnecting did not make tool-list mutations visible reliably, so Junius uses one stable MCP tool:

```text
run_command(workspace, key, args)
```

The execution path is:

```text
ChatGPT
  -> run_command(workspace, key, args)
  -> WorkspaceManager lookup by stable Workspace ID
  -> that Workspace's argument grant
  -> Machine Capability Registry
  -> machine capability argument policy
  -> MxcProcessCapability(cwd = Workspace root)
  -> MXC ProcessContainer
  -> registered executable
```

Each invocation names a registered Workspace ID explicitly. Junius has no global "active Workspace", so multiple Workspaces can execute concurrently without changing shared routing state. Each Workspace authorizes both a capability key and the argument shapes it may use. The machine capability remains the upper bound, so an invocation must pass both the Workspace grant and the capability's own policy. A Workspace ID is not a filesystem path, and a Workspace cannot provide arbitrary executable paths or raw shell command lines.

## Current implementation

The runtime contains:

- `CapabilityRegistry`: machine-level registered capabilities.
- `WorkspaceProfile`: one Workspace root plus that Workspace's per-capability argument grants.
- `WorkspaceManager`: maps stable Workspace IDs to independent profiles; there is no global active Workspace.
- `RunCommandService`: resolves the Workspace ID on every invocation, then performs Workspace argument authorization and capability execution.
- `MxcProcessCapability`: MXC-backed process execution.
- `ProcessCapability`: plain-process baseline used only by unit-level code/tests.
- MCP server exposing the fixed `run_command` tool.
- Local admin server acting as a temporary Dashboard stand-in.

The built-in `node` capability currently permits only:

```text
["--version"]
["-p", "process.platform"]
```

Junius also registers a `pnpm` capability when the running environment exposes a usable pnpm launcher. It permits:

```text
["--version"]
["run", "<script>"]
["run", "<script>", "--", ...scriptArgs]
```

It does not expose `install`, `add`, `exec`, or `dlx`. The `pnpm` capability is registered but is **not automatically authorized** for the active Workspace.

The model supplies only `key + args`. Junius owns the executable path and constructs the Windows command line with trusted quoting.

## Local admin

Inspect all registered Workspaces and machine capabilities:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state
```

The response contains a `workspaces` array. Every entry has its own stable `id`, canonical `rootPath`, and independent capability grants.

Register another Workspace without changing any other Workspace:

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

Grant only selected pnpm argument shapes to that Workspace:

```powershell
$body = @{
  arguments = @(
    @{ mode = "exact";  args = @("--version") }
    @{ mode = "prefix"; args = @("run", "check") }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  http://127.0.0.1:8788/workspaces/weave/grants/pnpm
```

The fixed MCP tool then addresses that Workspace explicitly:

```text
run_command
workspace = weave
key = pnpm
args = ["run", "check"]
```

Another Workspace can use the same `pnpm` capability concurrently with a different grant set and a different MXC working directory.

Revoke one capability grant:

```powershell
Invoke-RestMethod -Method Delete `
  http://127.0.0.1:8788/workspaces/weave/grants/pnpm
```

Remove a registered Workspace:

```powershell
Invoke-RestMethod -Method Delete `
  http://127.0.0.1:8788/workspaces/weave
```

The admin API is temporary; the final Dashboard persistence format is not frozen.

## MXC runtime policy

The current Windows execution adapter uses MXC schema `0.8.0-alpha` with:

- Workspace read/write access.
- Registered executable directory read/execute access.
- Explicit minimal child environment rather than inheriting the host environment.
- Default-deny network egress and ingress.
- Host loopback denied.
- Clipboard disabled.
- Input injection disabled.
- Win32 window subsystem enabled because the tested Node runtime requires it.
- Timeout and output-size limits.

The explicit Windows environment includes the MXC-required `SYSTEMROOT` and `LOCALAPPDATA`, plus Workspace-scoped `TEMP` / `TMP` and any capability-specific allowlisted variables.

## Sandbox regression suite

The exploratory probes have been removed. The remaining files are retained as regression cases for behavior that materially affects the Junius security boundary.

Run all retained MXC regressions with one command:

```powershell
pnpm sandbox:regression
```

On the tested Windows BaseContainer host, the retained regressions have established:

- Direct outside-Workspace reads are blocked.
- Junction/reparse-point outside reads and writes are blocked.
- Workspace writes succeed while direct outside creates/overwrites are blocked.
- Descendant processes inherit the filesystem boundary.
- `detached + unref()` descendants are terminated with the sandbox lifecycle.
- Host loopback is unreachable from the sandbox under the default-deny policy.
- Explicit child environments do not inherit unrelated host variables.
- The real `run_command -> Workspace argument grant -> machine argument policy -> MxcProcessCapability -> MXC` path works.

## Known MXC limitation: NTFS hard-link aliases

NTFS hard links are an accepted residual risk.

A hard link inside an authorized Workspace can name the same underlying file object as a path outside the Workspace. In the tested MXC BaseContainer configuration, the sandbox could read and write that file through the in-Workspace hard-link path.

Therefore Junius does **not** describe the Workspace grant as an absolute object-level filesystem boundary.

Junius currently does not recursively scan or reject Workspace hard links and does not stage/copy the entire Workspace solely to compensate for this limitation. The retained hard-link regression remains in the suite so a future MXC release that changes this behavior can be detected.

## Verified run_command integration

The real fixed `run_command` path has passed through MXC on Windows:

```json
{
  "conclusions": {
    "runCommandVersionWorks": true,
    "runCommandPlatformWorks": true,
    "argumentPolicyStillEnforced": true
  }
}
```

The first real development-tool capability, `pnpm`, is implemented on top of this execution path. Workspace authorization is argument-scoped rather than a per-key boolean, and Workspace selection is explicit per invocation, so multiple Workspaces can run concurrently with different subsets of the same machine capability. Further tools should reuse the same registry/profile/MXC model rather than introducing one-off sandbox probes.


## Workspace discovery

Junius exposes a stable read-only MCP tool:

```text
list_workspaces()
```

It returns the registered Workspace IDs, canonical roots, and per-Workspace capability argument grants. This lets ChatGPT resolve project names such as "Junius" or "Weave" to the correct Workspace without the user having to provide internal Workspace IDs.

When the user refers to a project by name, ChatGPT should use `list_workspaces` before `run_command`.

This is a stable MCP tool, not a dynamic tool-list mutation.

## Workspace state persistence

Workspace registration and per-Workspace capability grants are persisted outside the repository.

Default Windows location:

```text
%LOCALAPPDATA%\Junius\workspace-state.json
```

Override it with:

```text
JUNIUS_WORKSPACE_STATE_PATH
```

The state file is internal, versioned Junius state rather than a public configuration contract. The current format is:

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

- If the state file exists, Junius restores all Workspace IDs, roots, and grants from it.
- If the state file does not exist, Junius creates the configured initial Workspace and immediately writes the first state file.
- An existing but invalid state file fails startup rather than silently discarding authorization state.
- Registering/removing Workspaces and changing/revoking grants writes the new state immediately.
- State writes are serialized so concurrent admin changes cannot race each other.

For one-time migration from a pre-persistence Junius process, the loader also accepts the existing local admin `/state` response shape and ignores its machine-capability metadata.

