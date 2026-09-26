import { realpath } from "node:fs/promises";

export interface RuntimeConfig {
  readonly mcpHost: string;
  readonly mcpPort: number;
  readonly adminHost: string;
  readonly adminPort: number;
  readonly workspaceRoot: string;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const requestedWorkspaceRoot =
    process.env.JUNIUS_WORKSPACE_ROOT ?? process.cwd();

  return {
    mcpHost: "127.0.0.1",
    mcpPort: parsePort(process.env.JUNIUS_MCP_PORT, 8787),
    adminHost: "127.0.0.1",
    adminPort: parsePort(process.env.JUNIUS_ADMIN_PORT, 8788),
    workspaceRoot: await realpath(requestedWorkspaceRoot),
  };
}
