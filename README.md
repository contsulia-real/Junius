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
4. Start with `tool_a` and confirm ChatGPT sees it.
5. Without refreshing/reconnecting the plugin or starting a new chat, run the local switch command for `tool_b`.
6. In the same ChatGPT conversation, check whether the model-visible MCP tool surface changes from `tool_a` to `tool_b`.
7. Record the result.

The goal is specifically to test ChatGPT host behavior. A successful protocol-level notification by itself does not prove that ChatGPT refreshes the model-visible tools.

This server is a spike, not the final Junius security configuration. The final authentication and authorization design is intentionally not frozen by this test.
