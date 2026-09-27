import { timingSafeEqual } from "node:crypto";
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
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function applyAdminSecurityHeaders(
  res: ServerResponse,
): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", ADMIN_CSP);
}

function assertAdminHost(
  req: IncomingMessage,
  origin: string,
): void {
  const expectedHost = new URL(origin).host;
  if (req.headers.host !== expectedHost) {
    throw new Error("admin_host_not_allowed");
  }
}

function secretMatches(
  value: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const actual = Buffer.from(value, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  return (
    actual.length === expectedBytes.length &&
    timingSafeEqual(actual, expectedBytes)
  );
}

function assertMutationAuthorized(
  req: IncomingMessage,
  origin: string,
  adminToken: string,
): void {
  const requestOrigin = req.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    throw new Error("admin_origin_not_allowed");
  }

  if (
    !secretMatches(
      req.headers["x-junius-admin-token"],
      adminToken,
    )
  ) {
    throw new Error("admin_token_required");
  }
}

function assertJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error("application_json_required");
  }
}

function workspaceAdminState(
  workspaces: WorkspaceManager,
  machineCapabilities: MachineCapabilityManager,
) {
  return workspaces.list().map((workspace) => ({
    ...workspace,
    grants: workspace.grants.map((grant) => ({
      ...grant,
      arguments: grant.arguments.map((rule) => ({
        ...rule,
        ...machineCapabilities.workspaceGrantCompatibility(
          grant.key,
          rule,
        ),
      })),
    })),
  }));
}

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
  assertJsonContentType(req);

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
  adminToken: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", origin);
  applyAdminSecurityHeaders(res);

  try {
    assertAdminHost(req, origin);
    if (MUTATING_METHODS.has(req.method ?? "")) {
      assertMutationAuthorized(req, origin, adminToken);
    }
  } catch (error) {
    sendJson(res, 403, {
      error:
        error instanceof Error ? error.message : "admin_request_forbidden",
    });
    return;
  }

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
      workspaces: workspaceAdminState(workspaces, machineCapabilities),
      jobs: await jobs.list(100),
      jobHistory: await jobs.historyStats(),
      ...(url.pathname === "/state"
        ? { adminToken }
        : {}),
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

        const argumentGrants = parseArgumentGrants(body.arguments);
        const existingGrant = profile.grants().find(
          (grant) => grant.key === key,
        );

        for (const grant of argumentGrants) {
          const compatibility =
            machineCapabilities.workspaceGrantCompatibility(key, grant);
          const alreadyPersisted =
            existingGrant?.arguments.some(
              (existing) =>
                existing.mode === grant.mode &&
                existing.args.length === grant.args.length &&
                existing.args.every(
                  (arg, index) => arg === grant.args[index],
                ),
            ) ?? false;

          if (!compatibility.valid && !alreadyPersisted) {
            throw new Error(
              compatibility.reason ?? "arguments_outside_machine_policy",
            );
          }
        }

        profile.setGrant({
          key,
          arguments: argumentGrants,
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
        output: await jobs.readOutput(
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
