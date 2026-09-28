import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { hostRequestRejection } from "./host-request-security.js";

function request(
  headers: Record<string, string | undefined>,
): IncomingMessage {
  return { headers } as IncomingMessage;
}

test("host request security enforces exact loopback Host and browser origin", () => {
  const origin = "http://127.0.0.1:8787";

  for (const headers of [
    { host: "127.0.0.1:8787" },
    {
      host: "127.0.0.1:8787",
      origin,
      "sec-fetch-site": "same-origin",
    },
    {
      host: "127.0.0.1:8787",
      "sec-fetch-site": "none",
    },
  ]) {
    assert.equal(
      hostRequestRejection(request(headers), origin),
      undefined,
    );
  }

  assert.equal(
    hostRequestRejection(
      request({ host: "example.invalid" }),
      origin,
    ),
    "host_not_allowed",
  );

  assert.equal(
    hostRequestRejection(
      request({
        host: "127.0.0.1:8787",
        origin: "https://example.invalid",
      }),
      origin,
    ),
    "origin_not_allowed",
  );

  for (const fetchSite of ["cross-site", "same-site"]) {
    assert.equal(
      hostRequestRejection(
        request({
          host: "127.0.0.1:8787",
          "sec-fetch-site": fetchSite,
        }),
        origin,
      ),
      "origin_not_allowed",
    );
  }
});
