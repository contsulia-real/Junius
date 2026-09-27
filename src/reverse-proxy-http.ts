import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { WORKER_AUTH_HEADER } from "./worker-auth.js";

export const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURED_TOOL_RESPONSE_BYTES = 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function copyResponseHeaders(
  headers: IncomingHttpHeaders,
  res: ServerResponse,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }

    res.setHeader(name, value);
  }
}

export function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  contentLength?: number,
): IncomingHttpHeaders {
  const next: IncomingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === WORKER_AUTH_HEADER
    ) {
      continue;
    }
    next[name] = value;
  }

  if (contentLength !== undefined) {
    next["content-length"] = String(contentLength);
  }

  return next;
}

export function headerString(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function headerDurationMs(
  value: string | string[] | undefined,
): number | undefined {
  const text = headerString(value);
  if (text === undefined) return undefined;

  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

export async function readBody(
  req: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    bytes += buffer.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) {
      throw new Error("mcp_request_too_large");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}
