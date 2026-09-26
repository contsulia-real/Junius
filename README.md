# Junius

Junius is a local agent exposed to ChatGPT through MCP.

The project is currently validating the fixed MCP tool-surface design that follows from the completed dynamic-tool spike.

## Requirements

- Node.js 20+
- pnpm 12.6.0
- OpenAI Secure MCP Tunnel `tunnel-client`

## Run

```powershell
pnpm typecheck
pnpm dev
```

Default local endpoints:

- MCP: `http://127.0.0.1:8787/mcp`
- Local-only admin/spike control: `http://127.0.0.1:8788`

The Secure MCP Tunnel must route only the MCP endpoint on port `8787`. The admin surface on `8788` remains local.

Ports can be overridden with:

- `JUNIUS_MCP_PORT`
- `JUNIUS_ADMIN_PORT`

## Secure MCP Tunnel

The expected path is:

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client
  -> http://127.0.0.1:8787/mcp
```

Junius does not use Harpoon in these spikes. Runtime Junius MCP traffic belongs on the `main` channel.

For these architecture spikes, the MCP tools use no authentication. Final authentication is not frozen yet.

## Completed spike: dynamic MCP tools

The first spike tested whether Junius could change its real MCP tool list at runtime and have ChatGPT update automatically.

Observed behavior in the current personal MCP app flow:

1. The app was created while Junius exposed only `tool_a`.
2. Junius switched its real MCP tool list to `tool_b`; the same ChatGPT conversation did not acquire `tool_b`.
3. A new ChatGPT conversation still used the old `tool_a` snapshot.
4. Disconnecting and reconnecting the existing app did not refresh the catalog.
5. The current personal MCP app UI exposed no Refresh action.
6. Only deleting the MCP app and recreating it caused ChatGPT to scan the server again and expose `tool_b`.

Conclusion:

```text
runtime MCP tools/list mutation
!=
runtime ChatGPT callable-tool mutation
```

Junius therefore does not use dynamic real MCP tools as the normal Workspace capability-switching mechanism.

## Current spike: fixed `run_command`

The MCP tool catalog is now fixed. ChatGPT sees one stable tool:

```text
run_command
```

Its input is:

```json
{
  "key": "tool_a",
  "args": []
}
```

The `key` is a Junius capability key. It is not an executable path and it is not a shell command string.

The fixed MCP schema deliberately uses `key: string` rather than an enum. Capability keys and Workspace authorization are runtime Junius state; changing them must not require changing the MCP schema or recreating the ChatGPT app.

For this spike, the machine Capability Registry contains two synthetic adapters:

```text
tool_a
tool_b
```

The in-memory Workspace Profile initially allows only:

```text
tool_a
```

The local admin API on port `8788` stands in for the future Junius Dashboard. It changes the Workspace Profile without changing the MCP tool catalog.

### Local state

Check the current registry and Workspace Profile:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state
```

Expected initial state after starting Junius:

```json
{
  "registeredKeys": ["tool_a", "tool_b"],
  "allowedKeys": ["tool_a"]
}
```

Make `tool_b` the only allowed capability:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/only/tool_b
```

Switch back:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/only/tool_a
```

### ChatGPT test

The MCP tool surface has changed since the previous spike, so delete the old Junius MCP app and recreate it once. The recreated app should discover only the fixed `run_command` tool.

Then, in one ChatGPT conversation:

1. Ask Junius to call `run_command` with `key = "tool_a"` and `args = []`. It should succeed.
2. Ask Junius to call `run_command` with `key = "tool_b"` and `args = []`. It should return `capability_not_allowed: tool_b`.
3. Without deleting, recreating, reconnecting, refreshing, or starting a new chat, run locally:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/only/tool_b
```

4. In the same ChatGPT conversation, call `run_command` with `key = "tool_b"`. It should now succeed.
5. In the same conversation, call `run_command` with `key = "tool_a"`. It should now return `capability_not_allowed: tool_a`.

A successful result proves this property:

```text
fixed ChatGPT MCP tool catalog
        +
runtime Workspace Profile authorization by capability key
        =
Workspace permission changes without ChatGPT app recreation
```

This spike intentionally uses synthetic capability adapters. It does not yet test executable spawning, argument policy, filesystem sandboxing, process-tree restrictions, or the final Dashboard persistence model.
