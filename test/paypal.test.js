import test from "node:test";
import assert from "node:assert/strict";
import { PayPal, errorResponse } from "../src/paypal.js";

const env = {
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: "test-secret",
};

test("Orders calls reuse the REST token until expires_in elapses and cache each renewal", async (t) => {
  const startedAt = 1_000_000;
  let now = startedAt, exchanges = 0;
  const authorizations = [];
  t.mock.method(Date, "now", () => now);
  const paypal = new PayPal(env, async (url, init) => {
    if (url.endsWith("/v1/oauth2/token")) {
      exchanges++;
      now += 250; // The network round trip must not extend the token's lifetime.
      return Response.json({ access_token: `rest-token-${exchanges}`, expires_in: exchanges === 1 ? 120 : 300 });
    }
    authorizations.push(init.headers.Authorization);
    return Response.json({ id: "ORDER00001" });
  });
  await paypal.api("/v2/checkout/orders", { method: "POST", body: {} });
  assert.equal(exchanges, 1);
  assert.equal(paypal.accessToken.expiresAt, startedAt + 120_000);
  now = startedAt + 119_999;
  await paypal.api("/v2/checkout/orders/ORDER00001/capture", { method: "POST", body: {} });
  assert.equal(exchanges, 1, "The token remains cached during its final minute");
  now = startedAt + 120_000;
  await paypal.api("/v2/checkout/orders", { method: "POST", body: {} });
  assert.equal(exchanges, 2, "Renew at the exact expiry boundary");
  now = startedAt + 419_999;
  await paypal.api("/v2/checkout/orders/ORDER00001/capture", { method: "POST", body: {} });
  assert.equal(exchanges, 2, "Use the new token's own reported lifetime");
  now = startedAt + 420_000;
  await paypal.api("/v2/checkout/orders/ORDER00001");
  assert.equal(exchanges, 3);
  assert.deepEqual(authorizations, [
    "Bearer rest-token-1", "Bearer rest-token-1", "Bearer rest-token-2", "Bearer rest-token-2", "Bearer rest-token-3",
  ]);
});

test("concurrent callers share one OAuth exchange on initial acquisition and expiry", async (t) => {
  let now = 1_000_000, exchanges = 0, respond;
  t.mock.method(Date, "now", () => now);
  const paypal = new PayPal(env, () => {
    exchanges++;
    return new Promise((resolve) => { respond = resolve; });
  });
  for (const token of ["first-rest-token", "renewed-rest-token"]) {
    const requests = Array.from({ length: 5 }, () => paypal.token());
    assert.equal(exchanges, token === "first-rest-token" ? 1 : 2);
    respond(Response.json({ access_token: token, expires_in: 120 }));
    assert.deepEqual(await Promise.all(requests), Array(5).fill(token));
    assert.equal(await paypal.token(), token);
    now += 120_000;
  }
  assert.equal(exchanges, 2);
});

test("failed renewal does not send an expired token and the next call can retry", async (t) => {
  let now = 1_000_000, exchanges = 0;
  const authorizations = [];
  t.mock.method(Date, "now", () => now);
  const paypal = new PayPal(env, async (url, init) => {
    if (url.endsWith("/v1/oauth2/token")) {
      exchanges++;
      if (exchanges === 2) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      return Response.json({ access_token: `rest-token-${exchanges}`, expires_in: 120 });
    }
    authorizations.push(init.headers.Authorization);
    return Response.json({ id: "ORDER00001" });
  });
  await paypal.api("/v2/checkout/orders");
  now += 120_000;
  await assert.rejects(paypal.api("/v2/checkout/orders"), { code: "PAYPAL_API_ERROR" });
  assert.deepEqual(authorizations, ["Bearer rest-token-1"]);
  await paypal.api("/v2/checkout/orders");
  await paypal.api("/v2/checkout/orders");
  assert.equal(exchanges, 3);
  assert.deepEqual(authorizations, ["Bearer rest-token-1", "Bearer rest-token-3", "Bearer rest-token-3"]);
});

test("missing or invalid OAuth lifetimes are rejected instead of assuming a cache duration", async () => {
  for (const lifetime of [undefined, null, 0, -1, "120", 1.5, Number.MAX_SAFE_INTEGER]) {
    let exchanges = 0, orders = 0;
    const paypal = new PayPal(env, async (url) => {
      if (url.endsWith("/v1/oauth2/token")) {
        exchanges++;
        return Response.json({ access_token: "rest-token", expires_in: exchanges === 1 ? lifetime : 120 });
      }
      orders++;
      return Response.json({ id: "ORDER00001" });
    });
    await assert.rejects(paypal.api("/v2/checkout/orders"), { code: "INVALID_OAUTH_RESPONSE" });
    assert.equal(orders, 0);
    assert.equal(paypal.accessToken, null);
    await paypal.api("/v2/checkout/orders");
    assert.equal(exchanges, 2);
    assert.equal(orders, 1);
  }
});

test("vault-scoped SDK tokens do not replace the cached REST access token", async () => {
  let restExchanges = 0, sdkExchanges = 0;
  const authorizations = [];
  const paypal = new PayPal(env, async (url, init) => {
    if (url.endsWith("/v1/oauth2/token")) {
      const scoped = init.body.get("response_type") === "client_token";
      if (scoped) sdkExchanges++; else restExchanges++;
      return Response.json({ access_token: scoped ? "scoped-sdk-token" : "cached-rest-token", expires_in: 120 });
    }
    authorizations.push(init.headers.Authorization);
    return Response.json({ id: "ORDER00001" });
  });
  await paypal.api("/v2/checkout/orders");
  assert.deepEqual(await paypal.clientToken("saved-vault"), { clientToken: "scoped-sdk-token", expiresIn: 120 });
  await paypal.api("/v2/checkout/orders");
  assert.equal(restExchanges, 1);
  assert.equal(sdkExchanges, 1);
  assert.deepEqual(authorizations, ["Bearer cached-rest-token", "Bearer cached-rest-token"]);
});

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

test("immediate and stored request traces redact credentials while PayPal requests authenticate", async () => {
  const trace = {};
  const settings = { ...env, BASIC_AUTH_PASSWORD: "private-site-password" };
  const raw = {
    id: "ORDER00001", status: "PAYER_ACTION_REQUIRED",
    diagnostic: `Echo ${settings.PAYPAL_CLIENT_SECRET} and server-access-token and private-site-password`,
    nested: [{ authorization: "Bearer secret-value", client_secret: "arbitrary-secret", clientToken: "private-sdk-token", access_token: "private-token", password: "another-password" }],
    payment_source: { paypal: { vault_id: "visible-vault-id" } },
  };
  const paypal = new PayPal(settings, async (url, init) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "server-access-token", expires_in: 300 });
    assert.equal(init.headers.Authorization, "Bearer server-access-token");
    return Response.json(raw, { status: 201, headers: { "paypal-debug-id": "safe-debug", "set-cookie": "private-cookie" } });
  });
  const result = await paypal.api("/v2/checkout/orders", {
    method: "POST", body: { intent: "CAPTURE", client_secret: "request-secret" }, requestId: "test-request", trace,
  });
  assert.deepEqual(result, raw); // Business responses are not mutated.
  assert.equal(trace.response.status, 201);
  assert.equal(trace.response.body.id, raw.id);
  assert.equal(trace.response.body.payment_source.paypal.vault_id, "visible-vault-id");
  assert.equal(trace.request.body.client_secret, "[REDACTED]");
  assert.equal(trace.response.headers["paypal-debug-id"], "safe-debug");
  assert.deepEqual(trace.request.authentication, { method: "Bearer", token: "[REDACTED]" });
  assert.equal(trace.request.headers.Authorization, "[REDACTED]");
  assert.equal(trace.response.body.diagnostic.includes("server-access-token"), false);
  const stored = paypal.safeTrace(trace);
  assert.equal(stored.request.authentication.method, "Bearer");
  assert.equal(stored.request.authentication.token, "[REDACTED]");
  assert.equal(stored.request.headers.Authorization, "[REDACTED]");
  const serialized = JSON.stringify([trace, stored]);
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
  assert.deepEqual(trace.request.authentication, { method: "Bearer", token: null });
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
