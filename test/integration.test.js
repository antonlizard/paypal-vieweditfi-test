import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { VaultStore } from "../src/vault-store.js";

class Storage {
  map = new Map();
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) {
    for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) {
      this.map.set(k, structuredClone(v));
    }
  }
}

function harness() {
  const storage = new Storage();
  const calls = [];
  const orders = new Map();
  const requestIds = new Map();
  let serial = 0;
  const mock = { vaultStatus: "VAULTED", captureStatus: "COMPLETED", directStatus: "COMPLETED", failCapture: false, loseCreateResponse: false, verification: "SUCCESS", charges: 0 };
  const env = {
    PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "sandbox-client-id", PAYPAL_CLIENT_SECRET: "server-only-secret",
    BASIC_AUTH_USERNAME: "editfi", BASIC_AUTH_PASSWORD: "test-only-password", PAYPAL_CURRENCY: "USD", PAYPAL_AMOUNT: "10.00",
    ASSETS: { fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`) },
  };
  let store;
  function completed(order, id, vaultStatus = mock.vaultStatus) {
    const newBuyer = order.body.payment_source.paypal.attributes;
    return {
      id, status: "COMPLETED",
      payment_source: { paypal: {
        email_address: `buyer-${id}@example.test`,
        attributes: { vault: newBuyer ? {
          status: vaultStatus,
          ...(vaultStatus === "VAULTED" ? { id: `vault-${id}` } : {}),
          customer: { id: `customer-${id}` },
        } : undefined },
      } },
      purchase_units: [{ payments: { captures: [{ id: `CAPTURE${id}`, status: mock.captureStatus, amount: { currency_code: "USD", value: "10.00" } }] } }],
    };
  }
  async function transport(url, init) {
    const path = new URL(url).pathname;
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method, headers: init.headers, body });
    if (path === "/v1/oauth2/token") {
      assert.match(init.headers.Authorization, /^Basic /);
      return Response.json({ access_token: body.response_type === "client_token" ? "scoped-browser-token" : "server-access-token", expires_in: 32400 });
    }
    assert.equal(init.headers.Authorization, "Bearer server-access-token");
    if (path === "/v1/notifications/verify-webhook-signature") return Response.json({ verification_status: mock.verification });
    if (path === "/v2/checkout/orders" && init.method === "POST") {
      const requestId = init.headers["PayPal-Request-Id"];
      let order = requestIds.get(requestId);
      if (!order) {
        const id = `ORDER${String(++serial).padStart(5, "0")}`;
        const direct = Boolean(body.payment_source.paypal.vault_id);
        order = { id, body, result: { id, status: "PAYER_ACTION_REQUIRED" } };
        if (direct) {
          mock.charges++;
          order.result = mock.directStatus === "COMPLETED" ? completed(order, id) : { id, status: mock.directStatus };
        }
        orders.set(id, order);
        requestIds.set(requestId, order);
      } else assert.deepEqual(body, order.body, "Idempotent retries must use identical payloads");
      if (mock.loseCreateResponse) { mock.loseCreateResponse = false; throw new Error("response lost after processing"); }
      return Response.json(order.result);
    }
    const match = path.match(/^\/v2\/checkout\/orders\/(ORDER\d+)(\/capture)?$/);
    assert.ok(match, `Unexpected PayPal request ${path}`);
    const order = orders.get(match[1]);
    assert.ok(order);
    if (match[2]) {
      if (mock.failCapture) return Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Payment declined", debug_id: "safe-debug-id" }, { status: 422 });
      order.result = completed(order, order.id);
    }
    return Response.json(order.result);
  }
  function restart() {
    store = new VaultStore({ storage }, env);
    store.paypal.transport = transport;
    env.VAULT_STORE = { idFromName: (name) => name, get: () => store };
  }
  restart();
  async function call(path, body, extra = {}) {
    const headers = {
      Authorization: `Basic ${btoa("editfi:test-only-password")}`,
      "Content-Type": "application/json", "X-EditFI-Request": "1", Origin: "https://test.example",
      ...extra.headers,
    };
    const response = await worker.fetch(new Request(`https://test.example${path}`, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, headers: response.headers, body: value };
  }
  async function newCheckout(capture = true, key = crypto.randomUUID()) {
    const created = await call("/api/orders", { flow: "new", requestId: key });
    assert.equal(created.status, 200);
    const id = created.body.order.id;
    if (capture) assert.equal((await call(`/api/orders/${id}/capture`, {})).status, 200);
    return id;
  }
  return { call, newCheckout, calls, storage, orders, env, mock, restart };
}

test("basic authentication protects pages, assets, and APIs, including failures", async () => {
  const h = harness();
  for (const path of ["/", "/new-customer", "/returning-customer", "/new-customer.html", "/app.js", "/styles.css", "/api/config", "/api/state"]) {
    const result = await h.call(path, undefined, { headers: { Authorization: "" } });
    assert.equal(result.status, 401, path);
    assert.match(result.headers.get("WWW-Authenticate"), /^Basic /);
    assert.match(result.headers.get("Cache-Control"), /no-store/);
  }
  h.env.BASIC_AUTH_PASSWORD = "";
  assert.equal((await h.call("/new-customer")).status, 503);
  assert.equal(h.calls.length, 0);
});

test("authenticated clean page paths route through the asset guard", async () => {
  const h = harness();
  const result = await h.call("/returning-customer");
  assert.equal(result.body, "asset:/returning-customer.html");
  assert.equal(result.headers.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
  assert.equal((await h.call("/private.json")).status, 404);
});

test("only the public client ID is returned; the harness refuses live configuration", async () => {
  const h = harness();
  const result = await h.call("/api/config");
  assert.equal(result.body.clientId, "sandbox-client-id");
  assert.equal(result.body.sdkBase, "https://www.sandbox.paypal.com");
  assert.ok(!JSON.stringify(result.body).includes(h.env.PAYPAL_CLIENT_SECRET));
  h.env.PAYPAL_ENV = "live";
  assert.equal((await h.call("/api/config")).status, 503);
});

test("cross-origin and simple form POSTs cannot initiate payments", async () => {
  const h = harness();
  const body = { flow: "new", requestId: crypto.randomUUID() };
  assert.equal((await h.call("/api/orders", body, { headers: { Origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await h.call("/api/orders", body, { headers: { "X-EditFI-Request": "" } })).status, 403);
  assert.equal((await h.call("/api/orders", body, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal(h.calls.length, 0);
});

test("new customer purchase creates a vault, caches it, and scopes the SDK token correctly", async () => {
  const h = harness();
  const id = await h.newCheckout();
  const create = h.calls.find((call) => call.path === "/v2/checkout/orders");
  const source = create.body.payment_source.paypal;
  assert.deepEqual(source.attributes.vault, { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", permit_multiple_payment_tokens: false });
  assert.match(source.attributes.customer.merchant_customer_id, /^editfi-/);
  assert.equal(source.experience_context.return_url, "https://test.example/new-customer?paypal=return");
  const buyer = (await h.call("/api/state")).body.buyer;
  assert.equal(buyer.vaultId, `vault-${id}`);
  const token = await h.call("/api/client-token", { vaultRevision: buyer.revision, vaultId: "untrusted-vault" });
  assert.equal(token.body.clientToken, "scoped-browser-token");
  const scoped = h.calls.find((call) => call.body?.response_type === "client_token");
  assert.deepEqual(scoped.body, { grant_type: "client_credentials", response_type: "client_token", "claims[]": `vault_id:vault-${id}` });
  assert.ok(!JSON.stringify([...h.storage.map]).includes("scoped-browser-token"));
  assert.ok(!JSON.stringify([...h.storage.map]).includes("server-access-token"));
});

test("returning component uses preferred_payment_source and capture without replacing the vault", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const key = crypto.randomUUID();
  const created = await h.call("/api/orders", { flow: "returning", requestId: key, vaultRevision: buyer.revision });
  const source = h.calls.filter((call) => call.path === "/v2/checkout/orders").at(-1).body.payment_source.paypal;
  assert.equal(source.experience_context.preferred_payment_source.vault_id, buyer.vaultId);
  assert.equal(source.vault_id, undefined);
  assert.equal(source.attributes, undefined);
  await h.call(`/api/orders/${created.body.order.id}/capture`, {});
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
});

test("direct saved-method purchase auto-captures once, including duplicate clicks", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const before = h.calls.filter((call) => call.path.endsWith("/capture")).length;
  const body = { requestId: crypto.randomUUID(), vaultRevision: buyer.revision, vaultId: "attacker-selected-vault", amount: "999.99" };
  const [first, retry] = await Promise.all([h.call("/api/direct-charge", body), h.call("/api/direct-charge", body)]);
  assert.equal(first.body.order.completed, true);
  assert.equal(first.body.order.id, retry.body.order.id);
  assert.equal(h.mock.charges, 1);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/capture")).length, before);
  const payload = h.calls.filter((call) => call.path === "/v2/checkout/orders").at(-1).body;
  assert.equal(payload.payment_source.paypal.vault_id, buyer.vaultId);
  assert.equal(payload.purchase_units[0].amount.value, "10.00");
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
});

test("lost payment response is retried with identical payload and PayPal idempotency key", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const body = { requestId: crypto.randomUUID(), vaultRevision: buyer.revision };
  h.mock.loseCreateResponse = true;
  assert.equal((await h.call("/api/direct-charge", body)).body.error, "PAYPAL_UNREACHABLE");
  h.restart(); // also covers a Worker/Durable Object restart between retries
  const retry = await h.call("/api/direct-charge", body);
  assert.equal(retry.body.order.completed, true);
  assert.equal(h.mock.charges, 1);
  const calls = h.calls.filter((call) => call.headers["PayPal-Request-Id"] === `create-${body.requestId}`);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
});

test("an unresolved create is not reissued after PayPal idempotency protection may expire", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const body = { requestId: crypto.randomUUID(), vaultRevision: buyer.revision };
  h.mock.loseCreateResponse = true;
  await h.call("/api/direct-charge", body);
  const operation = await h.storage.get(`operation:${body.requestId}`);
  operation.createdAt = new Date(Date.now() - 7 * 3600000).toISOString();
  await h.storage.put(`operation:${body.requestId}`, operation);
  assert.equal((await h.call("/api/direct-charge", body)).body.error, "PAYMENT_OUTCOME_UNKNOWN");
  assert.equal(h.mock.charges, 1);
});

test("a fresh object and a new browser still see the same saved buyer", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  h.restart();
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
});

test("only a new successful checkout replaces the saved buyer; capture replay cannot restore the old one", async () => {
  const h = harness();
  const first = await h.newCheckout();
  const initial = (await h.call("/api/state")).body.buyer;
  await h.newCheckout(false); // abandon checkout: preserve existing buyer
  assert.deepEqual((await h.call("/api/state")).body.buyer, initial);
  const latest = await h.newCheckout();
  const updated = (await h.call("/api/state")).body.buyer;
  assert.equal(updated.vaultId, `vault-${latest}`);
  await h.call(`/api/orders/${first}/capture`, {});
  await h.call(`/api/orders/${first}`);
  assert.deepEqual((await h.call("/api/state")).body.buyer, updated);
});

test("an older checkout completing late cannot overwrite a more recent successful checkout", async () => {
  const h = harness();
  const first = await h.newCheckout(false);
  const second = await h.newCheckout();
  await h.call(`/api/orders/${first}/capture`, {});
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, `vault-${second}`);
});

test("stale token, component order, direct charge and capture all reject a replaced buyer", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const pending = await h.call("/api/orders", { flow: "returning", requestId: crypto.randomUUID(), vaultRevision: buyer.revision });
  await h.newCheckout();
  const requests = [
    ["/api/client-token", { vaultRevision: buyer.revision }],
    ["/api/orders", { flow: "returning", requestId: crypto.randomUUID(), vaultRevision: buyer.revision }],
    ["/api/direct-charge", { requestId: crypto.randomUUID(), vaultRevision: buyer.revision }],
    [`/api/orders/${pending.body.order.id}/capture`, {}],
  ];
  const callCount = h.calls.length;
  for (const [path, body] of requests) assert.equal((await h.call(path, body)).body.error, "BUYER_CHANGED");
  assert.equal(h.calls.length, callCount);
});

test("a failed capture preserves the existing buyer and returns a useful debug ID", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const id = await h.newCheckout(false);
  h.mock.failCapture = true;
  const failed = await h.call(`/api/orders/${id}/capture`, {});
  assert.equal(failed.status, 502);
  assert.equal(failed.body.details.debugId, "safe-debug-id");
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
});

test("APPROVED vaulting removes the old active buyer and refuses charges until a token is ready", async () => {
  const h = harness();
  await h.newCheckout();
  h.mock.vaultStatus = "APPROVED";
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  assert.equal(buyer.state, "PENDING");
  assert.equal(buyer.vaultId, null);
  assert.equal((await h.call("/api/client-token", { vaultRevision: buyer.revision })).body.error, "NO_VAULTED_BUYER");
  assert.equal((await h.call("/api/direct-charge", { requestId: crypto.randomUUID(), vaultRevision: buyer.revision })).body.error, "NO_VAULTED_BUYER");
});

test("a pending payment capture is not represented as a completed purchase", async () => {
  const h = harness();
  h.mock.captureStatus = "PENDING";
  const id = await h.newCheckout(false);
  const capture = await h.call(`/api/orders/${id}/capture`, {});
  assert.equal(capture.body.order.completed, false);
  assert.equal((await h.call("/api/state")).body.buyer, null);
  h.mock.captureStatus = "COMPLETED";
  h.orders.get(id).result.purchase_units[0].payments.captures[0].status = "COMPLETED";
  assert.equal((await h.call(`/api/orders/${id}`)).body.order.completed, true);
  assert.equal((await h.call("/api/state")).body.buyer.state, "VAULTED");
});

test("a direct order requiring payer action is never blindly captured or reported paid", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  h.mock.directStatus = "PAYER_ACTION_REQUIRED";
  const result = await h.call("/api/direct-charge", { requestId: crypto.randomUUID(), vaultRevision: buyer.revision });
  assert.equal(result.body.order.completed, false);
  assert.equal((await h.call(`/api/orders/${result.body.order.id}/capture`, {})).body.error, "DIRECT_ORDER");
});

test("unknown orders and reused keys with a different meaning are rejected", async () => {
  const h = harness();
  assert.equal((await h.call("/api/orders/UNKNOWN123/capture", {})).status, 404);
  assert.equal(h.calls.length, 0);
  const key = crypto.randomUUID();
  await h.newCheckout(true, key);
  const buyer = (await h.call("/api/state")).body.buyer;
  assert.equal((await h.call("/api/direct-charge", { requestId: key, vaultRevision: buyer.revision })).body.error, "IDEMPOTENCY_CONFLICT");
});

test("webhook is disabled by default and only verified, matching events can resolve pending vaulting", async () => {
  const h = harness();
  assert.equal((await h.call("/api/paypal/webhook", {})).status, 404);
  h.env.PAYPAL_WEBHOOK_ID = "configured-webhook-id";
  h.mock.vaultStatus = "APPROVED";
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const event = { create_time: new Date().toISOString(), event_type: "VAULT.PAYMENT-TOKEN.CREATED", resource: { id: "late-vault", customer: { id: buyer.customerId } } };
  assert.equal((await h.call("/api/paypal/webhook", event)).body.error, "MISSING_SIGNATURE");
  const headers = { Authorization: "", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "event1", "paypal-transmission-sig": "signature", "paypal-transmission-time": new Date().toISOString() };
  h.mock.verification = "FAILURE";
  assert.equal((await h.call("/api/paypal/webhook", event, { headers })).status, 403);
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, null);
  h.mock.verification = "SUCCESS";
  const unrelated = { ...event, resource: { id: "wrong-vault", customer: { id: "different-customer" } } };
  await h.call("/api/paypal/webhook", unrelated, { headers });
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, null);
  assert.equal((await h.call("/api/paypal/webhook", event, { headers })).status, 200);
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, "late-vault");
});

test("a verified vault event delivered before capture is correlated with that checkout", async () => {
  const h = harness();
  h.env.PAYPAL_WEBHOOK_ID = "configured-webhook-id";
  h.mock.vaultStatus = "APPROVED";
  const id = await h.newCheckout(false);
  const orderKey = await h.storage.get(`order:${id}`);
  const operation = await h.storage.get(orderKey);
  const event = {
    create_time: new Date().toISOString(), event_type: "VAULT.PAYMENT-TOKEN.CREATED",
    resource: { id: "early-vault", customer: { id: `customer-${id}`, merchant_customer_id: operation.merchantCustomerId } },
  };
  const headers = { Authorization: "", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "event2", "paypal-transmission-sig": "signature", "paypal-transmission-time": new Date().toISOString() };
  assert.equal((await h.call("/api/paypal/webhook", event, { headers })).status, 200);
  assert.equal((await h.call("/api/state")).body.buyer, null);
  await h.call(`/api/orders/${id}/capture`, {});
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, "early-vault");
});

test("stale events or a mismatched merchant identity cannot populate a pending buyer", async () => {
  const h = harness();
  h.env.PAYPAL_WEBHOOK_ID = "configured-webhook-id";
  h.mock.vaultStatus = "APPROVED";
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const headers = { Authorization: "", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "event3", "paypal-transmission-sig": "signature", "paypal-transmission-time": new Date().toISOString() };
  for (const event of [
    { create_time: new Date(Date.now() - 3600000).toISOString(), event_type: "VAULT.PAYMENT-TOKEN.CREATED", resource: { id: "old-vault", customer: { id: buyer.customerId } } },
    { create_time: new Date().toISOString(), event_type: "VAULT.PAYMENT-TOKEN.CREATED", resource: { id: "other-vault", customer: { id: buyer.customerId, merchant_customer_id: "another-checkout" } } },
  ]) await h.call("/api/paypal/webhook", event, { headers });
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, null);
});
