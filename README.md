# Junius

Junius is a local agent exposed to ChatGPT through MCP.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client`

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

If `JUNIUS_WORKSPACE_ROOT` is not set, the current process working directory is used as the spike Workspace root.

The Secure MCP Tunnel routes only the MCP endpoint. The admin surface remains local.

## Frozen result: ChatGPT tool catalog

The dynamic-MCP-tools spike failed for the current personal MCP app flow.

Observed behavior:

1. The app was created while Junius exposed one tool.
2. Changing the real MCP tool list did not update the same ChatGPT conversation.
3. A new conversation still used the old tool snapshot.
4. Disconnecting and reconnecting the app still used the old snapshot.
5. The current personal MCP app UI exposed no Refresh action.
6. Only deleting and recreating the MCP app caused ChatGPT to scan the changed tool catalog.

Therefore Junius does not use runtime MCP tool-list mutation for Workspace capability switching.

## Frozen result: fixed `run_command`

The second spike passed.

ChatGPT sees one stable MCP tool:

```text
run_command(key, args)
```

Workspace authorization changes behind that fixed schema took effect immediately in the same ChatGPT conversation.

The architecture baseline is:

```text
ChatGPT
  -> fixed run_command(key, args)
  -> Machine Capability Registry
  -> Workspace Profile authorization
  -> per-capability policy
  -> execution adapter
```

A Workspace can be authorized to use registered capability keys, but it cannot provide an executable path or create arbitrary shell access.

## Current implementation stage

The previous synthetic `tool_a/tool_b` adapters have been removed from the runtime.

The code is now split into:

- `CapabilityRegistry`: machine-level registered capabilities.
- `WorkspaceProfile`: the active Workspace root and allowed capability keys.
- `RunCommandService`: resolves a key, enforces Workspace authorization, then invokes the adapter.
- `ProcessCapability`: controlled child-process adapter using `spawn(executable, args, { shell: false })`.
- MCP server: exposes the fixed `run_command` tool.
- Local admin server: temporarily stands in for the future Dashboard.

For the first real process probe, the registry contains one built-in capability:

```text
key: node
executable: the Node.js executable running Junius
```

Its current spike policy permits only these argument vectors:

```text
["--version"]
["-p", "process.platform"]
```

This is intentionally narrow. It proves real process execution and per-key argument policy without turning Node into an arbitrary script runner.

The process adapter also has a timeout and an output-size limit. It does **not** provide OS-level sandboxing or process-tree containment yet.

## Local admin test

Inspect the current state:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state
```

The initial Workspace Profile allows `node`.

Deny it:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/deny/node
```

Allow it again:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/allow/node
```

The admin API remains a temporary Dashboard stand-in; the final Dashboard persistence format is not frozen.

## ChatGPT test for the real adapter

The MCP schema is still the same fixed `run_command`, so the existing Junius MCP app should not need to be deleted or recreated.

In the same ChatGPT conversation:

1. Execute:

```text
run_command
key = node
args = ["--version"]
```

It should return the real Node.js version from a spawned process.

2. Try:

```text
run_command
key = node
args = ["-e", "console.log('not allowed')"]
```

It should return:

```text
arguments_not_allowed: node
```

3. Deny `node` through the local admin endpoint, then invoke the allowed `--version` vector again. It should return:

```text
capability_not_allowed: node
```

4. Allow `node` again and invoke:

```text
run_command
key = node
args = ["-p", "process.platform"]
```

It should execute successfully.

A successful result proves that a fixed ChatGPT MCP tool can use a newly changed runtime capability registry/profile without changing the MCP schema.

## Security boundary still unverified

This stage is **not** the Windows Sandbox spike.

Current process execution has:

- explicit executable chosen by the machine registry
- argument policy
- fixed Workspace cwd
- cleaned environment
- `shell: false`
- timeout
- output-size limit

It does not yet prove that a spawned process cannot read outside the Workspace, create unrestricted child processes, or access the network.

The next security spike still needs to investigate Windows restricted tokens, Job Objects, ACL boundaries, reparse-point escape handling, and possibly AppContainer or another isolation mechanism.

## Current security spike: Windows child-process isolation baseline

Before implementing an OS sandbox, Junius keeps a reproducible baseline for the exact problem the sandbox must fix.

Run:

```powershell
pnpm sandbox:probe
```

The probe:

1. Creates a temporary Workspace.
2. Creates one file inside that Workspace.
3. Creates a separate secret file outside the Workspace.
4. Creates a junction/reparse path inside the Workspace pointing at the outside directory when the OS permits it.
5. Uses the real `ProcessCapability` implementation to launch a Node child with:
   - fixed Workspace `cwd`
   - explicit executable
   - exact argument allowlist
   - cleaned environment
   - `shell: false`
6. The child attempts to read:
   - the inside file
   - the outside file directly
   - the outside file through the junction/reparse path

The result contains:

```json
{
  "conclusions": {
    "workspaceReadWorks": true,
    "directOutsideReadBlocked": false,
    "reparseOutsideReadBlocked": false
  }
}
```

At the current stage, `directOutsideReadBlocked: false` is expected: fixing the process working directory and using `shell: false` do not constrain the child process's filesystem access.

If junction creation is unavailable on the machine, `reparseOutsideReadBlocked` is `null` and the report includes the setup failure instead of pretending that case was tested.

This probe is the persistent regression path for the Windows sandbox work. A future isolation implementation is not considered successful until the same probe still reads the Workspace file while the outside reads are blocked under the original conditions.

The probe does not expose any new MCP tool and does not grant ChatGPT arbitrary Node execution.
