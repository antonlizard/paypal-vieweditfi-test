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

test("payment traces retain REST bodies while redacting credentials and tokens recursively", async () => {
  const trace = {};
  const settings = { ...env, BASIC_AUTH_PASSWORD: "private-site-password" };
  const raw = {
    id: "ORDER00001", status: "PAYER_ACTION_REQUIRED",
    diagnostic: `Echo ${settings.PAYPAL_CLIENT_SECRET} and server-access-token and private-site-password`,
    nested: [{ authorization: "Bearer secret-value", client_secret: "arbitrary-secret", clientToken: "private-sdk-token", access_token: "private-token", password: "another-password" }],
    payment_source: { paypal: { vault_id: "visible-vault-id" } },
  };
  const paypal = new PayPal(settings, async (url) => url.endsWith("/v1/oauth2/token") ?
    Response.json({ access_token: "server-access-token", expires_in: 300 }) :
    Response.json(raw, { status: 201, headers: { "paypal-debug-id": "safe-debug", "set-cookie": "private-cookie" } }));
  const result = await paypal.api("/v2/checkout/orders", {
    method: "POST", body: { intent: "CAPTURE", client_secret: "request-secret" }, requestId: "test-request", trace,
  });
  assert.deepEqual(result, raw); // Business responses are not mutated.
  assert.equal(trace.response.status, 201);
  assert.equal(trace.response.body.id, raw.id);
  assert.equal(trace.response.body.payment_source.paypal.vault_id, "visible-vault-id");
  assert.equal(trace.request.body.client_secret, "[REDACTED]");
  assert.equal(trace.response.headers["paypal-debug-id"], "safe-debug");
  const serialized = JSON.stringify(trace);
  for (const secret of [settings.PAYPAL_CLIENT_SECRET, settings.BASIC_AUTH_PASSWORD, "server-access-token", "arbitrary-secret", "private-sdk-token", "private-token", "another-password", "request-secret", "private-cookie"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("failed OAuth is not exposed as an Orders response or an attempted Orders call", async () => {
  const trace = {};
  const paypal = new PayPal(env, async () => Response.json({ error: "invalid_client", error_description: `Rejected ${env.PAYPAL_CLIENT_SECRET}` }, { status: 401 }));
  await assert.rejects(paypal.api("/v2/checkout/orders", { method: "POST", body: {}, trace }));
  assert.equal(trace.attempted, false);
  assert.equal(trace.response, null);
  assert.equal(trace.request.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders");
  assert.equal(JSON.stringify(trace).includes(env.PAYPAL_CLIENT_SECRET), false);
});

test("a non-JSON PayPal error response remains available as escaped display data", async () => {
  const trace = {};
  const paypal = new PayPal(env, async (url) => url.endsWith("/v1/oauth2/token") ?
    Response.json({ access_token: "rest-token", expires_in: 300 }) : new Response("<html>Gateway unavailable</html>", { status: 503 }));
  await assert.rejects(paypal.api("/v2/checkout/orders", { method: "POST", body: {}, trace }));
  assert.equal(trace.response.status, 503);
  assert.equal(trace.response.body, "<html>Gateway unavailable</html>");
});
