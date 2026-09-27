import type { IncomingMessage } from "node:http";

export type HostRequestRejection =
  | "host_not_allowed"
  | "origin_not_allowed";

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string"
    ? value
    : undefined;
}

export function hostRequestRejection(
  req: IncomingMessage,
  expectedOrigin: string,
): HostRequestRejection | undefined {
  const expectedHost =
    new URL(expectedOrigin).host;

  if (
    singleHeader(req.headers.host) !==
    expectedHost
  ) {
    return "host_not_allowed";
  }

  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    singleHeader(origin) !== expectedOrigin
  ) {
    return "origin_not_allowed";
  }

  return undefined;
}
