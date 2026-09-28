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
import {
  applyAdminSecurityHeaders,
  assertAdminHost,
  assertMutationAuthorized,
  MUTATING_METHODS,
  readJsonBody,
  sendText,
} from "./admin-server-http.js";
import {
  parseArgumentGrants,
  parseWorkspaceRegistration,
} from "./admin-server-input.js";
import { workspaceAdminState } from "./admin-server-state.js";

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
    req.method === "GET" &&
    segments.length === 2 &&
    segments[0] === "capabilities" &&
    segments[1] === "executables"
  ) {
    const query =
      url.searchParams.get("q") ?? "";
    const rawLimit = Number(
      url.searchParams.get("limit") ?? "50",
    );
    const executables =
      await machineCapabilities
        .discoverExecutables(
          query,
          Number.isFinite(rawLimit)
            ? rawLimit
            : 50,
        );
    sendJson(res, 200, {
      executables,
    });
    return;
  }

  if (
    req.method === "POST" &&
    segments.length === 1 &&
    segments[0] === "capabilities"
  ) {
    try {
      const capability =
        await machineCapabilities.upsertCustom(
          await readJsonBody(req),
        );
      sendJson(res, 201, { capability });
    } catch (error) {
      sendJson(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : "invalid_request_body",
      });
    }
    return;
  }

  if (
    req.method === "DELETE" &&
    segments.length === 2 &&
    segments[0] === "capabilities"
  ) {
    try {
      const removed =
        await machineCapabilities.removeCustom(
          segments[1],
        );
      sendJson(res, removed ? 200 : 404, {
        removed,
        key: segments[1],
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "invalid_request";
      sendJson(
        res,
        message.startsWith(
          "machine_capability_builtin_not_removable:",
        )
          ? 400
          : 404,
        { error: message },
      );
    }
    return;
  }

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
