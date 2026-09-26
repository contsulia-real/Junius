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
- `JUNIUS_WORKSPACE_ROOT`

If `JUNIUS_WORKSPACE_ROOT` is not set, the current process working directory is used as the Workspace root.

The Secure MCP Tunnel routes only the MCP endpoint. The admin surface remains local.

## Fixed MCP command model

The current ChatGPT personal-app flow snapshots the MCP tool catalog when the app is created. Runtime `tools/list_changed` and reconnecting did not make tool-list mutations visible reliably, so Junius uses one stable MCP tool:

```text
run_command(key, args)
```

The execution path is:

```text
ChatGPT
  -> run_command(key, args)
  -> Machine Capability Registry
  -> Workspace Profile argument grant
  -> machine capability argument policy
  -> MxcProcessCapability
  -> MXC ProcessContainer
  -> registered executable
```

A Workspace authorizes both a registered capability key and the argument shapes it may use. The machine capability remains the upper bound, so an invocation must pass both the Workspace grant and the capability's own policy. A Workspace cannot provide arbitrary executable paths or raw shell command lines.

## Current implementation

The runtime contains:

- `CapabilityRegistry`: machine-level registered capabilities.
- `WorkspaceProfile`: active Workspace root plus per-capability argument grants.
- `RunCommandService`: capability resolution plus Workspace argument authorization before capability execution.
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

Inspect the current state:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state
```

The response contains `workspaceGrants`, not a flat list of allowed keys.

A grant has explicit argument rules. `exact` matches one complete argument vector; `prefix` allows additional trailing arguments, but the machine capability policy must still accept the final invocation.

For example, authorize only `pnpm --version`, `pnpm run check`, and arguments passed through to that script:

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
  http://127.0.0.1:8788/workspace/grant/pnpm
```

That Workspace may then call:

```text
run_command
key = pnpm
args = ["run", "check"]
```

or:

```text
run_command
key = pnpm
args = ["run", "check", "--", "--fix"]
```

but `["run", "build"]` is rejected by the Workspace Profile even though the machine-level pnpm capability knows how to run package scripts.

Revoke the entire pnpm grant with:

```powershell
Invoke-RestMethod -Method Delete http://127.0.0.1:8788/workspace/grant/pnpm
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

The first real development-tool capability, `pnpm`, is implemented on top of this execution path. Workspace authorization is argument-scoped rather than a per-key boolean, so different Workspaces can expose different subsets of the same machine capability. Further tools should reuse the same registry/profile/MXC model rather than introducing one-off sandbox probes.
