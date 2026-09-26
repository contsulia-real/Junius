import type { IncomingMessage, ServerResponse } from "node:http";
import { CapabilityRegistry } from "./capabilities/registry.js";
import {
  ADMIN_DASHBOARD_CSS,
  ADMIN_DASHBOARD_HTML,
  ADMIN_DASHBOARD_JS,
} from "./admin-webui.js";
import { sendJson } from "./http-bridge.js";
import { JobManager, JobManagerError } from "./job-manager.js";
import { MachineCapabilityManager } from "./machine-capabilities.js";
import { PlaywrightCliService } from "./playwright-cli.js";
import { DesktopComputerUseService } from "./desktop-computer-use.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";
import type { WorkspaceArgumentGrant } from "./workspace-profile.js";

const MAX_BODY_BYTES = 64 * 1024;

function sendText(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", Buffer.byteLength(body));
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > MAX_BODY_BYTES) {
      throw new Error("request_body_too_large");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("request_body_required");
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseArgumentGrants(value: unknown): WorkspaceArgumentGrant[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("arguments_must_be_nonempty_array");
  }

  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("mode" in item) ||
      !("args" in item)
    ) {
      throw new Error("invalid_argument_grant");
    }

    const mode = item.mode;
    const args = item.args;

    if (mode !== "exact" && mode !== "prefix") {
      throw new Error("invalid_argument_grant_mode");
    }

    if (
      !Array.isArray(args) ||
      !args.every((arg): arg is string => typeof arg === "string")
    ) {
      throw new Error("invalid_argument_grant_args");
    }

    if (mode === "prefix" && args.length === 0) {
      throw new Error("empty_prefix_not_allowed");
    }

    return {
      mode,
      args,
    };
  });
}

function parseWorkspaceRegistration(
  value: unknown,
): { id: string; rootPath: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("rootPath" in value) ||
    typeof value.id !== "string" ||
    typeof value.rootPath !== "string"
  ) {
    throw new Error("workspace_id_and_root_required");
  }

  return {
    id: value.id,
    rootPath: value.rootPath,
  };
}

function sendJobError(
  res: ServerResponse,
  error: unknown,
): void {
  if (error instanceof JobManagerError) {
    sendJson(res, error.code === "job_not_found" ? 404 : 400, {
      error: error.code,
      message: error.message,
    });
    return;
  }

  throw error;
}

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: CapabilityRegistry,
  machineCapabilities: MachineCapabilityManager,
  workspaces: WorkspaceManager,
  workspaceStateStore: WorkspaceStateStore,
  jobs: JobManager,
  playwrightCli: PlaywrightCliService,
  desktop: DesktopComputerUseService,
  origin: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", origin);

  if (req.method === "GET" && url.pathname === "/") {
    sendText(
      res,
      200,
      "text/html; charset=utf-8",
      ADMIN_DASHBOARD_HTML,
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard.css") {
    sendText(
      res,
      200,
      "text/css; charset=utf-8",
      ADMIN_DASHBOARD_CSS,
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard.js") {
    sendText(
      res,
      200,
      "text/javascript; charset=utf-8",
      ADMIN_DASHBOARD_JS,
    );
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/state" || url.pathname === "/api/state")
  ) {
    sendJson(res, 200, {
      registeredCapabilities: registry.list().map((capability) => ({
        key: capability.key,
        description: capability.description,
      })),
      machineCapabilities: machineCapabilities.list(),
      workspaces: workspaces.list(),
      jobs: jobs.list(),
      browser: playwrightCli.state(),
      desktop: desktop.state(),
    });
    return;
  }

  const rawSegments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);

  const segments =
    rawSegments[0] === "api"
      ? rawSegments.slice(1)
      : rawSegments;

  if (
    req.method === "POST" &&
    segments.length === 2 &&
    segments[0] === "capabilities"
  ) {
    try {
      const body = await readJsonBody(req);

      if (
        typeof body !== "object" ||
        body === null ||
        !("enabled" in body) ||
        typeof body.enabled !== "boolean"
      ) {
        throw new Error("enabled_boolean_required");
      }

      const capability = await machineCapabilities.setEnabled(
        segments[1],
        body.enabled,
      );

      sendJson(res, 200, { capability });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "invalid_request_body";

      sendJson(
        res,
        message.startsWith("machine_capability_not_known:")
          ? 404
          : 400,
        { error: message },
      );
    }
    return;
  }

  if (
    req.method === "POST" &&
    segments.length === 1 &&
    segments[0] === "workspaces"
  ) {
    try {
      const registration = parseWorkspaceRegistration(
        await readJsonBody(req),
      );
      await workspaces.register(
        registration.id,
        registration.rootPath,
      );
      await workspaceStateStore.save(workspaces);
      sendJson(res, 201, {
        workspace: workspaces
          .list()
          .find((workspace) => workspace.id === registration.id),
      });
    } catch (error) {
      sendJson(res, 400, {
        error:
          error instanceof Error ? error.message : "invalid_request_body",
      });
    }
    return;
  }

  if (
    segments.length === 2 &&
    segments[0] === "workspaces" &&
    req.method === "DELETE"
  ) {
    const id = segments[1];
    const removed = workspaces.remove(id);
    if (removed) {
      await workspaceStateStore.save(workspaces);
    }
    sendJson(res, removed ? 200 : 404, {
      removed,
      id,
    });
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === "workspaces" &&
    segments[2] === "grants"
  ) {
    const workspaceId = segments[1];
    const key = segments[3];
    const profile = workspaces.get(workspaceId);

    if (profile === undefined) {
      sendJson(res, 404, {
        error: "workspace_not_registered",
        workspace: workspaceId,
      });
      return;
    }

    if (!registry.has(key)) {
      sendJson(res, 400, {
        error: "capability_not_registered",
        key,
      });
      return;
    }

    if (req.method === "DELETE") {
      profile.revoke(key);
      await workspaceStateStore.save(workspaces);
      sendJson(res, 200, {
        workspace: workspaceId,
        grants: profile.grants(),
      });
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);

        if (
          typeof body !== "object" ||
          body === null ||
          !("arguments" in body)
        ) {
          throw new Error("arguments_required");
        }

        profile.setGrant({
          key,
          arguments: parseArgumentGrants(body.arguments),
        });
        await workspaceStateStore.save(workspaces);

        sendJson(res, 200, {
          workspace: workspaceId,
          grants: profile.grants(),
        });
      } catch (error) {
        sendJson(res, 400, {
          error:
            error instanceof Error ? error.message : "invalid_request_body",
        });
      }

      return;
    }
  }

  if (
    segments.length === 3 &&
    segments[0] === "jobs" &&
    segments[2] === "output" &&
    req.method === "GET"
  ) {
    try {
      const stream =
        url.searchParams.get("stream") === "stderr"
          ? "stderr"
          : "stdout";

      sendJson(res, 200, {
        output: jobs.readOutput(
          segments[1],
          stream,
          0,
          256 * 1024,
        ),
      });
    } catch (error) {
      sendJobError(res, error);
    }
    return;
  }

  if (
    segments.length === 3 &&
    segments[0] === "jobs" &&
    segments[2] === "cancel" &&
    req.method === "POST"
  ) {
    try {
      sendJson(res, 200, {
        job: await jobs.cancel(segments[1]),
      });
    } catch (error) {
      sendJobError(res, error);
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}
