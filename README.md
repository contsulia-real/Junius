# Junius

Junius is a local agent exposed to ChatGPT through MCP.

The repository is currently in the first architecture spike: verify whether ChatGPT refreshes its visible MCP tool list after a runtime tool-list change notification.

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
- Local-only spike control: `http://127.0.0.1:8788`

The MCP server and the local control server deliberately use different ports. Secure MCP Tunnel must route only the MCP endpoint on port `8787`. The control surface on `8788` remains local and is not part of the tunnel.

Ports can be overridden with:

- `JUNIUS_MCP_PORT`
- `JUNIUS_ADMIN_PORT`

## Secure MCP Tunnel

Use OpenAI Secure MCP Tunnel directly. No Cloudflare Tunnel or other public reverse proxy is required for this spike.

The expected path is:

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client
  -> http://127.0.0.1:8787/mcp
```

Start `tunnel-client` using the tunnel configuration generated for the selected OpenAI tunnel. Before testing from ChatGPT, verify that its logs show the `main` MCP channel resolving to:

```text
http://127.0.0.1:8787/mcp
```

and that MCP initialization succeeds.

If a local health listener is enabled, check `/readyz` rather than only `/healthz`. Readiness is the useful signal for MCP probing and discovery.

### Harpoon

Junius does not use Harpoon in this spike.

Harpoon is the tunnel client's separate embedded MCP server for explicitly allowlisted private HTTP callouts. With no Harpoon targets registered, the Harpoon channel is intentionally unroutable and `unsupported_channel` responses on that channel are expected. Do not add a dummy Harpoon target just to suppress those messages.

Runtime Junius MCP traffic belongs on the `main` channel.

## Dynamic tools spike

Junius starts with only `tool_a` visible.

Check the local state:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state
```

Switch to `tool_b`:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/switch/tool_b
```

Switch back to `tool_a`:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/switch/tool_a
```

The switch updates the real MCP tool name rather than putting a second dispatch protocol inside MCP.

For 2025-era MCP clients, the server keeps a stateful Streamable HTTP connection and emits `notifications/tools/list_changed`.

For the 2026-07-28 MCP protocol, the server publishes the tool change through the `subscriptions/listen` mechanism.

## ChatGPT test

For this spike only:

1. Start Junius with `pnpm dev`.
2. Start `tunnel-client` for the OpenAI Secure MCP Tunnel and verify that `main` resolves to `http://127.0.0.1:8787/mcp`.
3. In ChatGPT, create/select the private MCP app using the Tunnel connection and select the same tunnel.
4. For this spike, choose **No authentication**. Do not choose OAuth and do not manually enter OAuth metadata; Junius does not implement OAuth yet.
5. Scan the tools and confirm `tool_a` is discovered.
6. Without refreshing/reconnecting the plugin or starting a new chat, run the local switch command for `tool_b`.
7. In the same ChatGPT conversation, check whether the model-visible MCP tool surface changes from `tool_a` to `tool_b`.
8. Record the result.

The spike tools explicitly advertise `securitySchemes: [{ type: "noauth" }]`. OAuth discovery warnings from `tunnel-client` are therefore not a requirement for this test.

The goal is specifically to test ChatGPT host behavior. A successful protocol-level notification by itself does not prove that ChatGPT refreshes the model-visible tools.

This server is a spike, not the final Junius security configuration. The final authentication and authorization design is intentionally not frozen by this test.

## Dynamic tools spike result

The spike is complete for the current ChatGPT personal MCP app surface.

Observed behavior:

1. The app was created while Junius exposed only `tool_a`.
2. In the same ChatGPT conversation, Junius switched to `tool_b`; ChatGPT still had only the old callable binding and failed to invoke `tool_b`.
3. In a brand-new ChatGPT conversation, the app still exposed only `tool_a`.
4. Disconnecting and reconnecting the app did not refresh the tool catalog.
5. The current ChatGPT UI for this personal MCP app did not expose a Refresh action.
6. Only deleting the MCP app and recreating it caused ChatGPT to scan the server again and expose `tool_b`.

Conclusion:

For the current ChatGPT personal MCP app flow, the model-visible MCP tool catalog behaves as an app-creation snapshot. MCP tool-list change notifications are not sufficient to update the callable tool surface, and reconnecting the existing app is not sufficient either.

Therefore Junius must not use runtime mutation of the real MCP tool list as the normal Workspace capability-switching mechanism. The fallback decision must be made at the Junius architecture level rather than assuming a session reconnect can refresh tools.

## Fixed `run_command` spike

This is the second architecture spike. It tests the fallback selected after the dynamic MCP tool-list experiment failed in ChatGPT.

The MCP tool catalog is now fixed. ChatGPT sees one stable tool:

```text
run_command
```

The tool accepts:

```json
{
  "key": "tool_a",
  "args": []
}
```

The `key` is a Junius capability key. It is not an executable path and it is not a shell command string.

For this spike, the machine Capability Registry contains two synthetic adapters:

```text
tool_a
tool_b
```

The current Workspace Profile starts with only:

```text
tool_a
```

allowed.

The local admin API on port `8788` stands in for the future Junius Dashboard. It changes the Workspace Profile without changing the MCP tool schema.

Check state:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/state
```

Expected initial state:

```json
{
  "registeredKeys": ["tool_a", "tool_b"],
  "allowedKeys": ["tool_a"]
}
```

Switch the Workspace Profile so only `tool_b` is allowed:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/only/tool_b
```

Switch back:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/only/tool_a
```

### ChatGPT test

Because the MCP tool surface changed from the previous dynamic-tool spike to the new fixed `run_command` tool, delete the old Junius MCP app and recreate it once. This is only needed for this migration between spikes.

After recreating the app:

1. In a new ChatGPT conversation, call `run_command` with `key = "tool_a"`. It should succeed.
2. In the same conversation, call `run_command` with `key = "tool_b"`. It should return `capability_not_allowed: tool_b`.
3. Without deleting, recreating, reconnecting, or refreshing the ChatGPT app, run:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/workspace/only/tool_b
```

4. In the same ChatGPT conversation, call `run_command` with `key = "tool_b"`. It should now succeed.
5. Call `run_command` with `key = "tool_a"`. It should now return `capability_not_allowed: tool_a`.

If this works, the tested property is:

```text
fixed ChatGPT MCP tool catalog
        +
dynamic Workspace Profile authorization by key
        =
no ChatGPT app recreation when Workspace permissions change
```

This spike intentionally uses synthetic capability adapters. It does not yet test executable spawning, argument policy, filesystem sandboxing, process-tree restrictions, or the final Dashboard persistence model.
