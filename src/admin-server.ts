import type { IncomingMessage, ServerResponse } from "node:http";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { sendJson } from "./http-bridge.js";
import {
  WorkspaceProfile,
  type WorkspaceArgumentGrant,
} from "./workspace-profile.js";

const MAX_BODY_BYTES = 64 * 1024;

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

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: CapabilityRegistry,
  profile: WorkspaceProfile,
  origin: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", origin);

  if (req.method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, {
      workspaceRoot: profile.rootPath,
      registeredCapabilities: registry.list().map((capability) => ({
        key: capability.key,
        description: capability.description,
      })),
      workspaceGrants: profile.grants(),
    });
    return;
  }

  const prefix = "/workspace/grant/";
  if (url.pathname.startsWith(prefix)) {
    const key = decodeURIComponent(url.pathname.slice(prefix.length));

    if (!registry.has(key)) {
      sendJson(res, 400, {
        error: "capability_not_registered",
        key,
      });
      return;
    }

    if (req.method === "DELETE") {
      profile.revoke(key);
      sendJson(res, 200, { workspaceGrants: profile.grants() });
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

        sendJson(res, 200, { workspaceGrants: profile.grants() });
      } catch (error) {
        sendJson(res, 400, {
          error:
            error instanceof Error ? error.message : "invalid_request_body",
        });
      }

      return;
    }
  }

  sendJson(res, 404, { error: "not_found" });
}
