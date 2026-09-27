export interface HostConfig {
  readonly mcpHost: "127.0.0.1";
  readonly mcpPort: number;
  readonly adminHost: "127.0.0.1";
  readonly adminPort: number;
}

function parsePort(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid_port: ${value}`);
  }

  return port;
}

export function loadHostConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HostConfig {
  return {
    mcpHost: "127.0.0.1",
    mcpPort: parsePort(environment.JUNIUS_MCP_PORT, 8787),
    adminHost: "127.0.0.1",
    adminPort: parsePort(environment.JUNIUS_ADMIN_PORT, 8788),
  };
}
