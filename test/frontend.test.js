import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const savedBuyer = { revision: "revision-1", vaultId: "server-vault-1", state: "VAULTED", savedAt: new Date().toISOString() };
const complete = { id: "ORDER00001", status: "COMPLETED", completed: true, purchase_units: [{ payments: { captures: [{ id: "CAPTURE00001", status: "COMPLETED" }] } }] };

// This exercises browser event logic and SDK configuration with a fake DOM and
// PayPal SDK. It is a contract test, not visual/browser or real-PayPal testing.
function browser(flow, backend = () => undefined, initialBuyer = savedBuyer, hasComponent = true, options = {}) {
  const elements = new Map(), scripts = [], renders = [], requests = [], storage = new Map(options.storage);
  let callbacks;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: "", className: "", events: {},
      addEventListener(event, handler) { this.events[event] = handler; },
      querySelector(selector) { return element(`${id}:${selector}`); },
      setAttribute(name, value) { this[name] = value; },
    });
    return elements.get(id);
  }
  const paypal = {
    FUNDING: { PAYPAL: "paypal" },
    Buttons(options) { callbacks = options; return { async render(selector) { renders.push(selector); } }; },
    ...(hasComponent ? { SavedPaymentMethods(options) { callbacks = options; return { async render(selector) { renders.push(selector); } }; } } : {}),
  };
  const context = vm.createContext({
    document: {
      body: { dataset: { flow } }, getElementById: element,
      querySelectorAll: () => [element("amount-1"), element("amount-2")],
      createElement: () => element(`script-${scripts.length}`),
      head: { appendChild(script) { scripts.push(script); queueMicrotask(() => script.onload()); } },
    },
    window: { paypal },
    location: { search: options.search || "", pathname: `/${flow === "new" ? "new" : "returning"}-customer`, reload() {} },
    history: { replaceState() {} },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    crypto, URLSearchParams, Intl, Date,
    fetch: async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, init });
      const custom = await backend(path, body);
      if (custom !== undefined) return Response.json(custom);
      if (path === "/api/config") return Response.json({ clientId: "public-client-id", sdkBase: "https://www.sandbox.paypal.com", environment: "sandbox", currency: "USD", amount: "10.00" });
      if (path === "/api/state") return Response.json({ buyer: initialBuyer });
      if (path === "/api/client-token") return Response.json({ clientToken: "scoped-test-token", expiresIn: 32400 });
      if (path === "/api/orders") return Response.json({ order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } });
      if (path.endsWith("/capture") || path === "/api/direct-charge") return Response.json({ order: complete });
      throw new Error(`Unexpected API call: ${path}`);
    },
  });
  vm.runInContext(source, context);
  async function ready() {
    for (let count = 0; count < 100; count++) {
      if (renders.length || element("status").className.includes("error") || element("status").textContent.startsWith("Create a saved")) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("Frontend did not finish initialization");
  }
  return { ready, element, scripts, renders, requests, storage, get callbacks() { return callbacks; } };
}

test("new page loads SDK v5 with vaulting and only renders PayPal Buttons", async () => {
  const page = browser("new");
  await page.ready();
  const sdk = new URL(page.scripts[0].src);
  assert.equal(sdk.pathname, "/sdk/js");
  assert.equal(sdk.searchParams.get("components"), "buttons");
  assert.equal(sdk.searchParams.get("vault"), "true");
  assert.equal(sdk.searchParams.get("commit"), "true");
  assert.deepEqual(page.renders, ["#paypal-button-container"]);
  assert.equal(page.requests.some((request) => request.path === "/api/client-token"), false);
  await page.callbacks.createOrder();
  await page.callbacks.onApprove({ orderID: complete.id });
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  assert.match(page.element("status").textContent, /Payment completed/);
});

test("returning page scopes SDK through its data attribute and all four required components", async () => {
  const page = browser("returning");
  await page.ready();
  const script = page.scripts[0];
  const sdk = new URL(script.src);
  assert.equal(sdk.searchParams.get("components"), "buttons,funding-eligibility,messages,saved-payment-methods");
  assert.equal(script["data-sdk-client-token"], "scoped-test-token");
  assert.equal(sdk.searchParams.has("client-token"), false);
  assert.equal(sdk.searchParams.has("vault-id"), false);
  assert.equal(sdk.searchParams.get("commit"), "false");
  assert.equal(page.callbacks.vaultId, undefined);
  assert.deepEqual(page.renders, ["#saved-payment-methods-container"]);
  assert.equal(page.element("place-order").disabled, false);
  assert.equal(page.element("activity").textContent.includes("scoped-test-token"), false);
  assert.ok(!JSON.stringify([...page.storage]).includes(savedBuyer.vaultId));
});

test("returning approval waits for Place order, which captures the approved order once", async () => {
  const page = browser("returning");
  await page.ready();
  assert.equal(await page.callbacks.createOrder(), complete.id);
  assert.equal(page.element("payment-details").hidden, false);
  assert.equal(page.element("payment-order-id").textContent, complete.id);
  assert.equal(page.element("payment-capture-details").hidden, true);
  assert.equal(page.element("place-order").disabled, true);
  await page.callbacks.onApprove({ orderID: complete.id });
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 0);
  assert.equal(page.requests.filter((request) => request.path === "/api/direct-charge").length, 0);
  assert.equal(page.element("payment-capture-details").hidden, true);
  assert.equal(page.element("place-order").disabled, false);
  assert.match(page.element("status").textContent, /Click "Place order with saved method"/);
  await Promise.all([page.element("place-order").events.click(), page.element("place-order").events.click()]);
  assert.match(page.element("status").textContent, /Payment completed/);
  assert.equal(page.element("payment-capture-details").hidden, false);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
  assert.equal(page.element("payment-details").hidden, false);
  await page.element("place-order").events.click();
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  assert.equal(page.requests.filter((request) => request.path === "/api/direct-charge").length, 0);
});

test("a lost direct-charge response blocks editing and recovers using the original request ID", async () => {
  let attempts = 0;
  const page = browser("returning", (path) => {
    if (path === "/api/direct-charge") {
      if (++attempts === 1) throw new Error("connection lost");
      return { order: complete };
    }
  });
  await page.ready();
  await page.element("place-order").events.click();
  assert.equal(page.element("place-order").disabled, true);
  assert.equal(page.element("check-status").hidden, false);
  await assert.rejects(page.callbacks.createOrder(), /already submitted/);
  await page.element("check-status").events.click();
  const calls = page.requests.filter((request) => request.path === "/api/direct-charge");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.requestId, calls[1].body.requestId);
  assert.match(page.element("status").textContent, /Payment completed/);
  assert.equal(page.element("payment-order-id").textContent, complete.id);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("a pending capture shows its order ID and reveals the transaction ID only after completion", async () => {
  const page = browser("returning", (path) => {
    if (path.endsWith("/capture")) return { order: {
      id: complete.id, status: "COMPLETED", completed: false,
      purchase_units: [{ payments: { captures: [{ id: "PENDING00001", status: "PENDING" }] } }],
    } };
    if (path === `/api/orders/${complete.id}`) return { order: complete };
  });
  await page.ready();
  await page.callbacks.createOrder();
  await page.callbacks.onApprove({ orderID: complete.id });
  await page.element("place-order").events.click();
  assert.equal(page.element("payment-order-id").textContent, complete.id);
  assert.equal(page.element("payment-capture-details").hidden, true);
  assert.equal(page.element("payment-capture-id").textContent, "—");
  await page.element("check-status").events.click();
  assert.equal(page.element("payment-capture-details").hidden, false);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("Place order without editing makes only a direct saved-method payment", async () => {
  const page = browser("returning");
  await page.ready();
  await page.element("place-order").events.click();
  assert.equal(page.requests.filter((request) => request.path === "/api/orders").length, 0);
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 0);
  assert.equal(page.requests.filter((request) => request.path === "/api/direct-charge").length, 1);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("a further edit creates a fresh order and Place order captures only the latest approval", async () => {
  const secondId = "ORDER00002";
  let orders = 0;
  const page = browser("returning", (path) => {
    if (path === "/api/orders") return { order: { id: ++orders === 1 ? complete.id : secondId, status: "PAYER_ACTION_REQUIRED" } };
    if (path === `/api/orders/${secondId}/capture`) return { order: { ...complete, id: secondId } };
  });
  await page.ready();
  await page.callbacks.createOrder();
  await page.callbacks.onApprove({ orderID: complete.id });
  assert.equal(await page.callbacks.createOrder(), secondId);
  assert.equal(page.element("place-order").disabled, true);
  await page.callbacks.onApprove({ orderID: secondId });
  const created = page.requests.filter((request) => request.path === "/api/orders");
  assert.notEqual(created[0].body.requestId, created[1].body.requestId);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  await page.element("place-order").events.click();
  const captured = page.requests.filter((request) => request.path.endsWith("/capture"));
  assert.deepEqual(captured.map((request) => request.path), [`/api/orders/${secondId}/capture`]);
  assert.equal(page.requests.some((request) => request.path === "/api/direct-charge"), false);
});

test("cancelling an unapproved edit leaves Place order using the saved method", async () => {
  const page = browser("returning");
  await page.ready();
  await page.callbacks.createOrder();
  page.callbacks.onCancel();
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  await page.element("place-order").events.click();
  assert.equal(page.requests.filter((request) => request.path === "/api/direct-charge").length, 1);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
});

test("reload restores an approved order without charging until Place order", async () => {
  const first = browser("returning");
  await first.ready();
  await first.callbacks.createOrder();
  await first.callbacks.onApprove({ orderID: complete.id });
  const restored = browser("returning", (path) => {
    if (path.startsWith("/api/operations/")) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED" } };
  }, savedBuyer, true, { storage: first.storage });
  await restored.ready();
  assert.equal(restored.element("payment-order-id").textContent, complete.id);
  assert.equal(restored.element("place-order").disabled, false);
  assert.equal(restored.requests.some((request) => request.path.endsWith("/capture") || request.path === "/api/direct-charge"), false);
  await restored.element("place-order").events.click();
  assert.equal(restored.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  assert.equal(restored.requests.some((request) => request.path === "/api/direct-charge"), false);
});

test("returning redirect approval waits for Place order on the merchant page", async () => {
  const page = browser("returning", (path) => {
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED" } };
  }, savedBuyer, true, { search: `?paypal=return&token=${complete.id}` });
  await page.ready();
  assert.equal(page.element("payment-order-id").textContent, complete.id);
  assert.equal(page.element("place-order").disabled, false);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture") || request.path === "/api/direct-charge"), false);
  await page.element("place-order").events.click();
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

for (const settled of [false, true]) {
  test(`lost capture response recovers ${settled ? "a completed payment" : "an uncharged approved order"} without charging during status checks`, async () => {
    let captures = 0;
    const page = browser("returning", (path) => {
      if (path.endsWith("/capture")) {
        if (++captures === 1) throw new Error("connection lost");
        return { order: complete };
      }
      if (path === `/api/orders/${complete.id}`) return { order: settled ? complete : { id: complete.id, status: "APPROVED" } };
    });
    await page.ready();
    await page.callbacks.createOrder();
    await page.callbacks.onApprove({ orderID: complete.id });
    await page.element("place-order").events.click();
    assert.equal(page.element("place-order").disabled, true);
    await page.callbacks.onApprove({ orderID: complete.id });
    await page.element("check-status").events.click();
    assert.equal(captures, 1);
    assert.equal(page.requests.some((request) => request.path === "/api/direct-charge"), false);
    assert.equal(page.element("place-order").disabled, settled);
    if (!settled) await page.element("place-order").events.click();
    assert.equal(captures, settled ? 1 : 2);
    assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
  });
}

test("empty returning state makes no SDK or payment calls", async () => {
  const page = browser("returning", undefined, null);
  await page.ready();
  assert.equal(page.scripts.length, 0);
  assert.equal(page.element("empty-state").hidden, false);
  assert.equal(page.requests.length, 2);
});

test("missing beta component produces a clear error without substituting another payment UI", async () => {
  const page = browser("returning", undefined, savedBuyer, false);
  await page.ready();
  assert.match(page.element("status").textContent, /did not expose SavedPaymentMethods/);
  assert.equal(page.renders.length, 0);
  assert.equal(page.element("place-order").disabled, true);
});
