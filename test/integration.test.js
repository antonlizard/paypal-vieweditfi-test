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
  const mock = { vaultStatus: "VAULTED", captureStatus: "COMPLETED", directStatus: "COMPLETED", failCapture: false, loseCreateResponse: false, verification: "SUCCESS", charges: 0,
    cardAuthenticationStatus: "Y", savedCardApproved: false, loseConfirmResponse: false };
  const env = {
    PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "sandbox-client-id", PAYPAL_CLIENT_SECRET: "server-only-secret",
    BASIC_AUTH_USERNAME: "editfi", BASIC_AUTH_PASSWORD: "test-only-password", PAYPAL_CURRENCY: "USD", PAYPAL_AMOUNT: "10.00",
    ASSETS: { fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`) },
  };
  let store;
  function completed(order, id, vaultStatus = mock.vaultStatus) {
    const paymentSource = order.confirmedSource || order.body.payment_source;
    const isCard = Boolean(paymentSource?.card);
    const newBuyer = paymentSource?.[isCard ? "card" : "paypal"]?.attributes?.vault;
    const vault = newBuyer ? {
      status: vaultStatus,
      ...(vaultStatus === "VAULTED" ? { id: `vault-${id}` } : {}),
      customer: { id: `customer-${id}` },
    } : undefined;
    return {
      id, status: "COMPLETED",
      payment_source: isCard ? { card: { brand: "VISA", last_digits: "1111", expiry: "2030-12", attributes: { vault },
        authentication_result: { liability_shift: "POSSIBLE", three_d_secure: { enrollment_status: "Y", authentication_status: mock.cardAuthenticationStatus } },
      } } : { paypal: {
        email_address: `buyer-${id}@example.test`,
        attributes: { vault },
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
        const direct = Boolean(body.payment_source?.paypal?.vault_id);
        order = { id, body, result: { id, status: "PAYER_ACTION_REQUIRED" } };
        if (direct) {
          mock.charges++;
          order.result = mock.directStatus === "COMPLETED" ? completed(order, id) : { id, status: mock.directStatus };
        }
        orders.set(id, order);
        requestIds.set(requestId, order);
      } else assert.deepEqual(body, order.body, "Idempotent retries must use identical payloads");
      if (mock.loseCreateResponse) { mock.loseCreateResponse = false; throw new Error("response lost after processing"); }
      return Response.json(order.result, { status: 201, headers: { "paypal-debug-id": "create-debug-id" } });
    }
    const match = path.match(/^\/v2\/checkout\/orders\/(ORDER\d+)(\/(?:capture|confirm-payment-source))?$/);
    assert.ok(match, `Unexpected PayPal request ${path}`);
    const order = orders.get(match[1]);
    assert.ok(order);
    if (match[2] === "/confirm-payment-source") {
      order.confirmedSource = body.payment_source;
      order.result = { id: order.id, status: "PAYER_ACTION_REQUIRED", links: [{
        rel: "payer-action", method: "GET", href: mock.payerActionUrl || `https://www.sandbox.paypal.com/webapps/helios?flow=3ds&cart_id=${order.id}`,
      }] };
      if (mock.loseConfirmResponse) { mock.loseConfirmResponse = false; throw new Error("confirmation response lost"); }
      return Response.json(order.result, { status: 200 });
    }
    if (match[2] === "/capture") {
      if (mock.failCapture) return Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Payment declined", debug_id: "safe-debug-id" }, { status: 422 });
      order.result = completed(order, order.id);
    }
    const cardSource = order.confirmedSource?.card || order.body.payment_source?.card;
    if (!match[2] && cardSource && !order.result.purchase_units && (!cardSource.vault_id || mock.savedCardApproved)) {
      return Response.json({ id: order.id, status: "APPROVED", payment_source: { card: {
        brand: "VISA", last_digits: "1111", authentication_result: {
          liability_shift: "POSSIBLE", three_d_secure: { enrollment_status: "Y", authentication_status: mock.cardAuthenticationStatus },
        },
      } } });
    }
    return Response.json(order.result, { status: match[2] ? 201 : 200, headers: { "paypal-debug-id": "capture-debug-id" } });
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
    const created = await call("/api/orders", { flow: "new", savePaymentMethod: true, requestId: key });
    assert.equal(created.status, 200);
    const id = created.body.order.id;
    if (capture) assert.equal((await call(`/api/orders/${id}/capture`, {})).status, 200);
    return id;
  }
  return { call, newCheckout, calls, storage, orders, env, mock, restart };
}

for (const page of ["new", "returning"]) {
  test(`Card Fields on the ${page} page use Orders v2 create and capture without a saved buyer`, async () => {
    const h = harness();
    const requestId = crypto.randomUUID();
    const created = await h.call("/api/orders", {
      flow: "card", page, requestId,
      // The server must ignore browser-supplied amounts and payment details.
      purchase_units: [{ amount: { currency_code: "EUR", value: "0.01" } }],
      payment_source: { card: { number: "4111111111111111", security_code: "123" } },
    });
    assert.equal(created.status, 200);
    const request = h.calls.find((call) => call.path === "/v2/checkout/orders");
    assert.deepEqual(request.body.purchase_units, [{ amount: { currency_code: "USD", value: "10.00" } }]);
    assert.equal(request.body.payment_source.paypal, undefined);
    assert.deepEqual(request.body.payment_source.card.attributes, { verification: { method: "SCA_ALWAYS" } });
    assert.equal(request.body.payment_source.card.number, undefined);
    assert.equal(request.body.payment_source.card.security_code, undefined);
    assert.equal(request.body.payment_source.card.attributes.vault, undefined);
    assert.equal(request.body.payment_source.card.experience_context.return_url, `https://test.example/${page === "new" ? "new" : "returning"}-customer?card=return`);
    h.restart();
    const captured = await h.call(`/api/orders/${created.body.order.id}/capture`, {});
    assert.equal(captured.status, 200);
    assert.equal(captured.body.order.completed, true);
    assert.equal(captured.body.flow, "card");
    assert.ok(captured.body.order.purchase_units[0].payments.captures[0].id);
    assert.equal((await h.call("/api/state")).body.buyer, null);
    assert.equal(h.storage.map.has("sequence"), false);
    assert.equal(JSON.stringify([...h.storage.map]).includes("4111111111111111"), false);
  });
}

test("card payments preserve the saved buyer even when another PayPal checkout replaces it before capture", async () => {
  const h = harness();
  await h.newCheckout();
  const created = await h.call("/api/orders", { flow: "card", page: "returning", requestId: crypto.randomUUID() });
  await h.newCheckout();
  const latest = (await h.call("/api/state")).body.buyer;
  const captured = await h.call(`/api/orders/${created.body.order.id}/capture`, {});
  assert.equal(captured.status, 200);
  assert.equal(captured.body.order.completed, true);
  assert.deepEqual((await h.call("/api/state")).body.buyer, latest);
  assert.equal(h.storage.map.get(`operation:${h.calls.find((call) => call.body?.payment_source?.card).headers["PayPal-Request-Id"].slice(7)}`).flow, "card");
});

test("card create retries and duplicate captures preserve their payment idempotency keys", async () => {
  const h = harness();
  const input = { flow: "card", page: "new", requestId: crypto.randomUUID() };
  h.mock.loseCreateResponse = true;
  assert.equal((await h.call("/api/orders", input)).status, 502);
  h.restart();
  const created = await h.call("/api/orders", input);
  assert.equal(created.status, 200);
  const orderId = created.body.order.id;
  const creates = h.calls.filter((call) => call.path === "/v2/checkout/orders");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(creates[0].headers["PayPal-Request-Id"], creates[1].headers["PayPal-Request-Id"]);
  const results = await Promise.all([h.call(`/api/orders/${orderId}/capture`, {}), h.call(`/api/orders/${orderId}/capture`, {})]);
  assert.ok(results.every((result) => result.body.order.completed));
  assert.equal(h.calls.filter((call) => call.path.endsWith("/capture")).length, 1);
  assert.equal((await h.call("/api/orders", { ...input, flow: "new" })).body.error, "IDEMPOTENCY_CONFLICT");
  assert.equal((await h.call("/api/orders", { ...input, page: "returning" })).body.error, "IDEMPOTENCY_CONFLICT");
});

test("a declined card capture returns diagnostics and preserves the cached PayPal buyer", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const created = await h.call("/api/orders", { flow: "card", requestId: crypto.randomUUID() });
  h.mock.failCapture = true;
  const captured = await h.call(`/api/orders/${created.body.order.id}/capture`, {});
  assert.equal(captured.status, 502);
  assert.equal(captured.body.details.traces.capture.response.status, 422);
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
});

async function saveCard(h) {
  const created = await h.call("/api/orders", { flow: "card", page: "new", savePaymentMethod: true, requestId: crypto.randomUUID() });
  assert.equal(created.status, 200);
  const captured = await h.call(`/api/orders/${created.body.order.id}/capture`, {});
  assert.equal(captured.status, 200);
  return (await h.call("/api/state")).body.buyer;
}

for (const flow of ["new", "card"]) {
  test(`${flow} purchases vault only with explicit consent and unsaved purchases keep the previous method`, async () => {
    const h = harness();
    await h.newCheckout();
    const previous = (await h.call("/api/state")).body.buyer;
    const input = { flow, page: "new", savePaymentMethod: false, requestId: crypto.randomUUID() };
    const created = await h.call("/api/orders", input);
    const payload = h.calls.filter((call) => call.path === "/v2/checkout/orders").at(-1).body;
    const source = payload.payment_source[flow === "card" ? "card" : "paypal"];
    assert.equal(source.attributes?.vault, undefined);
    assert.equal((await h.call(`/api/orders/${created.body.order.id}/capture`, {})).status, 200);
    assert.deepEqual((await h.call("/api/state")).body.buyer, previous);
    const saving = await h.call("/api/orders", { ...input, savePaymentMethod: true, requestId: crypto.randomUUID() });
    const savingPayload = h.calls.filter((call) => call.path === "/v2/checkout/orders").at(-1).body;
    assert.equal(savingPayload.payment_source[flow === "card" ? "card" : "paypal"].attributes.vault.store_in_vault, "ON_SUCCESS");
    await h.call(`/api/orders/${saving.body.order.id}/capture`, {});
    const latest = (await h.call("/api/state")).body.buyer;
    assert.equal(latest.methodType, flow === "card" ? "card" : "paypal");
    assert.notEqual(latest.vaultId, previous.vaultId);
    if (flow === "card") assert.deepEqual(latest.card, { brand: "VISA", lastDigits: "1111", expiry: "2030-12" });
  });
}

test("save consent is frozen for retries and non-boolean consent is rejected", async () => {
  const h = harness();
  const input = { flow: "card", page: "new", savePaymentMethod: true, requestId: crypto.randomUUID() };
  assert.equal((await h.call("/api/orders", input)).status, 200);
  assert.equal((await h.call("/api/orders", { ...input, savePaymentMethod: false })).body.error, "IDEMPOTENCY_CONFLICT");
  for (const choice of ["true", "false", 1, null]) {
    assert.equal((await h.call("/api/orders", { ...input, requestId: crypto.randomUUID(), savePaymentMethod: choice })).body.error, "INVALID_SAVE_CHOICE");
  }
});

test("saved cards use separate create/confirm calls with SCA_ALWAYS and capture only after successful authentication", async () => {
  const h = harness();
  const saved = await saveCard(h);
  const input = { flow: "saved-card", requestId: crypto.randomUUID(), vaultRevision: saved.revision, vault_id: "untrusted-browser-token" };
  const created = await h.call("/api/orders", input);
  assert.equal(created.status, 200);
  assert.equal(created.body.order.status, "PAYER_ACTION_REQUIRED");
  assert.match(created.body.order.payerActionUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  assert.equal(new URL(created.body.order.payerActionUrl).searchParams.get("redirect_uri"), "https://test.example/returning-customer?saved-card=return");
  assert.equal(created.body.traces.create.request.body.payment_source, undefined);
  const source = created.body.traces.confirm.request.body.payment_source.card;
  assert.equal(source.vault_id, saved.vaultId);
  assert.equal(source.attributes.verification.method, "SCA_ALWAYS");
  assert.deepEqual(source.stored_credential, { payment_initiator: "CUSTOMER", payment_type: "ONE_TIME", usage: "SUBSEQUENT" });
  const before = h.calls.filter((call) => call.path.endsWith("/capture")).length;
  assert.equal((await h.call(`/api/orders/${created.body.order.id}/capture`, { cardAuthenticated: true })).body.error, "CARD_AUTHENTICATION_REQUIRED");
  assert.equal(h.calls.filter((call) => call.path.endsWith("/capture")).length, before);
  h.mock.savedCardApproved = true;
  const status = await h.call(`/api/orders/${created.body.order.id}`);
  assert.equal(status.body.order.cardAuthenticated, true);
  const captured = await h.call(`/api/orders/${created.body.order.id}/capture`, {});
  assert.equal(captured.body.order.completed, true);
  assert.deepEqual((await h.call("/api/state")).body.buyer, saved);
});

test("card captures reject failed, incomplete, attempted-only, or absent 3DS results", async () => {
  const h = harness();
  const created = await h.call("/api/orders", { flow: "card", page: "new", requestId: crypto.randomUUID() });
  for (const status of ["N", "R", "U", "C", "A", undefined]) {
    h.mock.cardAuthenticationStatus = status;
    const result = await h.call(`/api/orders/${created.body.order.id}/capture`, { authentication_status: "Y" });
    assert.equal(result.body.error, "CARD_AUTHENTICATION_REQUIRED");
  }
  assert.equal(h.calls.some((call) => call.path.endsWith("/capture")), false);
  h.mock.cardAuthenticationStatus = "Y";
  assert.equal((await h.call(`/api/orders/${created.body.order.id}/capture`, {})).body.order.completed, true);
});

test("saved-card confirmation retries reuse the same order and idempotency key after a lost response", async () => {
  const h = harness();
  const saved = await saveCard(h);
  const input = { flow: "saved-card", requestId: crypto.randomUUID(), vaultRevision: saved.revision };
  h.mock.loseConfirmResponse = true;
  assert.equal((await h.call("/api/orders", input)).status, 502);
  h.restart();
  const restored = await h.call("/api/orders", input);
  assert.equal(restored.status, 200);
  const confirms = h.calls.filter((call) => call.path.endsWith("/confirm-payment-source"));
  assert.equal(confirms.length, 2);
  assert.equal(confirms[0].path, confirms[1].path);
  assert.equal(confirms[0].headers["PayPal-Request-Id"], confirms[1].headers["PayPal-Request-Id"]);
  assert.deepEqual(confirms[0].body, confirms[1].body);
});

test("saved method types cannot be interchanged and stale saved-card captures are rejected", async () => {
  const h = harness();
  const card = await saveCard(h);
  for (const path of ["/api/client-token", "/api/direct-charge"]) {
    const result = await h.call(path, { requestId: crypto.randomUUID(), vaultRevision: card.revision });
    assert.equal(result.status, 409);
  }
  const created = await h.call("/api/orders", { flow: "saved-card", requestId: crypto.randomUUID(), vaultRevision: card.revision });
  await h.newCheckout();
  h.mock.savedCardApproved = true;
  const original = h.calls.find((call) => call.path.endsWith("/confirm-payment-source"));
  assert.equal((await h.call("/api/orders", { flow: "saved-card", requestId: original.headers["PayPal-Request-Id"].slice(8), vaultRevision: card.revision })).body.error, "BUYER_CHANGED");
  assert.equal((await h.call(`/api/orders/${created.body.order.id}/capture`, {})).body.error, "BUYER_CHANGED");
  const paypal = (await h.call("/api/state")).body.buyer;
  assert.equal((await h.call("/api/orders", { flow: "saved-card", requestId: crypto.randomUUID(), vaultRevision: paypal.revision })).body.error, "PAYMENT_METHOD_CHANGED");
});

test("unsafe payer-action links are excluded from the saved-card redirect response", async () => {
  const h = harness();
  const saved = await saveCard(h);
  for (const url of ["javascript:alert(1)", "https://www.sandbox.paypal.com.evil.example/", "http://www.sandbox.paypal.com/"]) {
    h.mock.payerActionUrl = url;
    const result = await h.call("/api/orders", { flow: "saved-card", requestId: crypto.randomUUID(), vaultRevision: saved.revision });
    assert.equal(result.body.order.payerActionUrl, undefined);
  }
});

test("a PayPal purchase offered beside a saved card does not replace the saved card", async () => {
  const h = harness();
  const saved = await saveCard(h);
  const created = await h.call("/api/orders", { flow: "paypal", page: "returning", requestId: crypto.randomUUID() });
  assert.equal(created.status, 200);
  assert.equal((await h.call(`/api/orders/${created.body.order.id}/capture`, {})).body.order.completed, true);
  assert.deepEqual((await h.call("/api/state")).body.buyer, saved);
});

test("pending card vaulting resolves only from a verified matching card token event", async () => {
  const h = harness();
  await h.newCheckout();
  h.env.PAYPAL_WEBHOOK_ID = "configured-webhook-id";
  h.mock.vaultStatus = "APPROVED";
  const pending = await saveCard(h);
  assert.equal(pending.state, "PENDING");
  assert.equal(pending.methodType, "card");
  assert.equal(pending.vaultId, null);
  const headers = { Authorization: "", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "card-vault-event", "paypal-transmission-sig": "signature", "paypal-transmission-time": new Date().toISOString() };
  const event = { create_time: new Date().toISOString(), event_type: "VAULT.PAYMENT-TOKEN.CREATED", resource: { id: "late-card-vault", customer: { id: pending.customerId } } };
  await h.call("/api/paypal/webhook", event, { headers });
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, null);
  await h.call("/api/paypal/webhook", { ...event, resource: { ...event.resource, payment_source: { paypal: {} } } }, { headers });
  assert.equal((await h.call("/api/state")).body.buyer.vaultId, null);
  await h.call("/api/paypal/webhook", { ...event, resource: { ...event.resource, payment_source: { card: { brand: "VISA", last_digits: "1111" } } } }, { headers });
  const saved = (await h.call("/api/state")).body.buyer;
  assert.equal(saved.state, "VAULTED");
  assert.equal(saved.methodType, "card");
  assert.equal(saved.vaultId, "late-card-vault");
});

test("late PayPal captures cannot replace a more recent opted-in card purchase", async () => {
  const h = harness();
  const earlyPayPal = await h.newCheckout(false);
  const saved = await saveCard(h);
  await h.call(`/api/orders/${earlyPayPal}/capture`, {});
  assert.deepEqual((await h.call("/api/state")).body.buyer, saved);
});

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
  assert.equal(source.experience_context.user_action, "PAY_NOW");
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
  assert.equal(source.experience_context.user_action, "CONTINUE");
  assert.equal(source.vault_id, undefined);
  assert.equal(source.attributes, undefined);
  await h.call(`/api/orders/${created.body.order.id}/capture`, {});
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
});

test("Orders traces preserve the actual REST requests and full responses across replay and reload", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const body = { flow: "returning", requestId: crypto.randomUUID(), vaultRevision: buyer.revision };
  const created = await h.call("/api/orders", body);
  const id = created.body.order.id;
  const actual = h.calls.filter((call) => call.path === "/v2/checkout/orders").at(-1);
  const create = created.body.traces.create;
  assert.equal(create.request.method, "POST");
  assert.equal(create.request.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders");
  assert.deepEqual(create.request.body, actual.body);
  assert.equal(create.request.headers["PayPal-Request-Id"], actual.headers["PayPal-Request-Id"]);
  assert.equal(create.request.headers.Authorization, "Bearer server-access-token");
  assert.deepEqual(create.request.authentication, { method: "Bearer", token: "server-access-token" });
  assert.equal(create.response.status, 201);
  assert.equal(create.response.headers["paypal-debug-id"], "create-debug-id");
  assert.deepEqual(create.response.body, h.orders.get(id).result);
  assert.equal(created.body.traces.capture, undefined);
  const captured = await h.call(`/api/orders/${id}/capture`, {});
  const capture = captured.body.traces.capture;
  assert.equal(capture.request.url, `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}/capture`);
  assert.equal(capture.request.headers["PayPal-Request-Id"], `capture-${id}`);
  assert.deepEqual(capture.request.body, {});
  assert.equal(capture.response.status, 201);
  assert.deepEqual(capture.response.body, JSON.parse(JSON.stringify(h.orders.get(id).result)));
  assert.equal(captured.body.traces.create.request.authentication.method, "Bearer");
  assert.equal(captured.body.traces.create.request.authentication.token, "[REDACTED]");
  assert.equal(capture.request.authentication.token, "server-access-token");
  assert.deepEqual(captured.body.traces.create.response, create.response);
  h.restart();
  const recovered = await h.call(`/api/operations/${body.requestId}`);
  assert.equal(recovered.body.traces.capture.request.authentication.token, "[REDACTED]");
  assert.equal(recovered.body.traces.capture.request.headers.Authorization, "[REDACTED]");
  assert.deepEqual(recovered.body.traces.capture.response, capture.response);
  await h.call(`/api/orders/${id}`);
  const before = h.calls.length;
  const replay = await h.call(`/api/orders/${id}/capture`, {});
  assert.equal(h.calls.length, before);
  assert.deepEqual(replay.body.traces, recovered.body.traces);
  const serialized = JSON.stringify(captured.body.traces);
  for (const secret of [h.env.PAYPAL_CLIENT_SECRET, h.env.BASIC_AUTH_PASSWORD]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("server-access-token"), true);
  assert.equal(JSON.stringify([...h.storage.map]).includes("server-access-token"), false);
  const token = await h.call("/api/client-token", { vaultRevision: buyer.revision });
  assert.equal(token.body.traces, undefined);
});

test("failed captures return and retain their HTTP trace without changing payment state", async () => {
  const h = harness();
  await h.newCheckout();
  const buyer = (await h.call("/api/state")).body.buyer;
  const key = crypto.randomUUID();
  const created = await h.call("/api/orders", { flow: "returning", requestId: key, vaultRevision: buyer.revision });
  const id = created.body.order.id;
  h.mock.failCapture = true;
  const failed = await h.call(`/api/orders/${id}/capture`, {});
  assert.equal(failed.status, 502);
  const traces = failed.body.details.traces;
  assert.equal(traces.capture.attempted, true);
  assert.equal(traces.capture.response.status, 422);
  assert.equal(traces.capture.response.body.name, "UNPROCESSABLE_ENTITY");
  assert.deepEqual(traces.create.response, created.body.traces.create.response);
  assert.equal(traces.capture.request.authentication.token, "server-access-token");
  const saved = (await h.call(`/api/operations/${key}`)).body.traces;
  assert.equal(saved.capture.request.authentication.token, "[REDACTED]");
  assert.deepEqual(saved.capture.response, traces.capture.response);
  assert.equal(JSON.stringify([...h.storage.map]).includes("server-access-token"), false);
  assert.deepEqual((await h.call("/api/state")).body.buyer, buyer);
  h.mock.failCapture = false;
  const retried = await h.call(`/api/orders/${id}/capture`, {});
  assert.equal(retried.body.traces.capture.response.status, 201);
  assert.equal(retried.body.traces.capture.error, undefined);
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
  assert.equal(first.body.traces.create.response.status, 201);
  assert.equal(first.body.traces.create.request.body.payment_source.paypal.vault_id, buyer.vaultId);
  assert.equal(first.body.traces.capture, undefined);
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
