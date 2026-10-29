import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const savedBuyer = { revision: "revision-1", vaultId: "server-vault-1", state: "VAULTED", savedAt: new Date().toISOString() };
const savedCardBuyer = { ...savedBuyer, methodType: "card", card: { brand: "VISA", lastDigits: "1111", expiry: "2030-12" } };
const complete = { id: "ORDER00001", status: "COMPLETED", completed: true, purchase_units: [{ payments: { captures: [{ id: "CAPTURE00001", status: "COMPLETED" }] } }] };
const createTrace = {
  request: { method: "POST", url: "https://api-m.sandbox.paypal.com/v2/checkout/orders", headers: { "PayPal-Request-Id": "create-test", Authorization: "Bearer create-access-token" }, authentication: { method: "Bearer", token: "create-access-token" }, body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "10.00" } }] } },
  response: { status: 201, headers: {}, body: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } }, attempted: true,
};
const captureTrace = {
  request: { method: "POST", url: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${complete.id}/capture`, headers: { "PayPal-Request-Id": "capture-test", Authorization: "Bearer capture-access-token" }, authentication: { method: "Bearer", token: "capture-access-token" }, body: {} },
  response: { status: 201, headers: {}, body: complete }, attempted: true,
};
const savedCreateTrace = { ...createTrace, request: { ...createTrace.request, headers: { ...createTrace.request.headers, Authorization: "[REDACTED]" }, authentication: { method: "Bearer", token: "[REDACTED]" } } };

// This exercises browser event logic and SDK configuration with a fake DOM and
// PayPal SDK. It is a contract test, not visual/browser or real-PayPal testing.
function browser(flow, backend = () => undefined, initialBuyer = savedBuyer, hasComponent = true, options = {}) {
  const elements = new Map(), scripts = [], renders = [], cardRenders = [], cardSubmissions = [], requests = [], navigations = [], storage = new Map(options.storage);
  let callbacks, cardCallbacks;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, open: false, checked: false, value: "", textContent: "", className: "", events: {},
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
    CardFields(configuration) {
      cardCallbacks = configuration;
      const render = () => ({ async render(selector) { cardRenders.push(selector); } });
      return {
        isEligible: () => options.cardEligible !== false,
        NameField: render, NumberField: render, ExpiryField: render, CVVField: render,
        async getState() { return { isFormValid: options.cardValid !== false }; },
        async submit(values) {
          cardSubmissions.push(values);
          const orderID = await configuration.createOrder();
          if (options.cardFailure) throw new Error("Card validation failed with private SDK details");
          if (options.cardConfirmWait) await options.cardConfirmWait;
          await configuration.onApprove({ orderID });
          if (options.duplicateCardApproval) await configuration.onApprove({ orderID });
        },
      };
    },
  };
  const context = vm.createContext({
    document: {
      body: { dataset: { flow } }, getElementById: element,
      querySelectorAll: () => [element("amount-1"), element("amount-2")],
      createElement: () => element(`script-${scripts.length}`),
      head: { appendChild(script) { scripts.push(script); queueMicrotask(async () => { await options.sdkLoadWait; script.onload(); }); } },
    },
    window: { paypal, ...(options.applePay ? { ApplePaySession: function () {} } : {}) },
    navigator: { userAgent: options.userAgent || "Chrome/130.0 Safari/537.36", platform: options.platform || "Linux x86_64", maxTouchPoints: options.maxTouchPoints || 0 },
    location: { search: options.search || "", pathname: `/${flow === "new" ? "new" : "returning"}-customer`, reload() {}, assign(url) { navigations.push(url); } },
    history: { replaceState() {} },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    crypto, URLSearchParams, Intl, Date,
    fetch: async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, init });
      const custom = await backend(path, body);
      if (custom instanceof Response) return custom;
      if (custom !== undefined) return Response.json(custom);
      if (path === "/api/config") return Response.json({ clientId: "public-client-id", sdkBase: "https://www.sandbox.paypal.com", environment: "sandbox", currency: "USD", amount: "10.00" });
      if (path === "/api/state") return Response.json({ buyer: initialBuyer });
      if (path === "/api/client-token") return Response.json({ clientToken: "scoped-test-token", expiresIn: 32400 });
      if (path === "/api/orders") return Response.json({ order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, traces: { create: createTrace } });
      if (path.endsWith("/capture")) return Response.json({ order: complete, traces: { create: savedCreateTrace, capture: captureTrace } });
      if (path === "/api/direct-charge") return Response.json({ order: complete, traces: { create: {
        ...createTrace,
        request: { ...createTrace.request, body: { intent: "CAPTURE", payment_source: { paypal: { vault_id: savedBuyer.vaultId } } } },
        response: { ...createTrace.response, body: complete },
      } } });
      throw new Error(`Unexpected API call: ${path}`);
    },
  });
  vm.runInContext(source, context);
  async function ready() {
    for (let count = 0; count < 100; count++) {
      if (cardCallbacks || renders.length || element("status").className.includes("error") || element("status").className.includes("success")) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("Frontend did not finish initialization");
  }
  async function selectMethod(method) {
    element(`method-${method}`).checked = true;
    await element(`method-${method}`).events.change();
  }
  async function openCard() {
    if (flow === "new") await selectMethod("card");
    else {
      element("card-option").open = true;
      await element("card-option").events.toggle?.();
    }
    element("billing-line1").value = "Test street 1";
    element("billing-city").value = "Berlin";
    element("billing-postal").value = "10115";
    element("billing-country").value = "DE";
  }
  const submitCard = () => element("card-form").events.submit({ preventDefault() {} });
  return { ready, selectMethod, openCard, submitCard, element, scripts, renders, cardRenders, cardSubmissions, requests, navigations, storage, get callbacks() { return callbacks; }, get cardCallbacks() { return cardCallbacks; } };
}

test("new page loads SDK v5 with vaulting, PayPal Buttons and Card Fields", async () => {
  const page = browser("new");
  await page.ready();
  const sdk = new URL(page.scripts[0].src);
  assert.equal(sdk.pathname, "/sdk/js");
  assert.equal(sdk.searchParams.get("components"), "buttons,card-fields");
  assert.equal(sdk.searchParams.get("vault"), "true");
  assert.equal(sdk.searchParams.get("commit"), "true");
  assert.deepEqual(page.renders, []);
  assert.deepEqual(page.cardRenders, []);
  for (const method of ["paypal", "card", "wallet"]) assert.equal(page.element(`method-${method}`).checked, false);
  for (const panel of ["checkout-controls", "alternative-controls", "card-option", "wallet-panel"]) assert.equal(page.element(panel).hidden, true);
  await page.selectMethod("paypal");
  assert.deepEqual(page.renders, ["#paypal-button-container"]);
  assert.equal(page.requests.some((request) => request.path === "/api/client-token"), false);
  await page.callbacks.createOrder();
  await page.callbacks.onApprove({ orderID: complete.id });
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  assert.match(page.element("status").textContent, /Payment completed/);
  assert.equal(page.element("payment-methods").hidden, true);
});

test("new-customer method selection reveals only that method and reuses mounted SDK fields", async () => {
  const page = browser("new");
  await page.ready();
  await page.selectMethod("paypal");
  page.element("save-paypal").checked = true;
  assert.equal(page.element("checkout-controls").hidden, false);
  assert.equal(page.element("alternative-controls").hidden, true);
  await page.openCard();
  page.element("save-card").checked = true;
  assert.equal(page.element("checkout-controls").hidden, true);
  assert.equal(page.element("card-option").hidden, false);
  assert.equal(page.element("wallet-panel").hidden, true);
  assert.equal(page.cardRenders.length, 4);
  await assert.rejects(page.callbacks.createOrder(), /Select PayPal/);
  await page.callbacks.onApprove({ orderID: "CANCELLEDORDER" });
  await page.selectMethod("wallet");
  assert.equal(page.element("card-option").hidden, true);
  assert.equal(page.element("wallet-panel").hidden, false);
  assert.equal(page.element("wallet-option").disabled, true);
  await page.submitCard();
  await page.selectMethod("paypal");
  await page.selectMethod("card");
  assert.equal(page.element("method-card").checked, true);
  assert.equal(page.element("method-paypal").checked, false);
  assert.equal(page.element("method-wallet").checked, false);
  assert.equal(page.element("save-paypal").checked, true);
  assert.equal(page.element("save-card").checked, true);
  assert.equal(page.cardRenders.length, 4);
  assert.equal(page.renders.length, 1);
  assert.equal(page.requests.length, 2); // Selection never creates a payment.
});

for (const method of ["paypal", "card", "wallet"]) {
  test(`a ${method} selection made while the SDK loads is rendered after it becomes ready`, async () => {
    let release;
    const sdkLoadWait = new Promise((resolve) => { release = resolve; });
    const page = browser("new", undefined, savedBuyer, true, { sdkLoadWait });
    await page.selectMethod(method);
    assert.equal(page.renders.length, 0);
    assert.equal(page.cardRenders.length, 0);
    release();
    await page.ready();
    assert.equal(page.element(`method-${method}`).checked, true);
    assert.equal(page.renders.length, method === "paypal" ? 1 : 0);
    assert.equal(page.cardRenders.length, method === "card" ? 4 : 0);
    assert.equal(page.requests.length, 2);
  });
}

test("returning page scopes SDK through its data attribute and all four required components", async () => {
  const page = browser("returning");
  await page.ready();
  const script = page.scripts[0];
  const sdk = new URL(script.src);
  assert.equal(sdk.searchParams.get("components"), "buttons,funding-eligibility,messages,saved-payment-methods,card-fields");
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
  assert.equal(page.element("create-trace").open, true);
  assert.equal(page.element("create-trace-status").textContent, "HTTP 201");
  assert.deepEqual(JSON.parse(page.element("create-request").textContent), createTrace.request);
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.method, "Bearer");
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.token, "create-access-token");
  assert.deepEqual(JSON.parse(page.element("create-response").textContent).body, createTrace.response.body);
  assert.equal(page.element("capture-trace-status").textContent, "Not requested");
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
  assert.equal(page.element("capture-trace").open, true);
  assert.deepEqual(JSON.parse(page.element("capture-request").textContent).body, {});
  assert.equal(JSON.parse(page.element("capture-response").textContent).body.purchase_units[0].payments.captures[0].id, "CAPTURE00001");
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.token, "create-access-token");
  assert.equal(JSON.parse(page.element("capture-request").textContent).authentication.token, "capture-access-token");
  assert.equal(page.element("activity").textContent.includes("capture-access-token"), false);
  assert.equal(JSON.stringify([...page.storage]).includes("access-token"), false);
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
  assert.equal(page.element("capture-trace-status").textContent, "No separate call");
  assert.match(page.element("capture-request").textContent, /No separate capture request was sent/);
  assert.equal(JSON.parse(page.element("create-response").textContent).body.id, complete.id);
});

test("a failed create displays the REST request and error response without attempting capture", async () => {
  const failedTrace = { ...createTrace, response: { status: 422, headers: {}, body: { name: "UNPROCESSABLE_ENTITY", message: "Order rejected" } } };
  const page = browser("returning", (path) => {
    if (path === "/api/orders") return Response.json({ error: "PAYPAL_API_ERROR", message: "Order rejected", details: { traces: { create: failedTrace } } }, { status: 502 });
  });
  await page.ready();
  await assert.rejects(page.callbacks.createOrder(), /Order rejected/);
  assert.equal(page.element("create-trace-status").textContent, "HTTP 422");
  assert.equal(JSON.parse(page.element("create-request").textContent).body.intent, "CAPTURE");
  assert.equal(JSON.parse(page.element("create-response").textContent).body.name, "UNPROCESSABLE_ENTITY");
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.token, "create-access-token");
  assert.equal(page.element("activity").textContent.includes("create-access-token"), false);
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
    if (path.startsWith("/api/operations/")) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, traces: { create: savedCreateTrace } };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED" }, traces: { create: savedCreateTrace } };
  }, savedBuyer, true, { storage: first.storage });
  await restored.ready();
  assert.equal(restored.element("payment-order-id").textContent, complete.id);
  assert.match(JSON.parse(restored.element("create-request").textContent).authentication.token, /Not retained/);
  assert.equal(restored.element("create-request").textContent.includes("create-access-token"), false);
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

test("empty returning state still loads Card Fields without a vault-scoped token or payment calls", async () => {
  const page = browser("returning", undefined, null);
  await page.ready();
  assert.equal(page.scripts.length, 1);
  assert.equal(new URL(page.scripts[0].src).searchParams.get("components"), "buttons,card-fields");
  assert.equal(page.scripts[0]["data-sdk-client-token"], undefined);
  assert.deepEqual(page.renders, ["#other-paypal-buttons"]);
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

for (const flow of ["new", "returning"]) {
  test(`${flow} page performs a hosted card checkout independently of the saved PayPal buyer`, async () => {
    const page = browser(flow, undefined, flow === "returning" ? null : savedBuyer, true, { duplicateCardApproval: true });
    await page.ready();
    await page.openCard();
    assert.deepEqual(page.cardRenders, ["#card-name-field", "#card-number-field", "#card-expiry-field", "#card-cvv-field"]);
    assert.equal(page.element("card-submit").disabled, false);
    await Promise.all([page.submitCard(), page.submitCard()]);
    const creates = page.requests.filter((request) => request.path === "/api/orders");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].body.flow, "card");
    assert.equal(creates[0].body.page, flow);
    assert.deepEqual(Object.keys(creates[0].body).sort(), flow === "new" ? ["flow", "page", "requestId", "savePaymentMethod"] : ["flow", "page", "requestId"]);
    assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
    assert.equal(page.requests.some((request) => request.path === "/api/direct-charge"), false);
    assert.equal(page.element("payment-order-id").textContent, complete.id);
    assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
    assert.match(page.element("status").textContent, /Card payment completed/);
    assert.equal(page.element("status").textContent.includes("Vaulting is pending"), false);
    assert.equal(page.element("alternative-controls").hidden, true);
    assert.equal(page.cardSubmissions[0].billingAddress.countryCode, "DE");
    assert.equal(page.cardSubmissions[0].billingAddress.adminArea2, "Berlin");
    for (const privateValue of ["Test street 1", "10115", "Berlin"]) {
      assert.equal(JSON.stringify(page.requests).includes(privateValue), false);
      assert.equal(JSON.stringify([...page.storage]).includes(privateValue), false);
      assert.equal(page.element("activity").textContent.includes(privateValue), false);
    }
  });
}

test("invalid hosted card fields do not create an order or capture payment", async () => {
  const page = browser("new", undefined, savedBuyer, true, { cardValid: false });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.requests.some((request) => request.path === "/api/orders" || request.path.endsWith("/capture")), false);
  assert.match(page.element("status").textContent, /Check the card number/);
  assert.equal(page.element("card-submit").disabled, false);
});

test("a card authentication challenge stays interactive while other payment submissions are locked", async () => {
  let release;
  const cardConfirmWait = new Promise((resolve) => { release = resolve; });
  const page = browser("new", undefined, savedBuyer, true, { cardConfirmWait });
  await page.ready();
  await page.selectMethod("paypal");
  await page.openCard();
  const payment = page.submitCard();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("alternative-controls").inert, false);
  assert.equal(page.element("checkout-controls").inert, true);
  assert.equal(page.element("card-submit").disabled, true);
  assert.equal(page.element("payment-methods").disabled, true);
  await page.selectMethod("wallet");
  assert.equal(page.element("method-card").checked, true);
  assert.equal(page.element("method-wallet").checked, false);
  assert.equal(page.element("card-option").hidden, false);
  await page.submitCard();
  await page.callbacks.onApprove({ orderID: "OLDPAYPALORDER" });
  assert.equal(page.requests.filter((request) => request.path === "/api/orders").length, 1);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  release();
  await payment;
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

test("ineligible Card Fields show an actionable message and preserve PayPal checkout", async () => {
  const page = browser("new", undefined, savedBuyer, true, { cardEligible: false });
  await page.ready();
  assert.equal(page.element("card-form").hidden, true);
  assert.match(page.element("card-status").textContent, /Enable Advanced Credit and Debit Card Payments/);
  await page.selectMethod("paypal");
  assert.deepEqual(page.renders, ["#paypal-button-container"]);
  await page.callbacks.createOrder();
  await page.callbacks.onApprove({ orderID: complete.id });
  assert.match(page.element("status").textContent, /Payment completed/);
});

test("a lost card capture response checks status without charging again and allows explicit capture recovery", async () => {
  let captures = 0;
  const page = browser("returning", (path) => {
    if (path.endsWith("/capture") && ++captures === 1) throw new Error("response lost");
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true }, traces: { create: savedCreateTrace } };
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.element("check-status").hidden, false);
  assert.equal(page.element("card-submit").disabled, true);
  await page.element("check-status").events.click();
  assert.equal(captures, 1);
  assert.equal(page.element("resume-card").hidden, false);
  await page.element("resume-card").events.click();
  assert.equal(captures, 2);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("a pending card capture cannot be submitted again using the approval recovery button", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return { order: {
      id: complete.id, status: "COMPLETED", completed: false,
      purchase_units: [{ payments: { captures: [{ id: "PENDING00001", status: "PENDING" }] } }],
    } };
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.element("resume-card").hidden, true);
  assert.equal(page.element("card-submit").disabled, true);
  assert.equal(page.element("check-status").hidden, false);
  await page.element("resume-card").events.click();
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

test("a failed card confirmation is recovered using the same order creation key", async () => {
  const page = browser("new", (path) => {
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
  }, savedBuyer, true, { cardFailure: true });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(page.element("activity").textContent.includes("private SDK details"), false);
  await page.element("check-status").events.click();
  assert.equal(page.element("card-submit").disabled, false);
  await page.submitCard();
  const creates = page.requests.filter((request) => request.path === "/api/orders");
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body.requestId, creates[1].body.requestId);
});

test("reload and card redirects restore approved card orders without an automatic capture", async () => {
  const initial = browser("new", undefined, savedBuyer, true, { cardFailure: true });
  await initial.ready();
  await initial.openCard();
  await initial.submitCard();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, flow: "card" };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true } };
  }, savedBuyer, true, { storage: initial.storage, search: `?card=return&token=${complete.id}` });
  await page.ready();
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(page.element("resume-card").hidden, false);
  await page.element("resume-card").events.click();
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

for (const method of ["paypal", "card"]) {
  test(`new-customer ${method} saving is opt-in and sends the selected consent`, async () => {
    for (const save of [false, true]) {
      const page = browser("new");
      await page.ready();
      assert.equal(page.element(`save-${method}`).checked, false);
      page.element(`save-${method}`).checked = save;
      if (method === "card") {
        await page.openCard();
        await page.submitCard();
      } else {
        await page.selectMethod("paypal");
        await page.callbacks.createOrder();
      }
      const input = page.requests.find((request) => request.path === "/api/orders").body;
      assert.equal(input.savePaymentMethod, save);
    }
  });
}

test("changing PayPal save consent after cancellation starts a new idempotent attempt", async () => {
  const page = browser("new");
  await page.ready();
  await page.selectMethod("paypal");
  await page.callbacks.createOrder();
  page.callbacks.onCancel();
  page.element("save-paypal").checked = true;
  page.element("save-paypal").events.change();
  await page.callbacks.createOrder();
  const orders = page.requests.filter((request) => request.path === "/api/orders");
  assert.notEqual(orders[0].body.requestId, orders[1].body.requestId);
  assert.equal(orders[1].body.savePaymentMethod, true);
});

test("a saved card is offered with fresh card fields, PayPal, and a wallet without loading ViewEditFI", async () => {
  const page = browser("returning", undefined, savedCardBuyer);
  await page.ready();
  assert.equal(page.element("saved-card-method").hidden, false);
  assert.match(page.element("saved-card-description").textContent, /VISA.*1111/);
  assert.match(page.element("saved-card-expiry").textContent, /2030-12/);
  assert.equal(page.requests.some((request) => request.path === "/api/client-token"), false);
  assert.deepEqual(page.renders, ["#other-paypal-buttons"]);
  assert.equal(page.element("place-order").disabled, false);
  assert.equal(page.element("saved-method-type").textContent, "Credit / debit card");
  assert.equal(page.element("wallet-option").disabled, true);
  await page.openCard();
  assert.equal(page.cardRenders.length, 4);
});

test("saved-card checkout follows 3DS and restores an authenticated order for explicit capture", async () => {
  const payerActionUrl = "https://www.sandbox.paypal.com/webapps/helios?flow=3ds&cart_id=ORDER00001";
  const first = browser("returning", (path) => {
    if (path === "/api/orders") return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED", payerActionUrl } };
  }, savedCardBuyer);
  await first.ready();
  await first.element("place-order").events.click();
  assert.deepEqual(first.navigations, [payerActionUrl]);
  const input = first.requests.find((request) => request.path === "/api/orders").body;
  assert.equal(input.flow, "saved-card");
  assert.equal(input.vaultRevision, savedCardBuyer.revision);
  assert.equal(input.vault_id, undefined);
  assert.equal(first.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(first.element("card-submit").disabled, true);
  const returned = browser("returning", (path) => {
    if (path.startsWith("/api/operations/")) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, flow: "saved-card" };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true } };
  }, savedCardBuyer, true, { storage: first.storage, search: "?saved-card=return" });
  await returned.ready();
  assert.equal(returned.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(returned.element("resume-card").hidden, false);
  await returned.element("resume-card").events.click();
  assert.equal(returned.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  assert.equal(returned.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("an unverified saved card cannot show or use the capture recovery action", async () => {
  const page = browser("returning", (path) => {
    if (path === "/api/orders") return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: false } };
  }, savedCardBuyer);
  await page.ready();
  await page.element("place-order").events.click();
  assert.equal(page.element("resume-card").hidden, true);
  await page.element("resume-card").events.click();
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
});

test("PayPal remains available alongside a saved card without saving that PayPal purchase", async () => {
  const page = browser("returning", undefined, savedCardBuyer);
  await page.ready();
  assert.equal(new URL(page.scripts[0].src).searchParams.get("commit"), "true");
  await page.callbacks.createOrder();
  const input = page.requests.find((request) => request.path === "/api/orders").body;
  assert.equal(input.flow, "paypal");
  assert.equal(input.vaultRevision, undefined);
  assert.equal(input.savePaymentMethod, undefined);
  await page.callbacks.onApprove({ orderID: complete.id });
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

test("a reloaded card attempt restores its original save consent", async () => {
  const first = browser("new", undefined, savedBuyer, true, { cardFailure: true });
  await first.ready();
  await first.openCard();
  first.element("save-card").checked = true;
  await first.submitCard();
  const restored = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, flow: "card", savePaymentMethod: true };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
  }, savedBuyer, true, { storage: first.storage, cardFailure: true });
  await restored.ready();
  assert.equal(restored.element("save-card").checked, true);
  await restored.openCard();
  await restored.submitCard();
  const input = restored.requests.find((request) => request.path === "/api/orders").body;
  assert.equal(input.savePaymentMethod, true);
  assert.equal(input.requestId, first.requests.find((request) => request.path === "/api/orders").body.requestId);
});

for (const scenario of [
  { name: "Safari on macOS", userAgent: "Mozilla/5.0 Macintosh Version/18.0 Safari/605.1.15", platform: "MacIntel", wallet: "Apple Pay" },
  { name: "Safari on iPhone", userAgent: "Mozilla/5.0 iPhone Version/18.0 Mobile Safari/604.1", platform: "iPhone", wallet: "Apple Pay" },
  { name: "Chrome on iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1", platform: "iPhone", wallet: "Apple Pay" },
  { name: "Chrome on iPad", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1", platform: "iPad", wallet: "Apple Pay" },
  { name: "desktop-mode iPad Chrome", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 CriOS/130.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5, wallet: "Apple Pay" },
  { name: "Chrome on macOS", userAgent: "Mozilla/5.0 Macintosh Chrome/130.0 Safari/537.36", platform: "MacIntel", wallet: "Apple Pay" },
  { name: "Chrome on Android", userAgent: "Mozilla/5.0 Android Chrome/130.0 Mobile Safari/537.36", platform: "Linux armv8", wallet: "Google Pay" },
  { name: "a browser exposing ApplePaySession", applePay: true, wallet: "Apple Pay" },
]) {
  test(`${scenario.name} gets a display-only ${scenario.wallet} option without a payment handler`, async () => {
    for (const flow of ["new", "returning"]) {
      const page = browser(flow, undefined, savedBuyer, true, scenario);
      await page.ready();
      if (flow === "new") {
        assert.equal(page.element("wallet-choice-label").textContent, scenario.wallet);
        await page.selectMethod("wallet");
        assert.equal(page.element("wallet-panel").hidden, false);
      }
      assert.equal(page.element("wallet-label").textContent, scenario.wallet);
      assert.equal(page.element("wallet-option").disabled, true);
      assert.equal(page.element("wallet-option").events.click, undefined);
      assert.equal(page.requests.some((request) => request.path === "/api/orders" || request.path === "/api/direct-charge"), false);
    }
  });
}
