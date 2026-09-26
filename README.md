# Junius

Junius is a local agent exposed to ChatGPT through MCP.

The repository is currently in the first architecture spike: verify whether ChatGPT refreshes its visible MCP tool list after a runtime tool-list change notification.

## Requirements

- Node.js 20+
- pnpm 12.6.0

## Run

```powershell
pnpm typecheck
pnpm dev
```

Default local endpoints:

- MCP: `http://127.0.0.1:8787/mcp`
- Local-only spike control: `http://127.0.0.1:8788`

The MCP server and the local control server deliberately use different ports. A Cloudflare Tunnel for the spike should point only at port `8787`; the control surface on `8788` must remain local.

Ports can be overridden with:

- `JUNIUS_MCP_PORT`
- `JUNIUS_ADMIN_PORT`

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
2. Expose only `http://127.0.0.1:8787` through the Cloudflare Tunnel.
3. Configure the private ChatGPT MCP connection to use `https://<your-host>/mcp`.
4. Start with `tool_a` and confirm ChatGPT sees it.
5. Without refreshing/reconnecting the plugin or starting a new chat, run the local switch command for `tool_b`.
6. Ask ChatGPT to use the newly available tool, or inspect whether its visible tool surface changed.
7. Record whether the same conversation changed from `tool_a` to `tool_b`.

The goal is specifically to test ChatGPT host behavior. A successful protocol-level notification by itself does not prove that ChatGPT refreshes the model-visible tools.

This server is a spike, not the final Junius security configuration. Remote MCP authentication is intentionally not decided here; do not leave the temporary public tunnel running after the test.
