import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { isConfigurationMutationRequest } from "./reverse-proxy-routing.js";

function request(
  method: string,
  url: string,
): IncomingMessage {
  return {
    method,
    url,
  } as IncomingMessage;
}

test("configuration mutation classifier includes custom capability create and delete", () => {
  assert.equal(
    isConfigurationMutationRequest(
      request("POST", "/capabilities"),
    ),
    true,
  );
  assert.equal(
    isConfigurationMutationRequest(
      request(
        "POST",
        "/api/capabilities",
      ),
    ),
    true,
  );
  assert.equal(
    isConfigurationMutationRequest(
      request(
        "DELETE",
        "/capabilities/custom_node",
      ),
    ),
    true,
  );
  assert.equal(
    isConfigurationMutationRequest(
      request(
        "GET",
        "/capabilities/custom_node",
      ),
    ),
    false,
  );
});
