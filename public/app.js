const $ = (id) => document.getElementById(id);
const flow = document.body.dataset.flow;
let settings, buyer, mounted = false, busy = false, paid = false, unresolved = false, lastOrderId, approvedOrderId, submittingPayment = false;
const activity = [];
const displayedAuthorizations = new Map();
const context = () => flow === "new" ? "new" : `returning:${buyer?.revision}`;
const storageKey = (kind) => `editfi:${context()}:${kind}`;
const placeOrderPrompt = 'Payment method approved. Click "Place order with saved method" to complete the purchase.';

function log(event, data) {
  activity.unshift({ time: new Date().toLocaleTimeString(), event, ...(data ? { data } : {}) });
  $("activity").textContent = activity.slice(0, 12).map((entry) => JSON.stringify(entry, null, 2)).join("\n\n");
}

function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = `status ${type}`;
}

function resetApiTraces() {
  displayedAuthorizations.clear();
  for (const kind of ["create", "capture"]) {
    $(`${kind}-trace`).open = false;
    $(`${kind}-trace-status`).textContent = "Not requested";
    $(`${kind}-request`).textContent = "No request recorded yet.";
    $(`${kind}-response`).textContent = "No response recorded yet.";
  }
}

function showApiTraces(traces) {
  for (const kind of ["create", "capture"]) {
    const trace = traces[kind];
    if (!trace) continue;
    $(`${kind}-trace`).open = true;
    $(`${kind}-trace-status`).textContent = trace.response ? `HTTP ${trace.response.status}` : trace.attempted ? "No response" : "Not sent";
    const request = { ...trace.request, headers: { ...trace.request.headers }, authentication: { ...trace.request.authentication } };
    const key = `${request.url}:${request.headers["PayPal-Request-Id"]}`;
    const token = request.authentication.token;
    if (typeof token === "string" && token !== "[REDACTED]") displayedAuthorizations.set(key, token);
    const usedToken = displayedAuthorizations.get(key);
    if (usedToken) {
      request.authentication.token = usedToken;
      request.headers.Authorization = `Bearer ${usedToken}`;
    } else if (request.authentication.token === "[REDACTED]") {
      request.authentication.token = "Not retained. Send a new request to display its token.";
    }
    $(`${kind}-request`).textContent = JSON.stringify(request, null, 2);
    $(`${kind}-response`).textContent = JSON.stringify(trace.response || { error: trace.error || "No response received." }, null, 2);
  }
  if (traces.create?.request?.body?.payment_source?.paypal?.vault_id && !traces.capture) {
    $("capture-trace-status").textContent = "No separate call";
    $("capture-request").textContent = "Direct saved-method payments use Create order. No separate capture request was sent.";
    $("capture-response").textContent = "See the Create order response for this payment's result.";
  }
}

function controls() {
  const locked = busy || paid || unresolved;
  const container = $("checkout-controls");
  container.inert = locked;
  if ($("place-order")) $("place-order").disabled = locked || !mounted;
  $("check-status").hidden = !unresolved;
  $("success-actions").hidden = !paid;
  if (paid) container.hidden = true;
}

function showError(error) {
  busy = false;
  const extra = error.details?.debugId ? ` (PayPal debug ID: ${error.details.debugId})` : "";
  status(`${error.message}${extra}`, "error");
  const details = error.details ? { ...error.details } : undefined;
  if (details) delete details.traces; // Tokens belong only in the request panel.
  log("Error", { code: error.code, message: error.message, details });
  controls();
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-EditFI-Request": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("The request did not finish. Retry this checkout; its payment idempotency key is preserved.");
  }
  const result = await response.json().catch(() => ({}));
  if (result.traces) showApiTraces(result.traces);
  if (result.details?.traces) showApiTraces(result.details.traces);
  if (!response.ok) {
    const error = new Error(result.message || `Request failed (${response.status}).`);
    Object.assign(error, { code: result.error, details: result.details });
    throw error;
  }
  return result;
}

function requestId(kind) {
  // Only request identifiers are stored in the browser. The vault ID, REST
  // secret, access tokens and scoped client token are never saved here.
  let value = sessionStorage.getItem(storageKey(kind));
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(storageKey(kind), value);
  }
  return value;
}

function showBuyer(value) {
  $("vault-state").textContent = value?.state === "VAULTED" ? "Payment method saved" : value ? "Vaulting pending" : "No saved buyer";
  $("vault-state").className = `state-chip ${value?.state === "VAULTED" ? "ready" : ""}`;
  $("vault-message").textContent = value?.state === "VAULTED" ? "Ready for returning-customer checkout." : value ? "Payment completed; PayPal has not returned a vaulted token yet. Refresh or wait for the vault webhook." : "Complete a new-customer purchase to save a buyer.";
  $("vault-id").textContent = value?.vaultId || "—";
  $("customer-id").textContent = value?.customerId || "—";
  $("buyer-email").textContent = value?.payerEmail || "—";
  $("saved-at").textContent = value?.savedAt ? new Date(value.savedAt).toLocaleString() : "—";
}

function showPaymentDetails(order) {
  if (flow !== "returning") return;
  $("payment-details").hidden = !order?.id;
  $("payment-order-id").textContent = order?.id || "—";
  const captureIds = (order?.purchase_units || []).flatMap((unit) =>
    (unit.payments?.captures || []).filter((capture) => capture.status === "COMPLETED" && capture.id).map((capture) => capture.id),
  );
  $("payment-capture-details").hidden = captureIds.length === 0;
  $("payment-capture-label").textContent = captureIds.length > 1 ? "Transaction IDs (capture IDs)" : "Transaction ID (capture ID)";
  $("payment-capture-id").textContent = captureIds.join(", ") || "—";
}

async function finish(result) {
  const order = result.order;
  if (!order?.id) throw new Error("The server did not return an order ID.");
  lastOrderId = order.id;
  showPaymentDetails(order);
  log("Orders v2 response", order);
  paid = order.completed === true;
  unresolved = !paid;
  busy = false;
  const current = await api("/api/state");
  showBuyer(current.buyer);
  if (paid) {
    status(`Payment completed. Order ${order.id}.${flow === "new" && current.buyer?.state !== "VAULTED" ? " Vaulting is pending; refresh the saved buyer before using the returning flow." : ""}`, "success");
  } else {
    status(`Order ${order.id}: ${order.status}. Payment is not confirmed. Check its status before starting another purchase.`);
  }
  controls();
}

function hasCapture(order) {
  return order.purchase_units?.some((unit) => unit.payments?.captures?.length);
}

function awaitPlacement(order) {
  approvedOrderId = order.id;
  lastOrderId = order.id;
  busy = false;
  unresolved = false;
  showPaymentDetails(order);
  status(placeOrderPrompt);
  log("Order approved; awaiting Place order", { orderID: order.id });
  controls();
}

async function createOrder() {
  if (paid || unresolved || submittingPayment) throw new Error("This checkout already submitted a payment. Start a new purchase after checking its result.");
  if (flow === "returning" && approvedOrderId) {
    // A further edit gets a fresh order. The previous approved order remains
    // uncaptured; it must never be reused for the buyer's new selection.
    sessionStorage.removeItem(storageKey("component"));
    approvedOrderId = undefined;
  }
  busy = true;
  lastOrderId = undefined;
  showPaymentDetails(null);
  resetApiTraces();
  controls();
  status("Creating the PayPal order…");
  try {
    const result = await api("/api/orders", {
      flow,
      requestId: requestId("component"),
      ...(flow === "returning" ? { vaultRevision: buyer.revision } : {}),
    });
    lastOrderId = result.order.id;
    showPaymentDetails(result.order);
    if (flow === "returning") status("Order created. Complete approval in PayPal.");
    log("Order created", result.order);
    return result.order.id;
  } catch (error) {
    showError(error);
    throw error;
  }
}

async function onApprove(data) {
  if (flow === "returning") {
    if (paid || unresolved || submittingPayment) return;
    awaitPlacement({ id: data.orderID });
    return;
  }
  return captureOrder(data.orderID);
}

async function captureOrder(orderID) {
  busy = true;
  submittingPayment = true;
  controls();
  status("Capturing the approved PayPal order…");
  lastOrderId = orderID;
  showPaymentDetails({ id: orderID });
  try {
    await finish(await api(`/api/orders/${encodeURIComponent(orderID)}/capture`, {}));
  } catch (error) {
    // An interrupted capture might still have settled at PayPal. Block another
    // purchase and offer status recovery instead of creating a second charge.
    unresolved = !paid && error.code !== "BUYER_CHANGED";
    showError(error);
    if (error.code === "BUYER_CHANGED") $("checkout-controls").hidden = true;
    throw error;
  } finally {
    submittingPayment = false;
  }
}

function onCancel() {
  if (paid || unresolved || submittingPayment) return;
  busy = false;
  approvedOrderId = undefined;
  lastOrderId = undefined;
  sessionStorage.removeItem(storageKey("component"));
  status(flow === "returning" ? "Payment method change cancelled. You can place the order with the saved method." : "PayPal checkout was cancelled. The saved buyer has not changed.");
  log("PayPal checkout cancelled");
  controls();
}

function loadSDK(clientToken) {
  return new Promise((resolve, reject) => {
    const components = flow === "new" ? "buttons" : "buttons,funding-eligibility,messages,saved-payment-methods";
    const parameters = new URLSearchParams({
      "client-id": settings.clientId, components, vault: "true", commit: flow === "returning" ? "false" : "true",
      intent: "capture", currency: settings.currency,
    });
    const script = document.createElement("script");
    script.src = `${settings.sdkBase}/sdk/js?${parameters}`;
    if (clientToken) script.setAttribute("data-sdk-client-token", clientToken);
    script.async = true;
    script.onload = () => resolve(window.paypal);
    script.onerror = () => reject(new Error("PayPal JS SDK could not load. Check the sandbox client ID, browser network panel and component availability for this REST app."));
    document.head.appendChild(script);
    log("Loading PayPal JS SDK v5", { components, environment: settings.environment, vaultScoped: Boolean(clientToken) });
  });
}

async function recoverAttempt() {
  for (const kind of ["direct", "component"]) {
    const key = sessionStorage.getItem(storageKey(kind));
    if (!key) continue;
    const previous = await api(`/api/operations/${encodeURIComponent(key)}`);
    if (!previous.order?.id) continue;
    const result = await api(`/api/orders/${encodeURIComponent(previous.order.id)}`);
    if (result.order.completed || kind === "direct" || hasCapture(result.order)) {
      await finish(result);
      return true;
    }
    if (flow === "returning" && result.order.status === "APPROVED") {
      awaitPlacement(result.order);
      return false;
    }
  }
  return false;
}

async function start() {
  const [configuration, cached] = await Promise.all([api("/api/config"), api("/api/state")]);
  settings = configuration;
  buyer = cached.buyer;
  showBuyer(buyer);
  document.querySelectorAll("[data-amount]").forEach((element) => {
    element.textContent = new Intl.NumberFormat("en-US", { style: "currency", currency: settings.currency }).format(settings.amount);
  });
  log("Configuration loaded", { environment: settings.environment, amount: settings.amount, currency: settings.currency });
  const query = new URLSearchParams(location.search);
  if (query.get("paypal") === "cancel") onCancel();
  if (query.get("paypal") === "return" && query.get("token")) {
    history.replaceState(null, "", location.pathname);
    if (flow === "new") {
      await onApprove({ orderID: query.get("token") });
      return;
    }
    // A mobile/redirect approval must also wait for the merchant's Place order
    // button. Verify and restore the existing order without making a payment.
    const result = await api(`/api/orders/${encodeURIComponent(query.get("token"))}`);
    if (result.order.completed || hasCapture(result.order)) {
      await finish(result);
      return;
    }
    if (result.order.status === "APPROVED") awaitPlacement(result.order);
  }
  if (flow === "returning" && buyer?.state !== "VAULTED") {
    $("empty-state").hidden = false;
    if (buyer) {
      $("empty-state").querySelector("h3").textContent = "The saved payment method is pending";
      $("empty-state").querySelector("p").textContent = "Refresh the saved buyer once PayPal finishes vaulting. The previous buyer will not be used.";
    }
    status(buyer ? "Waiting for a vaulted token from PayPal." : "Create a saved buyer in Flow 01 to continue.");
    return;
  }
  if (!approvedOrderId && await recoverAttempt()) return;
  let token;
  if (flow === "returning") {
    token = await api("/api/client-token", { vaultRevision: buyer.revision });
    log("Vault-scoped SDK client token issued", { expiresIn: token.expiresIn });
  }
  const paypal = await loadSDK(token?.clientToken);
  const callbacks = { createOrder, onApprove, onCancel, onError: showError };
  if (flow === "new") {
    await paypal.Buttons({ ...callbacks, fundingSource: paypal.FUNDING.PAYPAL, style: { layout: "vertical", shape: "rect", label: "paypal", height: 48 } }).render("#paypal-button-container");
  } else {
    if (typeof paypal.SavedPaymentMethods !== "function") {
      throw new Error("This sandbox SDK did not expose SavedPaymentMethods. Confirm that saved-payment-methods / ViewEditFI is enabled for this PayPal REST app and environment.");
    }
    $("checkout-controls").hidden = false;
    // The guide passes no vaultId to this constructor. Scope comes exclusively
    // from the SDK script's data-sdk-client-token attribute above.
    await paypal.SavedPaymentMethods(callbacks).render("#saved-payment-methods-container");
  }
  mounted = true;
  controls();
  status(approvedOrderId ? placeOrderPrompt : flow === "new" ? "Ready. Use a sandbox buyer account to pay and save." : "Ready. Review or edit the saved method, or place the order below.");
  log(flow === "new" ? "PayPal Buttons rendered" : "SavedPaymentMethods rendered");
}

$("place-order")?.addEventListener("click", async () => {
  if (busy || paid || unresolved || submittingPayment || !mounted) return;
  if (approvedOrderId) {
    // Approval chooses the instrument; only this explicit merchant-page action
    // captures that exact order. Never create a second direct-charge order.
    await captureOrder(approvedOrderId).catch(() => {});
    return;
  }
  busy = true;
  submittingPayment = true;
  lastOrderId = undefined;
  showPaymentDetails(null);
  resetApiTraces();
  controls();
  status("Charging the saved payment method…");
  try {
    // Create Order with a vault_id can auto-capture. Never also call /capture.
    await finish(await api("/api/direct-charge", { requestId: requestId("direct"), vaultRevision: buyer.revision }));
  } catch (error) {
    unresolved = !paid && !["BUYER_CHANGED", "NO_VAULTED_BUYER"].includes(error.code);
    showError(error);
    if (!unresolved) $("checkout-controls").hidden = true;
  } finally {
    submittingPayment = false;
  }
});

$("check-status").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    if (lastOrderId) {
      const result = await api(`/api/orders/${encodeURIComponent(lastOrderId)}`);
      if (approvedOrderId === lastOrderId && result.order.status === "APPROVED" && !hasCapture(result.order)) {
        awaitPlacement(result.order);
      } else {
        await finish(result);
      }
    } else {
      // Recover a direct-charge response lost before the order ID arrived.
      // Reuse the exact existing key; never create a fresh payment attempt.
      const key = sessionStorage.getItem(storageKey("direct"));
      if (!key) throw new Error("No submitted payment was found. Reload to continue.");
      await finish(await api("/api/direct-charge", { requestId: key, vaultRevision: buyer.revision }));
    }
  }
  catch (error) { showError(error); }
});

$("refresh-vault").addEventListener("click", async () => {
  if (busy || unresolved) return;
  try {
    await api("/api/refresh-vault", {});
    location.reload();
  } catch (error) { showError(error); }
});

$("another-checkout").addEventListener("click", () => {
  for (const kind of ["direct", "component"]) sessionStorage.removeItem(storageKey(kind));
  location.href = location.pathname;
});

start().catch(showError);
