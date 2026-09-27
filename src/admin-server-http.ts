import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
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

export function applyAdminSecurityHeaders(
  res: ServerResponse,
): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", ADMIN_CSP);
}

export function assertAdminHost(
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

export function assertMutationAuthorized(
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

export function sendText(
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

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
