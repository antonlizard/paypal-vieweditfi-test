import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const savedBuyer = { revision: "revision-1", vaultId: "server-vault-1", state: "VAULTED", savedAt: new Date().toISOString() };
const savedCardBuyer = { ...savedBuyer, methodType: "card", card: { brand: "VISA", lastDigits: "1111", expiry: "2030-12" } };
const complete = { id: "ORDER00001", status: "COMPLETED", completed: true, purchase_units: [{ payments: { captures: [{ id: "CAPTURE00001", status: "COMPLETED" }] } }] };
// Legacy responses deliberately include dummy tokens to verify UI redaction.
const createTrace = {
  request: { method: "POST", url: "https://api-m.sandbox.paypal.com/v2/checkout/orders", headers: { "PayPal-Request-Id": "create-test", Authorization: "Bearer create-access-token" }, authentication: { method: "Bearer", token: "create-access-token" }, body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "10.00" } }] } },
  response: { status: 201, headers: {}, body: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } }, attempted: true,
};
const captureTrace = {
  request: { method: "POST", url: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${complete.id}/capture`, headers: { "PayPal-Request-Id": "capture-test", Authorization: "Bearer capture-access-token" }, authentication: { method: "Bearer", token: "capture-access-token" }, body: {} },
  response: { status: 201, headers: {}, body: complete }, attempted: true,
};
const savedCreateTrace = { ...createTrace, request: { ...createTrace.request, headers: { ...createTrace.request.headers, Authorization: "[REDACTED]" }, authentication: { method: "Bearer", token: "[REDACTED]" } } };

function missingOrderResponse(orderID) {
  return Response.json({ error: "PAYPAL_API_ERROR", message: "The specified resource does not exist.", details: {
    httpStatus: 404, name: "RESOURCE_NOT_FOUND", debugId: "missing-order-debug", issues: [{ issue: "INVALID_RESOURCE_ID" }],
    traces: { get: { attempted: true, request: {
      method: "GET", url: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}?fields=payment_source`,
      headers: { Authorization: "[REDACTED]" }, authentication: { method: "Bearer", token: "[REDACTED]" }, body: null,
    }, response: { status: 404, body: { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] } } } },
  } }, { status: 502 });
}

// This exercises browser event logic and SDK configuration with a fake DOM and
// PayPal SDK. It is a contract test, not visual/browser or real-PayPal testing.
function browser(flow, backend = () => undefined, initialBuyer = savedBuyer, hasComponent = true, options = {}) {
  const elements = new Map(), scripts = [], renders = [], cardRenders = [], cardSubmissions = [], cardConfigurations = [], closedFields = [], requests = [], navigations = [], storage = new Map(options.storage);
  let callbacks, cardCallbacks;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, open: false, checked: false, value: "", textContent: "", className: "", dataset: {}, events: {},
      addEventListener(event, handler) { this.events[event] = handler; },
      querySelector(selector) { return element(`${id}:${selector}`); },
      setAttribute(name, value) { this[name] = value; },
      replaceChildren() { this.replaced = true; },
    });
    return elements.get(id);
  }
  const paypal = {
    FUNDING: { PAYPAL: "paypal" },
    Buttons(options) { callbacks = options; return { async render(selector) { renders.push(selector); } }; },
    ...(hasComponent ? { SavedPaymentMethods(options) { callbacks = options; return { async render(selector) { renders.push(selector); } }; } } : {}),
    CardFields(configuration) {
      cardConfigurations.push(configuration);
      cardCallbacks = configuration;
      const render = () => ({ async render(selector) { cardRenders.push(selector); await options.cardRenderWait; }, async close() { closedFields.push(true); } });
      return {
        isEligible: () => options.cardEligible !== false,
        NameField: render, NumberField: render, ExpiryField: render, CVVField: render,
        async getState() { return { isFormValid: options.cardValid !== false }; },
        async submit(values) {
          cardSubmissions.push(values);
          const orderID = await configuration.createOrder();
          if (options.cardFailure) throw new Error("Card validation failed with private SDK details");
          if (options.cardSDKError) {
            configuration.onError(options.cardSDKError);
            throw options.cardSDKError;
          }
          if (options.cardCancel) {
            configuration.onCancel();
            if (options.lateCardApproval) await configuration.onApprove({ orderID });
            throw new Error("3DS iframe closed with private SDK details");
          }
          if (options.cardConfirmWait) await options.cardConfirmWait;
          if (options.cardNoApproval) return;
          try {
            const approval = configuration.onApprove({ orderID, ...(options.cardApproval || {}) });
            if (options.sdkDoesNotWaitApproval) {
              Promise.resolve(approval).catch(configuration.onError);
              if (options.sdkErrorAfterApproval) throw options.sdkErrorAfterApproval;
              return;
            }
            await approval;
          } catch (error) {
            if (!options.wrapApprovalError) throw error;
            // SDK/iframe boundaries do not preserve the merchant Error identity.
            const wrapped = new Error(`SDK callback rejected: ${error.message}`);
            configuration.onError(wrapped);
            throw wrapped;
          }
          if (options.sdkErrorAfterApproval) {
            configuration.onError(options.sdkErrorAfterApproval);
            throw options.sdkErrorAfterApproval;
          }
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
  const startup = vm.runInContext(source, context);
  async function ready() {
    await startup;
    await new Promise((resolve) => setImmediate(resolve));
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
  }
  async function submitCard() {
    await element("card-form").events.submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { ready, selectMethod, openCard, submitCard, element, scripts, renders, cardRenders, cardSubmissions, cardConfigurations, closedFields, requests, navigations, storage, get callbacks() { return callbacks; }, get cardCallbacks() { return cardCallbacks; } };
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
  assert.deepEqual(JSON.parse(page.element("create-request").textContent), savedCreateTrace.request);
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.method, "Bearer");
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.token, "[REDACTED]");
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
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.token, "[REDACTED]");
  assert.equal(JSON.parse(page.element("capture-request").textContent).authentication.token, "[REDACTED]");
  for (const kind of ["create", "capture"]) {
    assert.equal(JSON.parse(page.element(`${kind}-request`).textContent).headers.Authorization, "[REDACTED]");
    assert.equal(page.element(`${kind}-request`).textContent.includes("access-token"), false);
  }
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
  assert.equal(JSON.parse(page.element("create-request").textContent).authentication.token, "[REDACTED]");
  assert.equal(page.element("create-request").textContent.includes("create-access-token"), false);
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
  assert.equal(JSON.parse(restored.element("create-request").textContent).authentication.token, "[REDACTED]");
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
    assert.deepEqual(page.cardSubmissions, [undefined]);
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
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "capture");
  await page.element("check-status").events.click();
  assert.equal(captures, 1);
  assert.equal(page.element("resume-card").hidden, false);
  await page.element("resume-card").events.click();
  assert.equal(captures, 2);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("a pending card capture cannot be submitted again using the approval recovery button", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture") || path === `/api/orders/${complete.id}`) return { order: {
      id: complete.id, status: "COMPLETED", completed: false,
      purchase_units: [{ payments: { captures: [{ id: "PENDING00001", status: "PENDING" }] } }],
    } };
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.element("resume-card").hidden, true);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "check");
  assert.equal(page.element("check-status").hidden, false);
  await page.element("resume-card").events.click();
  await page.submitCard(); // The primary action checks status, not a new payment.
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

const sdkFailure = {
  name: "UNPROCESSABLE_ENTITY", code: "CARD_FIELDS_3DS_ERROR", debug_id: "0123456789abc",
  message: "3D Secure authentication failed with private SDK details",
  details: [{ issue: "PAYER_ACTION_REQUIRED", description: "private SDK details", value: "4111111111111111" }],
  card: { number: "4111111111111111", cvv: "123" }, authorization: "Bearer private-sdk-token",
};
for (const scenario of [
  { name: "a structured SDK failure", error: sdkFailure, category: "AUTHENTICATION_FAILED", structured: true },
  { name: "a serialized SDK failure", error: new Error(`PayPal error: ${JSON.stringify(sdkFailure)}`), category: "AUTHENTICATION_FAILED", structured: true },
  { name: "an iframe communication failure", error: new Error("zoid iframe failed at https://example.test/?token=private-sdk-token with private SDK details"), category: "IFRAME_COMMUNICATION" },
]) {
  test(`${scenario.name} preserves safe 3DS diagnostics without exposing raw SDK data`, async () => {
    const page = browser("new", undefined, savedBuyer, true, { cardSDKError: scenario.error });
    await page.ready();
    await page.openCard();
    await page.submitCard();
    const activity = page.element("activity").textContent;
    assert.match(activity, /CARD_SDK_ERROR/);
    assert.match(activity, /"stage": "authentication"/);
    assert.match(activity, /"callback": "sdk-onError"/);
    assert.match(activity, /"callback": "submit-rejected"/);
    assert.ok(activity.includes(scenario.category));
    if (scenario.structured) {
      for (const id of [sdkFailure.name, sdkFailure.code, sdkFailure.debug_id, sdkFailure.details[0].issue]) assert.ok(activity.includes(id));
    }
    for (const value of ["4111111111111111", "private-sdk-token", "private SDK details", "example.test"]) assert.equal(activity.includes(value), false);
    assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
    assert.equal(page.element("check-status").hidden, false);
  });
}

test("3DS cancellation blocks a late approval and status recovery logs PayPal's authentication result without capturing", async () => {
  const page = browser("new", (path) => {
    if (path === `/api/orders/${complete.id}`) return { order: {
      id: complete.id, status: "APPROVED", cardAuthenticated: true,
      payment_source: { card: { authentication_result: {
        liability_shift: "POSSIBLE", three_d_secure: { authentication_status: "Y", enrollment_status: "Y" },
      } } },
    } };
  }, savedBuyer, true, { cardCancel: true, lateCardApproval: true });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.match(page.element("status").textContent, /verification was cancelled or closed/);
  assert.match(page.element("activity").textContent, /CardFields.onCancel 3DS result/);
  assert.equal(page.element("activity").textContent.includes("private SDK details"), false);
  assert.equal(page.element("activity").textContent.includes("CARD_SDK_ERROR"), false);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  await page.element("check-status").events.click();
  assert.match(page.element("activity").textContent, /Card authentication status from PayPal/);
  assert.match(page.element("activity").textContent, /"authenticationStatus": "Y"/);
  assert.match(page.element("activity").textContent, /"liabilityShift": "POSSIBLE"/);
  assert.equal(page.element("resume-card").hidden, false);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
});

for (const flow of ["new", "returning"]) {
  for (const failure of ["cancel", "sdk-error", "submit-rejection"]) {
    test(`${flow} checkout releases controls and rebuilds card fields after ${failure}`, async () => {
      const page = browser(flow, undefined, savedBuyer, true, {
        cardCancel: failure === "cancel", cardSDKError: failure === "sdk-error" ? sdkFailure : undefined,
        cardFailure: failure === "submit-rejection",
      });
      await page.ready();
      await page.openCard();
      const old = page.cardCallbacks;
      await page.submitCard();
      assert.equal(page.element("alternative-controls").inert, false);
      assert.equal(page.element("card-submit").disabled, false);
      assert.equal(page.element("check-status").hidden, false);
      assert.equal(page.cardConfigurations.length, 2);
      assert.equal(page.closedFields.length, 4);
      for (const field of ["name", "number", "expiry", "cvv"]) assert.equal(page.element(`card-${field}-field`).replaced, true);
      await old.onApprove({ orderID: complete.id, liabilityShift: "POSSIBLE" });
      assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
      if (flow === "new") {
        assert.equal(page.element("payment-methods").disabled, false);
        await page.selectMethod("wallet");
        assert.equal(page.element("wallet-panel").hidden, false);
        await page.selectMethod("paypal");
        assert.equal(page.element("checkout-controls").inert, false);
      }
      await page.callbacks.createOrder();
      assert.equal(page.requests.filter((request) => request.path === "/api/orders").length, 2);
    });
  }
}

test("a cancelled SDK submit that settles late cannot change a newer PayPal checkout", async () => {
  let releaseCard, releasePayPal;
  const cardConfirmWait = new Promise((resolve) => { releaseCard = resolve; });
  let creates = 0;
  const page = browser("new", (path) => {
    if (path === "/api/orders" && ++creates === 2) return new Promise((resolve) => { releasePayPal = resolve; });
  }, savedBuyer, true, { cardConfirmWait });
  await page.ready();
  await page.openCard();
  const old = page.cardCallbacks;
  const submitted = page.submitCard();
  await new Promise((resolve) => setImmediate(resolve));
  old.onCancel();
  await new Promise((resolve) => setImmediate(resolve));
  await page.selectMethod("paypal");
  const paypal = page.callbacks.createOrder();
  await new Promise((resolve) => setImmediate(resolve));
  releaseCard();
  await submitted;
  assert.equal(page.element("payment-methods").disabled, true);
  assert.equal(page.element("checkout-controls").inert, true);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  releasePayPal({ order: { id: "PAYPAL00002", status: "PAYER_ACTION_REQUIRED" } });
  assert.equal(await paypal, "PAYPAL00002");
  assert.equal(page.element("payment-order-id").textContent, "PAYPAL00002");
});

test("frontend approval and backend Get Order 3DS results are logged separately with a redacted GET trace", async () => {
  const authentication = { liability_shift: "POSSIBLE", three_d_secure: { authentication_status: "Y", enrollment_status: "Y" } };
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return { order: complete, traces: { get: {
      request: { method: "GET", url: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${complete.id}?fields=payment_source`,
        headers: { Authorization: "Bearer legacy-access-token" }, authentication: { method: "Bearer", token: "legacy-access-token" }, body: null },
      response: { status: 200, headers: { "paypal-debug-id": "safe-debug" }, body: { id: complete.id, status: "APPROVED", payment_source: { card: { authentication_result: authentication } } } },
    } } };
  }, savedBuyer, true, { cardApproval: { liabilityShift: "POSSIBLE", authentication_result: authentication, card: { number: "4111111111111111" }, token: "private-sdk-token" } });
  await page.ready();
  await page.openCard();
  assert.equal(page.cardCallbacks.onLookupComplete, undefined);
  await page.submitCard();
  const activity = page.element("activity").textContent;
  assert.match(activity, /CardFields.onApprove 3DS result/);
  assert.match(activity, /Backend Get Order 3DS result/);
  assert.match(activity, /"liabilityShift": "POSSIBLE"/);
  assert.match(activity, /"authentication_status": "Y"/);
  assert.match(activity, /"onLookupComplete": false/);
  for (const value of ["4111111111111111", "private-sdk-token", "legacy-access-token"]) assert.equal(activity.includes(value), false);
  assert.equal(page.element("get-trace-status").textContent, "HTTP 200");
  assert.equal(JSON.parse(page.element("get-request").textContent).headers.Authorization, "[REDACTED]");
  assert.equal(JSON.parse(page.element("get-response").textContent).body.payment_source.card.authentication_result.three_d_secure.authentication_status, "Y");
});

test("an uncertain capture allows method selection and card editing while guarding further payment submission", async () => {
  let captures = 0;
  const page = browser("new", (path) => {
    if (path.endsWith("/capture") && ++captures === 1) throw new Error("response lost");
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true } };
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.element("payment-methods").disabled, false);
  assert.equal(page.element("alternative-controls").inert, false);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "capture");
  await page.selectMethod("paypal");
  assert.equal(page.element("checkout-controls").hidden, false);
  assert.equal(page.element("checkout-controls").inert, true);
  await assert.rejects(page.callbacks.createOrder(), /already submitted/);
  await page.element("check-status").events.click();
  assert.equal(captures, 1);
  await page.element("resume-card").events.click();
  assert.equal(captures, 2);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("an approved uncaptured card restored after reload can be abandoned for PayPal", async () => {
  const requestId = crypto.randomUUID();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", order: { id: complete.id } };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true } };
  }, savedBuyer, true, { storage: [["editfi:new:card", requestId]] });
  await page.ready();
  assert.equal(page.element("payment-methods").disabled, false);
  assert.equal(page.element("alternative-controls").inert, false);
  await page.selectMethod("paypal");
  assert.equal(page.element("checkout-controls").inert, false);
  await page.callbacks.createOrder();
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(page.storage.has("editfi:new:card"), false);
});

test("a restored voided order enables save consent and starts a fresh card order", async () => {
  const oldKey = crypto.randomUUID();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", savePaymentMethod: true, order: { id: "VOIDED00001" } };
    if (path === "/api/orders/VOIDED00001") return { order: { id: "VOIDED00001", status: "VOIDED" } };
  }, savedBuyer, true, { storage: [["editfi:new:card", oldKey]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.element("save-card").disabled, false);
  assert.equal(page.element("card-submit").disabled, false);
  assert.match(page.element("status").textContent, /VOIDED/);
  page.element("save-card").checked = false;
  await page.submitCard();
  const input = page.requests.find((request) => request.path === "/api/orders").body;
  assert.notEqual(input.requestId, oldKey);
  assert.equal(input.savePaymentMethod, false);
  assert.match(page.element("status").textContent, /Card payment completed/);
});

for (const outcome of ["declined-capture", "INSTRUMENT_DECLINED", "TRANSACTION_REFUSED"]) {
  test(`${outcome} releases card checkout and permits a fresh consent choice`, async () => {
    const oldKey = crypto.randomUUID();
    const order = outcome === "declined-capture" ? { id: "FAILED00001", status: "COMPLETED", purchase_units: [{
      payments: { captures: [{ id: "DECLINED0001", status: "DECLINED" }] },
    }] } : { id: "FAILED00001", status: "APPROVED", cardAuthenticated: true };
    const traces = { capture: { attempted: true, request: captureTrace.request, response: {
      status: outcome === "declined-capture" ? 201 : 422,
      body: outcome === "declined-capture" ? order : { name: "UNPROCESSABLE_ENTITY", details: [{ issue: outcome }] },
    } } };
    const page = browser("new", (path) => {
      if (path.startsWith("/api/operations/")) return { flow: "card", savePaymentMethod: false, order: { id: order.id }, traces };
      if (path === `/api/orders/${order.id}`) return { order, traces };
    }, savedBuyer, true, { storage: [["editfi:new:card", oldKey]] });
    await page.ready();
    await page.openCard();
    assert.equal(page.element("save-card").disabled, false);
    assert.equal(page.element("card-submit").disabled, false);
    page.element("save-card").checked = true;
    await page.submitCard();
    const input = page.requests.find((request) => request.path === "/api/orders").body;
    assert.notEqual(input.requestId, oldKey);
    assert.equal(input.savePaymentMethod, true);
  });
}

test("a resolved SDK submit without approval checks the order and leaves uncaptured checkout editable", async () => {
  const page = browser("new", (path) => {
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
  }, savedBuyer, true, { cardNoApproval: true });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.requests.some((request) => request.path === `/api/orders/${complete.id}`), true);
  assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
  assert.equal(page.element("save-card").disabled, false);
  assert.equal(page.element("card-submit").disabled, false);
});

test("an already-captured API issue cannot be treated as a declined payment", async () => {
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", savePaymentMethod: false, order: { id: complete.id } };
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED" }, traces: {
      capture: { ...captureTrace, response: { status: 422, body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } } },
    } };
  }, savedBuyer, true, { storage: [["editfi:new:card", crypto.randomUUID()]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.element("save-card").disabled, false);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "check");
  await page.submitCard();
  assert.equal(page.requests.some((request) => request.path === "/api/orders"), false);
});

test("a confirmed decline during capture enables a fresh card submission without a reload", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return Response.json({ error: "PAYPAL_API_ERROR", message: "Card declined", details: {
      traces: {
        get: { request: { method: "GET", url: "/v2/checkout/orders/ORDER00001", headers: {}, authentication: { method: "Bearer" } },
          response: { status: 200, body: { id: complete.id, status: "APPROVED" } } },
        capture: { ...captureTrace, response: { status: 422, body: { details: [{ issue: "INSTRUMENT_DECLINED" }] } } },
      },
    } }, { status: 502 });
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.element("save-card").disabled, false);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.storage.has("editfi:new:card"), false);
});

for (const flow of ["new", "returning"]) {
  test(`${flow} checkout preserves a backend 3DS rejection across SDK error wrapping without claiming capture was sent`, async () => {
    const authentication = { liability_shift: "NO", three_d_secure: { enrollment_status: "Y", authentication_status: "N" } };
    const order = { id: complete.id, status: "APPROVED", cardAuthenticated: false,
      payment_source: { card: { authentication_result: authentication } } };
    const page = browser(flow, (path) => {
      if (path.endsWith("/capture")) return Response.json({ error: "CARD_AUTHENTICATION_REQUIRED",
        message: "Complete successful 3D Secure authentication before capturing this card order.", details: {
          order, captureRequested: false, debugId: "preflight-debug", traces: { get: {
            request: { method: "GET", headers: {}, authentication: { method: "Bearer" } },
            response: { status: 200, body: order }, attempted: true,
          } },
        } }, { status: 409 });
    }, savedBuyer, true, { wrapApprovalError: true });
    await page.ready();
    await page.openCard();
    await page.submitCard();
    assert.match(page.element("status").textContent, /Complete successful 3D Secure authentication/);
    assert.match(page.element("status").textContent, /preflight-debug/);
    assert.match(page.element("status").textContent, /No capture was sent/);
    assert.match(page.element("status").textContent, /3DS authentication status: N/);
    assert.doesNotMatch(page.element("status").textContent, /capture result is uncertain/);
    assert.equal(page.element("card-submit").disabled, false);
    assert.equal(page.element("resume-card").hidden, true);
    assert.equal(page.cardConfigurations.length, 1);
    assert.match(page.element("activity").textContent, /"authenticationStatus": "N"/);
  });
}

test("a lost capture response automatically restores its completed transaction without a second capture", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) throw new Error("capture response lost");
    if (path === `/api/orders/${complete.id}`) return { order: complete, captureRequested: true };
  }, savedBuyer, true, { wrapApprovalError: true });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.match(page.element("status").textContent, /Card payment completed/);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
  assert.equal(page.element("check-status").hidden, true);
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  assert.equal(page.requests.filter((request) => request.path === `/api/orders/${complete.id}`).length, 1);
  assert.equal(page.cardConfigurations.length, 1);
});

test("a failed capture preflight releases the payment guard when the backend confirms no capture dispatch", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return Response.json({ error: "PAYPAL_UNREACHABLE", message: "PayPal order lookup timed out.",
      details: { captureRequested: false, debugId: "lookup-debug" } }, { status: 502 });
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true }, captureRequested: false };
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.match(page.element("status").textContent, /PayPal order lookup timed out/);
  assert.match(page.element("status").textContent, /No capture was sent/);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("resume-card").hidden, false);
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

test("a backend-confirmed unsent capture stays retryable even if its subsequent status check fails", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return Response.json({ error: "PAYPAL_UNREACHABLE", message: "PayPal order lookup timed out.",
      details: { captureRequested: false } }, { status: 502 });
    if (path === `/api/orders/${complete.id}`) throw new Error("status unavailable");
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.match(page.element("status").textContent, /No capture was sent/);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("resume-card").hidden, true);
  await page.selectMethod("paypal");
  await page.callbacks.createOrder();
  assert.equal(page.requests.filter((request) => request.path === "/api/orders").length, 2);
});

test("an older capture response keeps its payment guard even without an attempted flag", async () => {
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) throw new Error("response lost");
    if (path === `/api/orders/${complete.id}`) return { captureRequested: false,
      order: { id: complete.id, status: "APPROVED", cardAuthenticated: true }, traces: { capture: {
        request: captureTrace.request, response: { status: 422, body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } },
      } } };
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "check");
  assert.equal(page.element("resume-card").hidden, true);
  assert.equal(page.element("check-status").hidden, false);
  assert.doesNotMatch(page.element("status").textContent, /No capture was sent/);
  await page.submitCard();
  assert.equal(page.requests.filter((request) => request.path === "/api/orders").length, 1);
});

test("a failed recovery preserves the original capture error and cannot be overwritten by a later SDK error", async () => {
  let checks = 0;
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return Response.json({ error: "PAYPAL_UNREACHABLE", message: "The capture request timed out.",
      details: { captureRequested: true, debugId: "capture-debug" } }, { status: 502 });
    if (path === `/api/orders/${complete.id}`) {
      checks++;
      if (checks === 1) throw new Error("lookup response lost");
      return { order: complete, captureRequested: true };
    }
  }, savedBuyer, true, { sdkErrorAfterApproval: new Error("zoid iframe closed with private-sdk-token") });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.match(page.element("status").textContent, /The capture request timed out/);
  assert.match(page.element("status").textContent, /capture-debug/);
  assert.match(page.element("status").textContent, /Payment status could not be checked/);
  assert.doesNotMatch(page.element("status").textContent, /capture result is uncertain/);
  assert.doesNotMatch(page.element("activity").textContent, /private-sdk-token/);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "check");
  assert.equal(page.element("check-status").hidden, false);
  assert.equal(page.cardConfigurations.length, 1);
  await page.submitCard();
  assert.match(page.element("status").textContent, /Card payment completed/);
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

test("an SDK error while the merchant capture is pending cannot rebuild fields or release submission controls", async () => {
  let release;
  const page = browser("new", (path) => {
    if (path.endsWith("/capture")) return new Promise((resolve) => { release = resolve; });
  });
  await page.ready();
  await page.openCard();
  const submitted = page.submitCard();
  await new Promise((resolve) => setImmediate(resolve));
  page.cardCallbacks.onError(new Error("zoid postMessage failed with private-sdk-token"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.cardConfigurations.length, 1);
  assert.equal(page.element("save-card").disabled, true);
  assert.equal(page.element("payment-methods").disabled, true);
  assert.equal(page.element("card-submit").disabled, true);
  assert.doesNotMatch(page.element("activity").textContent, /private-sdk-token/);
  release({ order: complete });
  await submitted;
  assert.match(page.element("status").textContent, /Card payment completed/);
});

for (const outcome of ["resolves", "rejects"]) {
  test(`submission stays locked when the SDK submit ${outcome} before the merchant capture settles`, async () => {
    let release;
    const page = browser("new", (path) => {
      if (path.endsWith("/capture")) return new Promise((resolve) => { release = resolve; });
    }, savedBuyer, true, { sdkDoesNotWaitApproval: true,
      sdkErrorAfterApproval: outcome === "rejects" ? new Error("SDK closed after handing off approval") : undefined });
    await page.ready();
    await page.openCard();
    const submitted = page.submitCard();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.element("card-submit").disabled, true);
    assert.equal(page.element("save-card").disabled, true);
    assert.equal(page.element("payment-methods").disabled, true);
    assert.equal(page.cardConfigurations.length, 1);
    release({ order: complete });
    await submitted;
    assert.match(page.element("status").textContent, /Card payment completed/);
    assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
  });
}

test("a completed capture stays successful when refreshing the saved method fails", async () => {
  let states = 0;
  const page = browser("new", (path) => {
    if (path === "/api/state" && ++states > 1) return Response.json({ error: "INTERNAL_ERROR", message: "Saved method lookup failed." }, { status: 500 });
  });
  await page.ready();
  await page.openCard();
  await page.submitCard();
  assert.match(page.element("status").textContent, /Card payment completed/);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
  assert.equal(page.element("check-status").hidden, true);
  assert.match(page.element("activity").textContent, /Saved method refresh failed/);
  assert.equal(page.requests.filter((request) => request.path.endsWith("/capture")).length, 1);
});

for (const flow of ["new", "returning"]) {
  test(`${flow} checkout loads card fields and replaces an unavailable unpaid order during recovery`, async () => {
    const oldKey = crypto.randomUUID();
    const storageKey = `editfi:${flow}:card`;
    let lookups = 0;
    const page = browser(flow, (path) => {
      if (path.startsWith("/api/operations/")) return { flow: "card", savePaymentMethod: false,
        order: { id: "MISSING0001", status: "PAYER_ACTION_REQUIRED" }, traces: { create: savedCreateTrace } };
      if (path === "/api/orders/MISSING0001") { lookups++; return missingOrderResponse("MISSING0001"); }
    }, savedBuyer, true, { storage: [[storageKey, oldKey]], search: "?card=return" });
    await page.ready();
    await page.openCard();
    assert.equal(page.scripts.length, 1);
    assert.equal(page.cardRenders.length, 4);
    assert.equal(page.element("card-submit").disabled, false);
    assert.equal(page.element("card-form").hidden, false);
    assert.equal(page.storage.has(storageKey), false);
    assert.equal(lookups, 1);
    assert.match(page.element("status").textContent, /previous unpaid checkout is no longer available/);
    assert.match(page.element("activity").textContent, /Unavailable unpaid checkout cleared/);
    assert.equal(page.element("get-trace-status").textContent, "HTTP 404");
    assert.equal(page.requests.some((request) => request.path === "/api/orders" || request.path.endsWith("/capture")), false);
    await page.submitCard();
    const created = page.requests.find((request) => request.path === "/api/orders");
    assert.notEqual(created.body.requestId, oldKey);
    assert.match(page.element("status").textContent, /Card payment completed/);
  });
}

test("a missing local unpaid order does not stop SDK initialization", async () => {
  const oldKey = crypto.randomUUID();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", order: { id: "MISSING0001", status: "CREATED" } };
    if (path === "/api/orders/MISSING0001") return Response.json({ error: "UNKNOWN_ORDER", message: "Unknown order" }, { status: 404 });
  }, savedBuyer, true, { storage: [["editfi:new:card", oldKey]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.cardRenders.length, 4);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.storage.has("editfi:new:card"), false);
});

test("a missing order with a possible capture keeps its payment guard while the SDK and fields load", async () => {
  const oldKey = crypto.randomUUID();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", order: { id: "MISSING0001", status: "APPROVED" },
      traces: { capture: { request: captureTrace.request, attempted: true, response: null } } };
    if (path === "/api/orders/MISSING0001") return missingOrderResponse("MISSING0001");
  }, savedBuyer, true, { storage: [["editfi:new:card", oldKey]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.cardRenders.length, 4);
  assert.equal(page.element("card-form").hidden, false);
  assert.equal(page.element("alternative-controls").inert, false);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "check");
  assert.equal(page.element("check-status").hidden, false);
  assert.equal(page.storage.get("editfi:new:card"), oldKey);
  assert.match(page.element("status").textContent, /previous checkout.*could not be checked/);
  assert.equal(page.requests.some((request) => request.path === "/api/orders" || request.path.endsWith("/capture")), false);
});

test("a saved capture marker keeps a missing order guarded when execution ended before its trace was saved", async () => {
  const oldKey = crypto.randomUUID();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", captureRequested: true,
      order: { id: "MISSING0001", status: "APPROVED" }, traces: { create: savedCreateTrace } };
    if (path === "/api/orders/MISSING0001") return missingOrderResponse("MISSING0001");
  }, savedBuyer, true, { storage: [["editfi:new:card", oldKey]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.cardRenders.length, 4);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit").dataset.action, "check");
  assert.equal(page.storage.get("editfi:new:card"), oldKey);
  assert.equal(page.requests.some((request) => request.path === "/api/orders"), false);
});

test("a transient recovery failure still initializes the SDK and preserves the existing operation", async () => {
  const oldKey = crypto.randomUUID();
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
    if (path === `/api/orders/${complete.id}`) return Response.json({ error: "PAYPAL_UNREACHABLE", message: "PayPal unavailable" }, { status: 502 });
  }, savedBuyer, true, { storage: [["editfi:new:card", oldKey]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.cardRenders.length, 4);
  assert.equal(page.element("card-form").hidden, false);
  assert.equal(page.storage.get("editfi:new:card"), oldKey);
  assert.equal(page.element("check-status").hidden, false);
});

test("an operation lookup failure can be checked again after the SDK loads", async () => {
  let attempts = 0;
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) {
      if (++attempts === 1) throw new Error("connection lost");
      return { flow: "card", order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
    }
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" } };
  }, savedBuyer, true, { storage: [["editfi:new:card", crypto.randomUUID()]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.cardRenders.length, 4);
  await page.element("check-status").events.click();
  assert.equal(attempts, 2);
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.requests.some((request) => request.path === "/api/orders" || request.path.endsWith("/capture")), false);
});

for (const flow of ["new", "returning"]) {
  test(`${flow} primary card button checks a previous unresolved payment and becomes Pay by card after an unpaid result`, async () => {
    let checks = 0;
    const key = crypto.randomUUID();
    const page = browser(flow, (path) => {
      if (path.startsWith("/api/operations/")) return { flow: "card", captureRequested: true, order: { id: complete.id } };
      if (path === `/api/orders/${complete.id}`) {
        if (++checks === 1) throw new Error("status response lost");
        return { order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, captureRequested: false };
      }
    }, savedBuyer, true, { storage: [[`editfi:${flow}:card`, key]] });
    await page.ready();
    await page.openCard();
    assert.equal(page.element("card-submit").disabled, false);
    assert.equal(page.element("card-submit-label").textContent, "Check previous payment");
    assert.equal(page.element("card-submit-amount").hidden, true);
    assert.match(page.element("card-action-hint").textContent, new RegExp(complete.id));
    await page.submitCard();
    assert.equal(checks, 2);
    assert.equal(page.element("card-submit").disabled, false);
    assert.equal(page.element("card-submit-label").textContent, "Pay by card");
    assert.equal(page.element("card-submit-amount").hidden, false);
    assert.equal(page.element("card-action-hint").hidden, true);
    assert.equal(page.cardSubmissions.length, 0);
    assert.equal(page.requests.every((request) => request.init.method === "GET" || request.path === "/api/client-token"), true);
    const entries = page.element("activity").textContent.split("\n\n").map((value) => JSON.parse(value));
    assert.ok(entries.some((entry) => entry.event === "Card checkout state" && entry.data.action === "check" && entry.data.unresolved));
    assert.ok(entries.some((entry) => entry.event === "Card checkout state" && entry.data.action === "pay" && entry.data.cardMounted));
  });

  test(`${flow} primary card button explicitly completes the existing approved order without submitting new card details`, async () => {
    const key = crypto.randomUUID();
    const page = browser(flow, (path) => {
      if (path.startsWith("/api/operations/")) return { flow: "card", captureRequested: true, order: { id: complete.id } };
      if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "APPROVED", cardAuthenticated: true }, captureRequested: true };
    }, savedBuyer, true, { storage: [[`editfi:${flow}:card`, key]] });
    await page.ready();
    await page.openCard();
    assert.equal(page.element("card-submit").disabled, false);
    assert.equal(page.element("card-submit-label").textContent, "Complete approved card payment");
    assert.match(page.element("card-action-hint").textContent, new RegExp(complete.id));
    assert.equal(page.requests.some((request) => request.path.endsWith("/capture")), false);
    await page.submitCard();
    assert.equal(page.cardSubmissions.length, 0);
    assert.equal(page.requests.some((request) => request.path === "/api/orders"), false);
    assert.equal(page.requests.filter((request) => request.path === `/api/orders/${complete.id}/capture`).length, 1);
    assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
    assert.equal(page.storage.get(`editfi:${flow}:card`), key);
  });
}

test("a primary status check without an order ID retries only the operation lookup", async () => {
  let attempts = 0;
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) {
      if (++attempts === 1) throw new Error("operation lookup failed");
      return { flow: "card", captureRequested: false, order: { id: complete.id } };
    }
    if (path === `/api/orders/${complete.id}`) return { order: { id: complete.id, status: "CREATED" }, captureRequested: false };
  }, savedBuyer, true, { storage: [["editfi:new:card", crypto.randomUUID()]] });
  await page.ready();
  await page.openCard();
  assert.equal(page.element("card-submit-label").textContent, "Check previous payment");
  await page.submitCard();
  assert.equal(attempts, 2);
  assert.equal(page.element("card-submit-label").textContent, "Pay by card");
  assert.equal(page.requests.every((request) => request.init.method === "GET"), true);
});

test("the primary card status action never reissues a direct saved-PayPal charge", async () => {
  const page = browser("returning", (path) => {
    if (path === "/api/direct-charge") throw new Error("direct charge response lost");
    if (path.startsWith("/api/operations/")) return { flow: "direct", order: complete };
  });
  await page.ready();
  await page.element("place-order").events.click();
  await page.openCard();
  assert.equal(page.element("card-submit-label").textContent, "Check previous payment");
  await page.submitCard();
  assert.equal(page.requests.filter((request) => request.path === "/api/direct-charge").length, 1);
  assert.equal(page.requests.some((request) => request.path === "/api/orders" || request.path.endsWith("/capture")), false);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
});

test("a loading card button explains the wait and enables payment after all hosted fields finish rendering", async () => {
  let release;
  const cardRenderWait = new Promise((resolve) => { release = resolve; });
  const page = browser("new", undefined, savedBuyer, true, { cardRenderWait });
  await page.ready();
  const opening = page.openCard();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.cardRenders.length, 4);
  assert.equal(page.element("card-submit").disabled, true);
  assert.equal(page.element("card-submit-label").textContent, "Loading card fields…");
  assert.match(page.element("card-action-hint").textContent, /Waiting for secure card fields/);
  release();
  await opening;
  assert.equal(page.element("card-submit").disabled, false);
  assert.equal(page.element("card-submit-label").textContent, "Pay by card");
  assert.equal(page.element("card-action-hint").hidden, true);
});

for (const kind of ["card", "direct"]) {
  test(`a completed ${kind} checkout is restored from durable history without requesting a missing PayPal order`, async () => {
    const flow = kind === "card" ? "new" : "returning";
    const key = kind === "card" ? "editfi:new:card" : "editfi:returning:revision-1:direct";
    const page = browser(flow, (path) => {
      if (path.startsWith("/api/operations/")) return { flow: kind, order: complete, traces: { capture: captureTrace } };
      if (path === `/api/orders/${complete.id}`) return missingOrderResponse(complete.id);
    }, savedBuyer, true, { storage: [[key, crypto.randomUUID()]] });
    await page.ready();
    assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
    assert.match(page.element("status").textContent, /completed/);
    assert.equal(page.requests.some((request) => request.path.startsWith("/api/orders") || request.path === "/api/direct-charge"), false);
  });
}

test("a completed capture trace recovers a payment even when its summary was not saved", async () => {
  const page = browser("new", (path) => {
    if (path.startsWith("/api/operations/")) return { flow: "card", order: { id: complete.id, status: "PAYER_ACTION_REQUIRED" }, traces: { capture: captureTrace } };
  }, savedBuyer, true, { storage: [["editfi:new:card", crypto.randomUUID()]] });
  await page.ready();
  assert.match(page.element("status").textContent, /Card payment completed/);
  assert.equal(page.element("payment-capture-id").textContent, "CAPTURE00001");
  assert.equal(page.requests.some((request) => request.path.startsWith("/api/orders")), false);
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
  assert.equal(first.element("card-submit").disabled, false);
  assert.equal(first.element("card-submit").dataset.action, "check");
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
