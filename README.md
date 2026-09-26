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

## Windows sandbox baseline result

The current child-process boundary is confirmed unsafe for filesystem isolation.

Observed with `pnpm sandbox:probe` on Windows:

```json
{
  "conclusions": {
    "workspaceReadWorks": true,
    "directOutsideReadBlocked": false,
    "reparseOutsideReadBlocked": false
  }
}
```

The Node child successfully read the outside secret both by direct path and through a junction inside the Workspace. This exact probe remains the regression path for the sandbox work.

## Windows sandbox API availability probe

Current Microsoft documentation exposes an experimental Windows 11 process-sandbox API from `processmodel.dll`. It can combine AppContainer isolation with explicit filesystem grants and network policy, but it is experimental and cannot be assumed to exist on every supported machine.

Before selecting that architecture, run:

```powershell
pnpm sandbox:api-probe
```

The probe does not create a sandbox or modify system state. It only:

- reads the real Windows build through `RtlGetVersion`
- attempts to load `processmodel.dll` from System32
- checks for `Experimental_CreateProcessInSandbox`
- checks for `Experimental_CreateProcessAsUserInSandbox`

If `candidateUsable` is false, Junius must not depend on the experimental API on that machine. The stable manual AppContainer / access-control / Job Object route remains a separate candidate.

## Microsoft MXC sandbox probe

Junius does not hand-encode the Windows `SandboxSpec` FlatBuffer.

Microsoft publishes the ProcessContainer implementation and a TypeScript SDK as `@microsoft/mxc-sdk`. The SDK owns the policy-to-native translation, packaged Windows executor, host-capability detection, and ProcessContainer tier selection.

For this spike Junius pins:

```text
@microsoft/mxc-sdk 0.8.0
```

The pin is intentional because MXC is still Public Preview.

The current published 0.8.0 package supports the Node version used by this project. Future MXC main-branch requirements are not treated as requirements for this pinned release.

After pulling the dependency change, update the local pnpm installation/lockfile:

```powershell
pnpm install
```

Then run:

```powershell
pnpm check
pnpm sandbox:mxc-probe
```

The MXC probe recreates the same filesystem escape regression as `sandbox:probe`:

- one readable/writable file inside the temporary Workspace
- one secret file outside the Workspace
- one junction inside the Workspace pointing to that outside directory

It requests the abstract `process` containment mode; on Windows MXC resolves that to its ProcessContainer implementation. Only the Workspace is granted read/write. It does not grant the host TEMP directory. Tool discovery is deliberately restricted to the directory containing the exact Node executable so discovery cannot accidentally authorize a drive root and invalidate the test.

The desired result is:

```json
{
  "conclusions": {
    "workspaceReadWorks": true,
    "directOutsideReadBlocked": true,
    "reparseOutsideReadBlocked": true
  }
}
```

The command also preserves the MXC executor's debug stderr. That output is part of the spike evidence because it shows which isolation tier the host actually selected.

Passing this probe demonstrates filesystem confinement for this regression case. It does not by itself finish Junius sandbox validation; child-process containment, network posture, additional path namespace attacks, hard links, device paths, and other Windows escape cases still require separate adversarial tests.

### MXC 0.8 environment note

The first MXC probe attempt supplied a sparse child environment containing `SystemRoot`, `WINDIR`, `TEMP`, and `TMP`. On Windows ProcessContainer, that failed before the workload started:

```text
CreateProcessInSandbox failed with Win32 error 203
```

Microsoft's current MXC source identifies error 203 here as `ERROR_ENVVAR_NOT_FOUND`. A caller-supplied ProcessContainer environment must include both `SYSTEMROOT` and `LOCALAPPDATA`; MXC 0.8 treats an explicit environment as a complete replacement.

The filesystem probe now omits `process.env` entirely so MXC supplies its backend-default user environment. This keeps the filesystem-confinement test focused. Environment minimization remains a separate security test.

### MXC Node initialization note

After fixing the environment block, BaseContainer successfully created the Node process, but Node exited immediately with:

```text
STATUS_DLL_INIT_FAILED (0xC0000142)
```

The MXC debug output showed Win32k/UI system calls were fully blocked. Microsoft's ProcessContainer diagnostics identify this exit code as a common symptom of required UI subsystem access being denied.

The filesystem probe now sets:

```text
ui.allowWindows = true
ui.clipboard = "none"
ui.allowInputInjection = false
```

This does not change the filesystem grant under test. UI confinement remains a separate security dimension and will be tested independently after filesystem confinement is proven.

### Node entry-point path-resolution note

A later probe showed Node failing with `EPERM: lstat 'C:\\'` while resolving a script-file entry point. Granting the whole drive as `readonlyPaths` would invalidate the outside-file regression.

The released SDK remains `@microsoft/mxc-sdk 0.8.0`. The probe therefore keeps schema `0.8.0-alpha` and executes its small probe program through `node -e` instead of a script file. This avoids Node's entry-script realpath traversal without broadening filesystem read permissions.

MXC's repository contains newer schema work such as `0.9.0-alpha`, but that schema version must not be confused with an npm package version.

## MXC filesystem confinement result

The MXC BaseContainer filesystem regression passed on Windows.

Observed with `pnpm sandbox:mxc-probe`:

```json
{
  "conclusions": {
    "workspaceReadWorks": true,
    "directOutsideReadBlocked": true,
    "reparseOutsideReadBlocked": true
  }
}
```

The executor diagnostics also confirmed:

```text
selected isolation tier: base-container
loaded Experimental_CreateProcessInSandbox from processmodel.dll
```

The sandboxed Node process could read the Workspace file, while both the direct outside path and the Workspace junction pointing outside failed with `EPERM`.

This validates filesystem confinement for the original regression case on this host. It does not yet prove descendant-process containment, network confinement, UI isolation, device/NT namespace behavior, hard-link behavior, or the final Junius production sandbox integration.
