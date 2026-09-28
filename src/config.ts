import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeConfig {
  readonly mcpHost: string;
  readonly mcpPort: number;
  readonly controlHost: string;
  readonly controlPort: number;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly workspaceStatePath: string;
}

function defaultJuniusStatePath(
  override: string | undefined,
  fileName: string,
): string {
  if (override !== undefined) {
    return override;
  }

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      join(
        homedir(),
        "AppData",
        "Local",
      );

    return join(
      localAppData,
      "Junius",
      fileName,
    );
  }

  const stateRoot =
    process.env.XDG_STATE_HOME ??
    join(
      homedir(),
      ".local",
      "state",
    );

  return join(
    stateRoot,
    "Junius",
    fileName,
  );
}

function defaultWorkspaceStatePath(): string {
  return defaultJuniusStatePath(
    process.env
      .JUNIUS_WORKSPACE_STATE_PATH,
    "workspace-state.json",
  );
}

function parsePort(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `Invalid port: ${value}`,
    );
  }

  return port;
}

export async function loadRuntimeConfig():
  Promise<RuntimeConfig> {
  const requestedWorkspaceRoot =
    process.env
      .JUNIUS_WORKSPACE_ROOT ??
    process.cwd();

  return {
    mcpHost: "127.0.0.1",
    mcpPort: parsePort(
      process.env.JUNIUS_MCP_PORT,
      8787,
    ),
    controlHost: "127.0.0.1",
    controlPort: parsePort(
      process.env.JUNIUS_CONTROL_PORT,
      8788,
    ),
    workspaceId:
      process.env
        .JUNIUS_WORKSPACE_ID ??
      "default",
    workspaceRoot:
      await realpath(
        requestedWorkspaceRoot,
      ),
    workspaceStatePath:
      defaultWorkspaceStatePath(),
  };
}
