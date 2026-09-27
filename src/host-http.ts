import type { ServerResponse } from "node:http";

export function sendHostJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);

  res.statusCode = status;
  res.setHeader(
    "content-type",
    "application/json; charset=utf-8",
  );
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}
