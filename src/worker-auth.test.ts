import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import {
  WORKER_AUTH_HEADER,
  workerRequestAuthorized,
} from "./worker-auth.js";

function requestWithHeader(
  value: string | string[] | undefined,
): IncomingMessage {
  return {
    headers:
      value === undefined
        ? {}
        : {
            [WORKER_AUTH_HEADER]: value,
          },
  } as IncomingMessage;
}

test("worker auth accepts only the exact internal token", () => {
  const token =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";

  assert.equal(
    workerRequestAuthorized(
      requestWithHeader(token),
      token,
    ),
    true,
  );

  assert.equal(
    workerRequestAuthorized(
      requestWithHeader(
        "1123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
      ),
      token,
    ),
    false,
  );

  assert.equal(
    workerRequestAuthorized(
      requestWithHeader(token.slice(1)),
      token,
    ),
    false,
  );

  assert.equal(
    workerRequestAuthorized(
      requestWithHeader([token]),
      token,
    ),
    false,
  );

  assert.equal(
    workerRequestAuthorized(
      requestWithHeader(undefined),
      token,
    ),
    false,
  );
});
