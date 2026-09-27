import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const WORKER_AUTH_HEADER =
  "x-junius-worker-token";

export function workerRequestAuthorized(
  req: IncomingMessage,
  expectedToken: string,
): boolean {
  const value =
    req.headers[WORKER_AUTH_HEADER];

  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    return false;
  }

  const actual = Buffer.from(value, "utf8");
  const expected = Buffer.from(
    expectedToken,
    "utf8",
  );

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
