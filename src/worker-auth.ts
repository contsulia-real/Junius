import type { IncomingMessage } from "node:http";

export const WORKER_AUTH_HEADER =
  "x-junius-worker-token";

export function workerRequestAuthorized(
  req: IncomingMessage,
  expectedToken: string,
): boolean {
  const value =
    req.headers[WORKER_AUTH_HEADER];

  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === expectedToken
  );
}
