import type { IncomingMessage, ServerResponse } from "node:http";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { sendJson } from "./http-bridge.js";
import { WorkspaceProfile } from "./workspace-profile.js";

export function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: CapabilityRegistry,
  profile: WorkspaceProfile,
  origin: string,
): void {
  const url = new URL(req.url ?? "/", origin);

  if (req.method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, {
      workspaceRoot: profile.rootPath,
      registeredCapabilities: registry.list().map((capability) => ({
        key: capability.key,
        description: capability.description,
      })),
      allowedKeys: profile.allowedKeys(),
    });
    return;
  }

  const route = (
    prefix: string,
  ): string | undefined =>
    url.pathname.startsWith(prefix)
      ? decodeURIComponent(url.pathname.slice(prefix.length))
      : undefined;

  const allowKey = route("/workspace/allow/");
  if (req.method === "POST" && allowKey !== undefined) {
    if (!registry.has(allowKey)) {
      sendJson(res, 400, {
        error: "capability_not_registered",
        key: allowKey,
      });
      return;
    }

    profile.allow(allowKey);
    sendJson(res, 200, { allowedKeys: profile.allowedKeys() });
    return;
  }

  const denyKey = route("/workspace/deny/");
  if (req.method === "POST" && denyKey !== undefined) {
    profile.deny(denyKey);
    sendJson(res, 200, { allowedKeys: profile.allowedKeys() });
    return;
  }

  const onlyKey = route("/workspace/only/");
  if (req.method === "POST" && onlyKey !== undefined) {
    if (!registry.has(onlyKey)) {
      sendJson(res, 400, {
        error: "capability_not_registered",
        key: onlyKey,
      });
      return;
    }

    profile.setOnly(onlyKey);
    sendJson(res, 200, { allowedKeys: profile.allowedKeys() });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}
