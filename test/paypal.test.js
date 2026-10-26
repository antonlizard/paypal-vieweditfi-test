import test from "node:test";
import assert from "node:assert/strict";
import { PayPal, errorResponse } from "../src/paypal.js";

const env = {
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: "test-secret",
};

test("native Worker fetch keeps its global receiver for OAuth, Orders, and SDK tokens", async (t) => {
  const calls = [];
  // workerd rejects an unrelated receiver before sending any HTTP request.
  // Node's native fetch accepts it, so emulate the stricter host contract.
  t.mock.method(globalThis, "fetch", function (url, init) {
    if (this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect this reference");
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) {
      return Promise.resolve(Response.json({ access_token: init.body.get("response_type") === "client_token" ? "scoped-token" : "rest-token", expires_in: 32400 }));
    }
    return Promise.resolve(Response.json({ id: "ORDER00001", status: "PAYER_ACTION_REQUIRED" }));
  });
  const paypal = new PayPal(env);
  const order = await paypal.api("/v2/checkout/orders", {
    method: "POST", body: { intent: "CAPTURE" }, requestId: "stable-request-id",
  });
  const token = await paypal.clientToken("saved-vault");
  assert.equal(order.id, "ORDER00001");
  assert.equal(token.clientToken, "scoped-token");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.headers.Authorization, "Bearer rest-token");
  assert.equal(calls[1].init.headers["PayPal-Request-Id"], "stable-request-id");
  assert.equal(calls[2].init.body.get("claims[]"), "vault_id:saved-vault");
});

for (const scenario of [
  { name: "TimeoutError", message: "request timed out", reason: "TIMEOUT", code: "PAYPAL_UNREACHABLE", status: 502 },
  { name: "AbortError", message: "request aborted", reason: "ABORTED", code: "PAYPAL_UNREACHABLE", status: 502 },
  { name: "TypeError", message: "fetch failed", reason: "NETWORK_ERROR", code: "PAYPAL_UNREACHABLE", status: 502 },
  { name: "TypeError", message: "Illegal invocation: function called with incorrect this reference", reason: "INVALID_FETCH_CONTEXT", code: "WORKER_FETCH_ERROR", status: 500 },
]) {
  test(`outbound ${scenario.reason} errors report their stage without exposing credentials`, async () => {
    const rawMessage = `${scenario.message}: Authorization=${env.PAYPAL_CLIENT_SECRET}; access_token=private-token`;
    const paypal = new PayPal(env, async () => {
      const error = new Error(rawMessage);
      error.name = scenario.name;
      throw error;
    });
    let caught;
    try { await paypal.token(); } catch (error) { caught = error; }
    assert.ok(caught);
    const response = errorResponse(caught);
    const body = await response.json();
    assert.equal(response.status, scenario.status);
    assert.equal(body.error, scenario.code);
    assert.deepEqual(body.details, { endpoint: "/v1/oauth2/token", reason: scenario.reason });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(env.PAYPAL_CLIENT_SECRET), false);
    assert.equal(serialized.includes("private-token"), false);
    assert.equal(serialized.includes("Authorization="), false);
  });
}
