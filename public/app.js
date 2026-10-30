const $ = (id) => document.getElementById(id);
const flow = document.body.dataset.flow;
let settings, buyer, mounted = false, busy = false, paid = false, unresolved = false, lastOrderId, approvedOrderId, submittingPayment = false;
let cardFields, cardMounted = false, cardRendering, cardSubmitting = false, cardOrderId, approvedCardOrderId, cardCapturePromise, activeMethod = "paypal";
let savePayPalChoice = false, saveCardChoice = false, savedCardAuthenticationUrl;
let selectedMethod, renderNewPayPalButton, renderCardFields;
let cardStage = "idle", cardCancelled = false;
let cardSession, cardFieldElements = [];
let cardCaptureAttempted = false;
let cardNeedsNewOrder = false;
let recoveryNotice, recoveryAttempted = false;
let checkingLastOrder = false, diagnosticOrderId, lastCardControlState;
const activity = [];
const backendErrors = new WeakSet();
const context = () => flow === "new" ? "new" : `returning:${buyer?.revision}`;
const storageKey = (kind) => `editfi:${kind === "card" ? flow : context()}:${kind}`;
const lastOrderStorageKey = `editfi:last-order:${flow}`;
const validOrderId = (value) => typeof value === "string" && /^[A-Z0-9]{8,32}$/i.test(value);
const placeOrderPrompt = 'Payment method approved. Click "Place order with saved method" to complete the purchase.';
const savedCard = () => buyer?.methodType === "card";
const savedPayPal = () => flow === "returning" && buyer?.state === "VAULTED" && !savedCard();
const cardLabel = (value) => `${value?.brand || "Card"} •••• ${value?.lastDigits || ""}`.trim();

function log(event, data) {
  activity.unshift({ time: new Date().toLocaleTimeString(), event, ...(data ? { data } : {}) });
  $("activity").textContent = activity.slice(0, 30).map((entry) => JSON.stringify(entry, null, 2)).join("\n\n");
}

function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = `status ${type}`;
}

function resetApiTraces() {
  for (const kind of ["create", "confirm", "get", "capture"]) {
    $(`${kind}-trace`).open = false;
    $(`${kind}-trace-status`).textContent = "Not requested";
    $(`${kind}-request`).textContent = "No request recorded yet.";
    $(`${kind}-response`).textContent = "No response recorded yet.";
  }
}

function showApiTraces(traces) {
  for (const kind of ["create", "confirm", "get", "capture"]) {
    const trace = traces[kind];
    if (!trace) continue;
    $(`${kind}-trace`).open = true;
    $(`${kind}-trace-status`).textContent = trace.response ? `HTTP ${trace.response.status}` : trace.attempted ? "No response" : "Not sent";
    const request = { ...trace.request, headers: { ...trace.request.headers }, authentication: { ...trace.request.authentication } };
    // Also mask legacy trace values; the page never retains an access token.
    if ("token" in request.authentication) request.authentication.token = "[REDACTED]";
    for (const name of Object.keys(request.headers)) {
      if (name.toLowerCase() === "authorization") request.headers[name] = "[REDACTED]";
    }
    $(`${kind}-request`).textContent = JSON.stringify(request, null, 2);
    $(`${kind}-response`).textContent = JSON.stringify(trace.response || { error: trace.error || "No response received." }, null, 2);
    if (kind === "get" && trace.response?.body?.payment_source?.card) {
      log("Backend Get Order 3DS result", {
        source: "backend", orderID: trace.response.body.id, status: trace.response.body.status,
        authentication_result: cardAuthenticationResult(trace.response.body.payment_source.card.authentication_result),
        debugId: trace.response.headers?.["paypal-debug-id"],
      });
    }
  }
  if (traces.create?.request?.body?.payment_source?.paypal?.vault_id && !traces.capture) {
    $("capture-trace-status").textContent = "No separate call";
    $("capture-request").textContent = "Direct saved-method payments use Create order. No separate capture request was sent.";
    $("capture-response").textContent = "See the Create order response for this payment's result.";
  }
}

function cardButtonState() {
  if (paid) return { action: "paid", disabled: true, label: "Payment completed", hint: "" };
  if (busy || submittingPayment || cardSubmitting) return { action: "processing", disabled: true,
    label: "Processing payment…", hint: "Please wait for the current payment to finish." };
  if (unresolved) return { action: "blocked", disabled: true, label: "Pay by card",
    hint: flow === "new" ? "Reload this page to start a new test payment." : "The result of this payment attempt is unresolved." };
  if (!cardMounted) return { action: "loading", disabled: true, label: "Loading card fields…",
    hint: "Waiting for secure card fields to finish loading." };
  return { action: "pay", disabled: false, label: "Pay by card", hint: "" };
}

function controls() {
  const processing = busy || submittingPayment || cardSubmitting;
  const locked = processing || paid || unresolved;
  if (flow === "new") {
    $("payment-methods").disabled = processing || paid;
    $("payment-methods").hidden = paid;
  }
  const container = $("checkout-controls");
  container.inert = locked;
  if ($("place-order")) $("place-order").disabled = locked || !mounted;
  // Keep card fields editable even while a payment result needs checking.
  // Only payment submission is blocked when a capture result is uncertain.
  $("alternative-controls").inert = paid;
  if ($("other-paypal-option")) $("other-paypal-option").inert = locked;
  const cardButton = cardButtonState();
  $("card-submit").disabled = cardButton.disabled;
  $("card-submit").dataset.action = cardButton.action;
  $("card-submit-label").textContent = cardButton.label;
  $("card-submit-amount").hidden = cardButton.action !== "pay";
  $("card-action-hint").textContent = cardButton.hint;
  $("card-action-hint").hidden = !cardButton.hint;
  const cardControl = { action: cardButton.action, disabled: cardButton.disabled,
    busy, submittingPayment, cardSubmitting, cardMounted, unresolved, paid,
    orderID: lastOrderId || null, stage: cardSession?.stage || "idle" };
  const signature = JSON.stringify(cardControl);
  if (lastCardControlState !== signature) {
    lastCardControlState = signature;
    log("Card checkout state", cardControl);
  }
  $("resume-card").hidden = paid || !approvedCardOrderId;
  $("resume-card").disabled = busy || submittingPayment || cardSubmitting;
  if ($("authenticate-saved-card")) {
    $("authenticate-saved-card").hidden = paid || !savedCardAuthenticationUrl;
    $("authenticate-saved-card").disabled = busy || submittingPayment;
  }
  for (const id of ["save-paypal", "save-card"]) if ($(id)) $(id).disabled = processing || paid;
  lastOrderControls();
  $("success-actions").hidden = !paid;
  if (paid) {
    container.hidden = true;
    $("alternative-controls").hidden = true;
  }
}

function showError(error) {
  busy = false;
  const extra = error.details?.debugId ? ` (PayPal debug ID: ${error.details.debugId})` : "";
  status(`${error.message}${extra}`, "error");
  const details = error.details ? { ...error.details } : undefined;
  if (details) delete details.traces; // Request details have their own panels.
  log("Error", { code: error.code, message: error.message, details });
  controls();
}

async function api(path, body, { showTraces = true } = {}) {
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
  if (showTraces && result.traces) showApiTraces(result.traces);
  if (showTraces && result.details?.traces) showApiTraces(result.details.traces);
  if (!response.ok) {
    const error = new Error(result.message || `Request failed (${response.status}).`);
    Object.assign(error, { code: result.error, details: result.details, httpStatus: response.status });
    backendErrors.add(error);
    throw error;
  }
  return result;
}

function requestId(kind) {
  // Browser storage holds request UUIDs and a separate diagnostic order ID.
  // The vault ID, REST secret and access/client tokens are never saved here.
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
  $("saved-method-type").textContent = value ? value.methodType === "card" ? "Credit / debit card" : "PayPal" : "—";
  $("buyer-detail-label").textContent = value?.methodType === "card" ? "Saved card" : "Buyer";
  $("buyer-email").textContent = value?.methodType === "card" ? cardLabel(value.card) : value?.payerEmail || "—";
  $("saved-at").textContent = value?.savedAt ? new Date(value.savedAt).toLocaleString() : "—";
}

function showPaymentDetails(order) {
  if (validOrderId(order?.id)) {
    diagnosticOrderId = order.id;
    sessionStorage.setItem(lastOrderStorageKey, diagnosticOrderId);
    lastOrderControls();
  }
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
  if (activeMethod.includes("card") && failedCardPayment(order, result.traces)) return restoreCard(result);
  lastOrderId = order.id;
  showPaymentDetails(order);
  log("Orders v2 response", order);
  paid = order.completed === true;
  unresolved = !paid;
  busy = false;
  let current;
  try {
    current = await api("/api/state");
    showBuyer(current.buyer);
  } catch (error) {
    // Refreshing the shared saved method cannot change a confirmed payment.
    log("Saved method refresh failed", { code: error.code, message: error.message });
  }
  if (paid) {
    const saving = flow === "new" && (activeMethod === "card" ? saveCardChoice : savePayPalChoice);
    status(`${activeMethod.includes("card") ? "Card payment" : "Payment"} completed. Order ${order.id}.${saving && current && current.buyer?.state !== "VAULTED" ? " Vaulting is pending; refresh the saved method before using it." : ""}`, "success");
  } else {
    status(`Order ${order.id}: ${order.status}. Payment is not confirmed. Check its status before starting another purchase.`);
  }
  controls();
}

function hasCapture(order) {
  return order.purchase_units?.some((unit) => unit.payments?.captures?.length);
}

function noCardCapture(result) {
  return result?.captureRequested === false && !hasCapture(result.order || {}) &&
    !result.traces?.capture?.attempted && !result.traces?.capture?.response;
}

function failedCardPayment(order, traces) {
  const captures = [order, traces?.capture?.response?.body].flatMap((value) =>
    (value?.purchase_units || []).flatMap((unit) => unit.payments?.captures || []));
  if (captures.some((capture) => ["COMPLETED", "PENDING"].includes(capture.status))) return false;
  if (order.status === "VOIDED" || (captures.length > 0 && captures.every((capture) => ["DECLINED", "FAILED"].includes(capture.status)))) return true;
  const response = traces?.capture?.response;
  return ["CREATED", "APPROVED", "PAYER_ACTION_REQUIRED"].includes(order.status) && [400, 422].includes(response?.status) &&
    Array.isArray(response.body?.details) && response.body.details.some((detail) => ["INSTRUMENT_DECLINED", "TRANSACTION_REFUSED"].includes(detail.issue));
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
  if (flow === "new" && selectedMethod !== "paypal") throw new Error("Select PayPal to start this payment.");
  if (paid || unresolved || submittingPayment) throw new Error("This checkout already submitted a payment. Start a new purchase after checking its result.");
  if (flow === "returning" && approvedOrderId) {
    // A further edit gets a fresh order. The previous approved order remains
    // uncaptured; it must never be reused for the buyer's new selection.
    sessionStorage.removeItem(storageKey("component"));
    approvedOrderId = undefined;
  }
  busy = true;
  clearDiagnosticOrder();
  activeMethod = "paypal";
  cardCaptureAttempted = false;
  sessionStorage.removeItem(storageKey("card"));
  cardOrderId = approvedCardOrderId = undefined;
  lastOrderId = undefined;
  showPaymentDetails(null);
  resetApiTraces();
  controls();
  status("Creating the PayPal order…");
  try {
    savePayPalChoice = flow === "new" && $("save-paypal").checked;
    const result = await api("/api/orders", {
      flow: flow === "new" ? "new" : savedPayPal() ? "returning" : "paypal",
      ...(flow === "new" ? { savePaymentMethod: savePayPalChoice } : savedPayPal() ? {} : { page: "returning" }),
      requestId: requestId("component"),
      ...(savedPayPal() ? { vaultRevision: buyer.revision } : {}),
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
  if (cardSubmitting || activeMethod !== "paypal") return;
  if (flow === "new" && selectedMethod !== "paypal") return;
  if (savedPayPal()) {
    if (paid || unresolved || submittingPayment) return;
    awaitPlacement({ id: data.orderID });
    return;
  }
  return captureOrder(data.orderID);
}

async function captureOrder(orderID) {
  const cardPayment = activeMethod.includes("card");
  if (cardPayment) {
    cardCaptureAttempted = true;
    approvedCardOrderId = undefined;
    savedCardAuthenticationUrl = undefined;
  }
  busy = true;
  submittingPayment = true;
  controls();
  status("Capturing the approved PayPal order…");
  lastOrderId = orderID;
  showPaymentDetails({ id: orderID });
  try {
    await finish(await api(`/api/orders/${encodeURIComponent(orderID)}/capture`, {}));
  } catch (error) {
    if (cardPayment) {
      // Handle merchant API failures here instead of rejecting the SDK's
      // onApprove callback. SDK wrappers otherwise replace the original error
      // and can incorrectly report a failed preflight as an unknown capture.
      await recoverCardCapture(orderID, error);
      if (error.code === "BUYER_CHANGED") {
        approvedCardOrderId = savedCardAuthenticationUrl = undefined;
        $("checkout-controls").hidden = true;
      }
      return;
    }
    // An interrupted capture might still have settled at PayPal. Block another
    // purchase and offer status recovery instead of creating a second charge.
    unresolved = !paid && error.code !== "BUYER_CHANGED";
    showError(error);
    if (error.code === "BUYER_CHANGED") $("checkout-controls").hidden = true;
    throw error;
  } finally {
    submittingPayment = false;
    controls();
  }
}

async function recoverCardCapture(orderID, error) {
  showError(error); // Keep the original backend code, details, and debug ID.
  busy = true;
  controls();
  status("Checking the card payment result with PayPal…");
  const extra = error.details?.debugId ? ` (PayPal debug ID: ${error.details.debugId})` : "";
  try {
    // Authentication rejections and definitive declines already include the
    // verified order. Other failures get one read-only check, never a capture.
    const verified = error.details?.order || error.details?.traces?.get?.response?.body;
    const knownResult = verified && ((error.code === "CARD_AUTHENTICATION_REQUIRED" && error.details.captureRequested === false) ||
      failedCardPayment(verified, error.details.traces));
    const result = knownResult ?
      { order: verified, traces: error.details.traces, captureRequested: error.details.captureRequested } :
      await api(`/api/orders/${encodeURIComponent(orderID)}`);
    await restoreCard(result);
    log("Card capture status recovery", { orderID, errorCode: error.code,
      status: result.order.status, completed: result.order.completed === true,
      captureRequested: result.captureRequested });
    if (!paid) {
      const authentication = result.order.payment_source?.card?.authentication_result?.three_d_secure?.authentication_status;
      const secure = /^[YNURACDI]$/.test(authentication || "") ? `3DS authentication status: ${authentication}. ` : "";
      status(`${error.message}${extra} ${noCardCapture(result) ? "No capture was sent. " : ""}${secure}${$("status").textContent}`, "error");
    }
  } catch (lookupError) {
    // A failed read does not prove the payment failed. Keep the same order/key
    // and guard against another payment until its status can be confirmed.
    const noCapture = noCardCapture(error.details);
    unresolved = !paid && !noCapture;
    if (noCapture) cardCaptureAttempted = false;
    busy = false;
    log("Card capture status check failed", { orderID, code: lookupError.code,
      message: lookupError.message, debugId: lookupError.details?.debugId });
    status(`${error.message}${extra} Payment status could not be checked. ${noCapture ?
      "No capture was sent. You can retry checkout or choose another payment method." :
      (flow === "new" ? "Reload this page to start a new test payment." : "Use Check last order status to log the available details.")}`, "error");
    controls();
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
    const components = savedPayPal() ?
      "buttons,funding-eligibility,messages,saved-payment-methods,card-fields" : "buttons,card-fields";
    const parameters = new URLSearchParams({
      "client-id": settings.clientId, components, vault: "true", commit: savedPayPal() ? "false" : "true",
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

function completedCheckoutHistory(previous) {
  if (previous.order?.completed === true) return previous.order;
  for (const kind of ["capture", "create"]) {
    const response = previous.traces?.[kind]?.response;
    const order = response?.body;
    if (response?.status >= 200 && response.status < 300 && order?.id && order.status === "COMPLETED" &&
        (!previous.order?.id || order.id === previous.order.id) &&
        order.purchase_units?.some((unit) => unit.payments?.captures?.some((capture) => capture.status === "COMPLETED"))) {
      return { ...order, completed: true };
    }
  }
  return null;
}

function missingRecoveryOrder(error) {
  if (error.code === "UNKNOWN_ORDER" && error.httpStatus === 404) return true;
  const lookup = error.details?.traces?.get;
  return error.code === "PAYPAL_API_ERROR" && error.details?.httpStatus === 404 &&
    lookup?.request?.method === "GET" && lookup.response?.status === 404 &&
    (error.details.name === "RESOURCE_NOT_FOUND" || error.details.issues?.some((issue) =>
      ["INVALID_RESOURCE_ID", "RESOURCE_NOT_FOUND"].includes(issue.issue)));
}

function recoveryMayHavePayment(kind, previous) {
  if (kind === "direct" || previous?.flow === "direct") return true;
  if (completedCheckoutHistory(previous || {})) return true;
  if (previous?.order && failedCardPayment(previous.order, previous.traces)) return false;
  return previous?.captureRequested === true || previous?.order?.status === "COMPLETED" || hasCapture(previous?.order || {}) ||
    previous?.traces?.capture?.attempted === true;
}

async function recoverAttempt() {
  recoveryAttempted = true;
  for (const kind of ["saved-card", "card", "direct", "component"]) {
    const key = sessionStorage.getItem(storageKey(kind));
    if (!key) continue;
    let previous;
    try {
      previous = await api(`/api/operations/${encodeURIComponent(key)}`);
      if (kind === "component" && flow === "new" && typeof previous.savePaymentMethod === "boolean") {
        savePayPalChoice = $("save-paypal").checked = previous.savePaymentMethod;
      }
      if (kind === "card" && flow === "new" && typeof previous.savePaymentMethod === "boolean") {
        saveCardChoice = $("save-card").checked = previous.savePaymentMethod;
      }
      const completed = completedCheckoutHistory(previous);
      if (completed) {
        activeMethod = ["card", "saved-card"].includes(kind) ? kind : "paypal";
        await finish({ order: completed, traces: previous.traces || {} });
        return true;
      }
      if (!previous.order?.id) continue;
      if (["card", "saved-card"].includes(kind)) cardCaptureAttempted ||= previous.captureRequested === true;
      if (flow === "new") await selectPaymentMethod(kind === "card" ? "card" : "paypal");
      const result = await api(`/api/orders/${encodeURIComponent(previous.order.id)}`);
      if (["card", "saved-card"].includes(kind)) {
        await restoreCard(result, kind);
        return true;
      }
      if (result.order.completed || kind === "direct" || hasCapture(result.order)) {
        await finish(result);
        return true;
      }
      if (savedPayPal() && result.order.status === "APPROVED") {
        awaitPlacement(result.order);
        return false;
      }
    } catch (error) {
      const orderID = previous?.order?.id;
      if (previous && missingRecoveryOrder(error) && !recoveryMayHavePayment(kind, previous)) {
        sessionStorage.removeItem(storageKey(kind));
        if (!lastOrderId || lastOrderId === orderID) {
          if (cardSession?.orderID === orderID) resetInterruptedCard(cardSession, false);
          lastOrderId = cardOrderId = approvedOrderId = approvedCardOrderId = savedCardAuthenticationUrl = undefined;
          unresolved = cardCaptureAttempted = false;
          busy = false;
          showPaymentDetails(null);
        }
        recoveryNotice = { message: "The previous unpaid checkout is no longer available. You can start a new purchase.", type: "" };
        log("Unavailable unpaid checkout cleared", { kind, orderID, code: error.code,
          httpStatus: error.details?.httpStatus || error.httpStatus, debugId: error.details?.debugId });
        continue;
      }
      // Recovery failures must not stop SDK initialization. Keep possible
      // charges guarded, but still render the payment methods and card fields.
      activeMethod = ["card", "saved-card"].includes(kind) ? kind : "paypal";
      lastOrderId = orderID;
      if (activeMethod.includes("card")) cardOrderId = orderID;
      unresolved = !paid;
      busy = submittingPayment = cardSubmitting = false;
      showPaymentDetails(previous?.order);
      showError(error);
      recoveryNotice = { message: `The previous checkout${orderID ? ` (${orderID})` : ""} could not be checked. Payment methods are loaded; use Check last order status to log the available details.`, type: "error" };
      return true;
    }
  }
  return false;
}

async function start() {
  const query = new URLSearchParams(location.search);
  const savedOrder = sessionStorage.getItem(lastOrderStorageKey);
  if (validOrderId(savedOrder)) diagnosticOrderId = savedOrder;
  const paymentReturn = query.get("card") === "return" || query.get("saved-card") === "return" ||
    (query.get("paypal") === "return" && validOrderId(query.get("token")));
  if (flow === "new" && !paymentReturn) {
    // Each ordinary visit/reload is a fresh test checkout. Retain only the
    // separate last-order ID for the optional diagnostic GET, never its lock.
    for (const kind of ["saved-card", "card", "direct", "component"]) sessionStorage.removeItem(storageKey(kind));
    $("save-paypal").checked = $("save-card").checked = false;
  }
  lastOrderControls();
  if (flow === "new") await selectPaymentMethod(undefined);
  configureWalletPlaceholder();
  const [configuration, cached] = await Promise.all([api("/api/config"), api("/api/state")]);
  settings = configuration;
  buyer = cached.buyer;
  showBuyer(buyer);
  document.querySelectorAll("[data-amount]").forEach((element) => {
    element.textContent = new Intl.NumberFormat("en-US", { style: "currency", currency: settings.currency }).format(settings.amount);
  });
  log("Configuration loaded", { environment: settings.environment, amount: settings.amount, currency: settings.currency });
  if (query.get("card") === "return" || query.get("saved-card") === "return") {
    history.replaceState(null, "", location.pathname);
    // Restore only an order belonging to this browser's card attempt. Redirects
    // and reloads check status; they never submit a fresh payment or capture.
    await recoverAttempt();
    if (paid) return;
  }
  if (query.get("paypal") === "cancel") onCancel();
  if (query.get("paypal") === "return" && validOrderId(query.get("token"))) {
    history.replaceState(null, "", location.pathname);
    if (flow === "new") {
      await selectPaymentMethod("paypal");
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
  }
  if (flow === "returning" && !recoveryAttempted && !approvedOrderId && !cardOrderId) await recoverAttempt();
  if (paid) return;
  let token;
  if (savedPayPal()) {
    try {
      token = await api("/api/client-token", { vaultRevision: buyer.revision });
      log("Vault-scoped SDK client token issued", { expiresIn: token.expiresIn });
    } catch (error) {
      showError(error);
    }
  }
  const paypal = await loadSDK(token?.clientToken);
  initializeCardFields(paypal);
  const callbacks = { createOrder, onApprove, onCancel, onError: showError };
  if (flow === "new") {
    let rendering;
    renderNewPayPalButton = () => rendering ||= Promise.resolve().then(() =>
      paypal.Buttons({ ...callbacks, fundingSource: paypal.FUNDING.PAYPAL, style: { layout: "vertical", shape: "rect", label: "paypal", height: 48 } }).render("#paypal-button-container"));
    if (selectedMethod === "paypal") await renderNewPayPalButton();
  } else if (token) {
    if (typeof paypal.SavedPaymentMethods !== "function") {
      throw new Error("This sandbox SDK did not expose SavedPaymentMethods. Confirm that saved-payment-methods / ViewEditFI is enabled for this PayPal REST app and environment.");
    }
    $("checkout-controls").hidden = false;
    // The guide passes no vaultId to this constructor. Scope comes exclusively
    // from the SDK script's data-sdk-client-token attribute above.
    await paypal.SavedPaymentMethods(callbacks).render("#saved-payment-methods-container");
  } else {
    $("other-paypal-option").hidden = false;
    await paypal.Buttons({ ...callbacks, fundingSource: paypal.FUNDING.PAYPAL, style: { layout: "vertical", shape: "rect", label: "paypal", height: 48 } }).render("#other-paypal-buttons");
    if (savedCard() && buyer.state === "VAULTED") {
      $("checkout-controls").hidden = false;
      $("saved-card-method").hidden = false;
      $("saved-payment-methods-container").hidden = true;
      $("saved-card-description").textContent = cardLabel(buyer.card);
      $("saved-card-expiry").textContent = buyer.card?.expiry ? `Expires ${buyer.card.expiry}` : "";
      $("saved-method-note").textContent = "Use your saved card. This purchase requests SCA_ALWAYS authentication.";
      $("saved-method-capture-note").textContent = "Complete 3D Secure authentication before the payment is captured.";
      $("place-order").textContent = "Place order with saved card";
    }
  }
  mounted = flow === "new" || Boolean(token) || (savedCard() && buyer.state === "VAULTED");
  controls();
  if (recoveryNotice) status(recoveryNotice.message, recoveryNotice.type);
  else if (!unresolved && !cardOrderId) status(approvedOrderId ? placeOrderPrompt : flow === "new" ? "Ready. Select a payment method to continue." : mounted ? "Ready. Review or edit the saved method, or choose a card payment." : "No saved PayPal method is ready. You can pay by card below.");
  if (mounted) log(flow === "new" ? "Payment method choices ready" : "SavedPaymentMethods rendered");
}

async function selectPaymentMethod(method) {
  if (flow !== "new") return;
  selectedMethod = method;
  for (const value of ["paypal", "card", "wallet"]) $(`method-${value}`).checked = value === method;
  $("checkout-controls").hidden = method !== "paypal";
  $("alternative-controls").hidden = !["card", "wallet"].includes(method);
  $("card-option").hidden = method !== "card";
  $("wallet-panel").hidden = method !== "wallet";
  if (method === "paypal") await renderNewPayPalButton?.();
  if (method === "card") await renderCardFields?.();
}

if (flow === "new") {
  for (const method of ["paypal", "card", "wallet"]) {
    $(`method-${method}`).addEventListener("change", async () => {
      if (busy || paid || submittingPayment || cardSubmitting) {
        // Restore the selected radio if a late event arrives during payment.
        for (const value of ["paypal", "card", "wallet"]) $(`method-${value}`).checked = value === selectedMethod;
        return;
      }
      if ($(`method-${method}`).checked) await selectPaymentMethod(method).catch(showError);
    });
  }
}

function configureWalletPlaceholder() {
  const agent = navigator.userAgent || "";
  const appleDevice = /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform || ""} ${agent}`);
  const wallet = typeof window.ApplePaySession !== "undefined" || appleDevice ? "Apple Pay" : "Google Pay";
  $("wallet-label").textContent = wallet;
  if (flow === "new") $("wallet-choice-label").textContent = wallet;
  $("wallet-option").disabled = true;
  $("wallet-note").textContent = `${wallet} is a display-only option. No wallet payment will be started.`;
}

function cardAuthenticationResult(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  if (["POSSIBLE", "NO", "UNKNOWN"].includes(value.liability_shift)) result.liability_shift = value.liability_shift;
  const secure = value.three_d_secure;
  if (secure && typeof secure === "object") {
    result.three_d_secure = {};
    if (/^[YNURACDI]$/.test(secure.authentication_status || "")) result.three_d_secure.authentication_status = secure.authentication_status;
    if (/^[YNU]$/.test(secure.enrollment_status || "")) result.three_d_secure.enrollment_status = secure.enrollment_status;
  }
  return Object.keys(result).length ? result : null;
}

function frontendCardResult(data) {
  return {
    liabilityShift: ["POSSIBLE", "NO", "UNKNOWN"].includes(data?.liabilityShift) ? data.liabilityShift : null,
    authentication_result: cardAuthenticationResult(data?.authentication_result || data?.payment_source?.card?.authentication_result),
    ...(typeof data?.liabilityShifted === "boolean" ? { liabilityShifted: data.liabilityShifted } : {}),
    ...(typeof data?.liabilityShiftPossible === "boolean" ? { liabilityShiftPossible: data.liabilityShiftPossible } : {}),
  };
}

function cardSdkDiagnostic(error) {
  // SDK messages may contain serialized API errors, URLs, card values, or
  // credentials. Extract identifiers only; never log the raw message/object.
  const nodes = [];
  const messages = [];
  for (const candidate of [error, error?.data, error?.cause]) {
    if (!candidate) continue;
    if (typeof candidate === "object") nodes.push(candidate);
    const message = typeof candidate === "string" ? candidate : candidate.message;
    if (typeof message !== "string") continue;
    messages.push(message.slice(0, 20000));
    const start = message.indexOf("{"), end = message.lastIndexOf("}");
    if (start < 0 || end < start || end - start > 20000) continue;
    try { nodes.push(JSON.parse(message.slice(start, end + 1))); } catch {}
  }
  const code = (value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(value) ? value : undefined;
  const diagnostic = {};
  const issues = new Set();
  for (const node of nodes) {
    if (["POSSIBLE", "NO", "UNKNOWN"].includes(node?.liabilityShift)) diagnostic.liabilityShift ||= node.liabilityShift;
    diagnostic.authentication_result ||= cardAuthenticationResult(node?.authentication_result || node?.payment_source?.card?.authentication_result);
    diagnostic.sdkCode ||= code(node?.code);
    diagnostic.sdkName ||= code(node?.name);
    const debugId = node?.debug_id || node?.debugId;
    if (typeof debugId === "string" && /^[a-f0-9]{13,32}$/i.test(debugId)) diagnostic.debugId ||= debugId;
    for (const detail of Array.isArray(node?.details) ? node.details.slice(0, 10) : []) {
      const issue = code(detail?.issue);
      if (issue) issues.add(issue);
    }
  }
  if (issues.size) diagnostic.issues = [...issues];
  const text = messages.join(" ");
  diagnostic.category = /cancel|closed|dismiss/i.test(text) ? "CHALLENGE_CLOSED" :
    /iframe|frame|post.?robot|zoid|window|origin/i.test(text) ? "IFRAME_COMMUNICATION" :
    /network|fetch|timeout|timed.out|connection/i.test(text) ? "NETWORK_OR_TIMEOUT" :
    /authentica|3.?d.?secure|3ds|contingen/i.test(text) ? "AUTHENTICATION_FAILED" :
    /instrument|declin/i.test(text) ? "INSTRUMENT_DECLINED" :
    /invalid|validation|field/i.test(text) ? "VALIDATION_FAILED" : "SDK_ERROR";
  return diagnostic;
}

function resetInterruptedCard(session, captureUncertain) {
  if (session !== cardSession) return;
  session.interrupted = true;
  cardSession = undefined; // Old SDK callbacks and submit promises lose ownership.
  busy = submittingPayment = cardSubmitting = false;
  unresolved = captureUncertain;
  approvedCardOrderId = undefined;
  cardMounted = false;
  cardRendering = renderCardFields = undefined;
  const fields = cardFieldElements;
  cardFieldElements = [];
  // Rebuild disabled/aborted SDK iframes. Individual fields expose close();
  // CardFields itself does not expose a public destroy/reset method in v5.
  // A broken SDK promise must not keep the merchant checkout waiting.
  for (const field of fields) Promise.resolve().then(() => field.close()).catch(() => {});
  for (const id of ["card-name-field", "card-number-field", "card-expiry-field", "card-cvv-field"]) $(id).replaceChildren();
  initializeCardFields(window.paypal);
  controls();
}

function cardError(error, callback = "sdk-onError", session = cardSession) {
  if (paid) return;
  // Once approval hands off to the backend, captureOrder owns the result and
  // recovery. Late iframe errors must not reset fields or replace that result.
  const ignored = !session || session !== cardSession || session.interrupted || session.approvalHandled === true;
  const safe = error && typeof error === "object" && backendErrors.has(error) ? error : new Error(
    session?.orderID ? "Card submission was interrupted. You can edit the card or choose another method. Use Check last order status to log the 3DS result." :
      "Card payment could not be submitted. Review the card fields, then retry.",
  );
  if (safe !== error) {
    safe.code = "CARD_SDK_ERROR";
    safe.details = { orderID: session?.orderID, stage: session?.stage || cardStage, callback, ...cardSdkDiagnostic(error) };
  }
  log("CardFields error 3DS result", { source: "frontend", callback, orderID: session?.orderID, ignored, ...cardSdkDiagnostic(error) });
  if (ignored || cardCancelled) return;
  showError(safe);
  resetInterruptedCard(session, false);
}

function onCardCancel(session) {
  const ignored = paid || session !== cardSession || session.interrupted || session.stage === "capture";
  log("CardFields.onCancel 3DS result", { source: "frontend", orderID: session.orderID, result: "CANCELLED_OR_CLOSED", ignored });
  if (ignored) return;
  cardCancelled = true;
  status("3D Secure verification was cancelled or closed. You can edit the card or choose another payment method.", "error");
  resetInterruptedCard(session, false);
}

async function createCardOrder(session) {
  if (session !== cardSession || session.interrupted || !cardSubmitting || paid || unresolved) throw new Error("Submit the card form to start this payment.");
  cardStage = session.stage = "create-order";
  const result = await api("/api/orders", { flow: "card", page: flow, requestId: requestId("card"), ...(flow === "new" ? { savePaymentMethod: saveCardChoice } : {}) });
  session.orderID = result.order.id;
  if (session !== cardSession || session.interrupted) throw new Error("This card attempt was interrupted.");
  cardOrderId = lastOrderId = session.orderID;
  showPaymentDetails(result.order);
  log("Card order created", { orderID: cardOrderId });
  cardStage = session.stage = "authentication";
  return cardOrderId;
}

function initializeCardFields(paypal) {
  try {
    if (typeof paypal.CardFields !== "function") throw new Error("Card Fields is not available in this SDK.");
    const session = cardSession = { stage: "idle", interrupted: false };
    cardCancelled = false;
    cardFields = paypal.CardFields({
      createOrder: () => createCardOrder(session),
      onApprove(data) {
        // Approval belongs to the current order/session, not to the lifetime
        // of submit()'s promise. The SDK can deliver onApprove after it settles.
        const ignoreReasons = [
          paid && "PAYMENT_ALREADY_COMPLETED",
          session !== cardSession && "STALE_COMPONENT",
          session.interrupted && "INTERRUPTED",
          unresolved && "PAYMENT_RESULT_UNRESOLVED",
          cardCancelled && "CANCELLED",
          activeMethod !== "card" && "OTHER_ACTIVE_METHOD",
          flow === "new" && selectedMethod !== "card" && "OTHER_SELECTED_METHOD",
          (!session.orderID || data.orderID !== session.orderID || cardOrderId !== session.orderID) && "ORDER_MISMATCH",
          session.approvalHandled === true && "APPROVAL_ALREADY_HANDLED",
        ].filter(Boolean);
        const ignored = ignoreReasons.length > 0;
        log("CardFields.onApprove 3DS result", { source: "frontend", orderID: session.orderID, ignored, ignoreReasons,
          backendCaptureRequest: ignored ? "NOT_REQUESTED" : "REQUESTED", ...frontendCardResult(data) });
        if (ignored) return;
        if (!cardCapturePromise) {
          session.approvalHandled = true;
          cardStage = session.stage = "capture";
          approvedCardOrderId = data.orderID;
          cardCapturePromise = captureOrder(data.orderID).finally(() => { cardCapturePromise = undefined; });
        }
        return cardCapturePromise;
      },
      onError: (error) => cardError(error, "sdk-onError", session),
      onCancel: () => onCardCancel(session),
      style: { input: { "font-family": "Arial, sans-serif", "font-size": "16px", "line-height": "24px",
        color: "#152544", padding: "6px 0", border: "0", "border-radius": "0" }, ".invalid": { color: "#a64237" } },
    });
    if (!cardFields.isEligible()) throw new Error("This Sandbox REST app is not eligible for Card Fields.");
    log("CardFields v5 3DS callback availability", { onApprove: true, onError: true, onCancel: true,
      onLookupComplete: false, note: "onLookupComplete belongs to Braintree 3DS and is not exposed by PayPal CardFields v5." });
    $("card-status").textContent = "Pay securely with a sandbox credit or debit card.";
    $("card-form").hidden = false;
    const render = () => {
      if ((flow === "new" ? selectedMethod !== "card" : !$("card-option").open) || cardRendering) return cardRendering;
      const fields = [cardFields.NameField({ ariaLabel: "Cardholder name" }), cardFields.NumberField({ ariaLabel: "Card number" }),
        cardFields.ExpiryField({ ariaLabel: "Expiry date" }), cardFields.CVVField({ ariaLabel: "Security code" })];
      cardFieldElements = fields;
      cardRendering = Promise.resolve().then(() => Promise.all(fields.map((field, index) =>
        field.render(["#card-name-field", "#card-number-field", "#card-expiry-field", "#card-cvv-field"][index]))))
        .then(() => { if (session === cardSession) { cardMounted = true; controls(); } }).catch(() => {
        if (session !== cardSession) return;
        $("card-status").textContent = "Secure card fields could not load. Reload this page to retry.";
        $("card-form").hidden = true;
      });
      return cardRendering;
    };
    renderCardFields = render;
    if (flow !== "new") $("card-option").addEventListener("toggle", render);
    render();
  } catch {
    $("card-status").textContent = "Credit and debit card checkout is unavailable. Enable Advanced Credit and Debit Card Payments for this PayPal Sandbox business account and app, then reload.";
    $("card-form").hidden = true;
  }
}

async function restoreCard(result, method = activeMethod.includes("card") ? activeMethod : "card") {
  activeMethod = method;
  cardOrderId = lastOrderId = result.order.id;
  const failed = failedCardPayment(result.order, result.traces);
  if (result.order.completed || (hasCapture(result.order) && !failed)) return finish(result);
  busy = false;
  showPaymentDetails(result.order);
  const authentication = result.order.payment_source?.card?.authentication_result;
  const threeDS = authentication?.three_d_secure;
  log("Card authentication status from PayPal", {
    orderID: result.order.id,
    status: result.order.status,
    authenticated: result.order.cardAuthenticated === true,
    ...(["POSSIBLE", "NO", "UNKNOWN"].includes(authentication?.liability_shift) ? { liabilityShift: authentication.liability_shift } : {}),
    ...(/^[YNURABCID]$/.test(threeDS?.authentication_status || "") ? { authenticationStatus: threeDS.authentication_status } : {}),
    ...(/^[YNU]$/.test(threeDS?.enrollment_status || "") ? { enrollmentStatus: threeDS.enrollment_status } : {}),
  });
  const alreadyCaptured = result.traces?.capture?.response?.body?.details?.some((detail) => detail.issue === "ORDER_ALREADY_CAPTURED");
  approvedCardOrderId = !alreadyCaptured && result.order.status === "APPROVED" && result.order.cardAuthenticated === true ? result.order.id : undefined;
  savedCardAuthenticationUrl = method === "saved-card" ? result.order.payerActionUrl : undefined;
  // A confirmed unapproved order can be retried with the SAME create key. A
  // previous capture attempt always keeps the checkout locked for recovery.
  const captureAttempted = result.captureRequested === true || result.traces?.capture?.attempted || result.traces?.capture?.response ||
    (result.captureRequested !== false && cardCaptureAttempted);
  cardCaptureAttempted = Boolean(captureAttempted);
  const retryable = failed || (!captureAttempted && (method === "card" ? ["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"].includes(result.order.status) :
    ["CREATED", "PAYER_ACTION_REQUIRED"].includes(result.order.status)));
  cardNeedsNewOrder = retryable && !["CREATED", "PAYER_ACTION_REQUIRED"].includes(result.order.status);
  if (failed) {
    cardCaptureAttempted = false;
    approvedCardOrderId = savedCardAuthenticationUrl = undefined;
    sessionStorage.removeItem(storageKey(method === "saved-card" ? "saved-card" : "card"));
  }
  unresolved = !failed && (Boolean(savedCardAuthenticationUrl) || !retryable);
  status(approvedCardOrderId ? "Card payment approved. Click Complete approved card payment to capture this order." : savedCardAuthenticationUrl ? "Complete card authentication before capturing this payment." :
    failed ? `Order ${result.order.id} (${result.order.status}) did not complete payment. You can pay again or choose another method.` :
    retryable ? "Card payment is not approved. Review the card details and retry checkout." :
      `Order ${result.order.id} (${result.order.status}): the capture result is not confirmed. Use Check last order status to log the available details.`);
  controls();
}

$("card-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (flow === "new" && selectedMethod !== "card") return;
  const action = cardButtonState();
  if (action.disabled) return;
  const session = cardSession;
  const fields = cardFields;
  if (!session) return;
  cardStage = session.stage = "validation";
  session.approvalHandled = false;
  session.orderID = undefined;
  cardCancelled = false;
  busy = submittingPayment = cardSubmitting = true;
  controls();
  try {
    const state = await fields.getState();
    if (session !== cardSession || session.interrupted) return;
    if (!state.isFormValid) {
      status("Check the card number, expiry date, and security code.", "error");
      return;
    }
    activeMethod = "card";
    clearDiagnosticOrder();
    cardCaptureAttempted = false;
    const saving = flow === "new" && $("save-card").checked;
    if (approvedCardOrderId || cardNeedsNewOrder || saving !== saveCardChoice) sessionStorage.removeItem(storageKey("card"));
    cardNeedsNewOrder = false;
    saveCardChoice = saving;
    approvedOrderId = approvedCardOrderId = cardOrderId = lastOrderId = undefined;
    sessionStorage.removeItem(storageKey("component"));
    sessionStorage.removeItem(storageKey("direct"));
    showPaymentDetails(null);
    resetApiTraces();
    status("Submitting the card payment to PayPal Sandbox…");
    // Hosted card details go directly to PayPal through the SDK. The Worker
    // receives only checkout metadata, consent, and the idempotency request ID.
    cardStage = session.stage = "submit";
    const result = await fields.submit();
    const ignored = session !== cardSession || session.interrupted;
    log("CardFields.submit 3DS result", { source: "frontend", orderID: session.orderID, ignored, ...frontendCardResult(result) });
    if (ignored) return;
    if (!paid && !unresolved && cardOrderId && !session.approvalHandled) {
      // A resolved submit without onApprove is not proof of capture. Read the
      // order rather than freezing checkout on an assumed unknown payment.
      const orderID = cardOrderId;
      try {
        const result = await api(`/api/orders/${encodeURIComponent(orderID)}`);
        // A late approval may have started/completed capture during this read.
        // That handler owns the payment result; an earlier GET cannot replace it.
        if (session === cardSession && !session.interrupted && !session.approvalHandled && !paid && cardOrderId === orderID) {
          await restoreCard(result, "card");
        }
      } catch (error) {
        // Failure of a merchant lookup is not an SDK/3DS failure. Preserve the
        // instance so a valid approval delivered afterward can still capture.
        if (session === cardSession && !session.interrupted && !session.approvalHandled && !paid) showError(error);
      }
    }
  } catch (error) { if (!paid) cardError(error, "submit-rejected", session); }
  finally {
    if (session === cardSession) {
      // The SDK submit promise can settle before the merchant's onApprove
      // promise. Submission stays locked until capture/recovery also settles.
      if (session.approvalHandled && cardCapturePromise) await cardCapturePromise;
      busy = submittingPayment = cardSubmitting = false;
      controls();
    }
  }
});

$("resume-card").addEventListener("click", async () => {
  if (!approvedCardOrderId || busy || paid || submittingPayment || cardSubmitting) return;
  await captureOrder(approvedCardOrderId).catch(() => {});
  controls();
});

async function payWithSavedCard() {
  busy = submittingPayment = true;
  clearDiagnosticOrder();
  activeMethod = "saved-card";
  cardCaptureAttempted = false;
  cardOrderId = lastOrderId = approvedCardOrderId = savedCardAuthenticationUrl = undefined;
  for (const kind of ["card", "component", "direct"]) sessionStorage.removeItem(storageKey(kind));
  resetApiTraces();
  showPaymentDetails(null);
  status("Preparing your saved card for 3D Secure authentication…");
  controls();
  try {
    const result = await api("/api/orders", { flow: "saved-card", requestId: requestId("saved-card"), vaultRevision: buyer.revision });
    await restoreCard(result, "saved-card");
    if (savedCardAuthenticationUrl) {
      // The backend validates this PayPal HATEOAS URL and supplies our return
      // URI. No card capture is made before successful issuer authentication.
      location.assign(savedCardAuthenticationUrl);
    } else if (approvedCardOrderId) {
      await captureOrder(approvedCardOrderId);
    }
  } catch (error) {
    unresolved = !paid;
    showError(error);
  } finally {
    busy = submittingPayment = false;
    controls();
  }
}

$("authenticate-saved-card")?.addEventListener("click", () => {
  if (savedCardAuthenticationUrl && !paid && !busy && !submittingPayment) location.assign(savedCardAuthenticationUrl);
});

for (const [id, kind] of [["save-paypal", "component"], ["save-card", "card"]]) {
  $(id)?.addEventListener("change", () => {
    if (busy || paid || unresolved || submittingPayment || cardSubmitting) return;
    // Changing consent starts a different unsubmitted attempt. Retries of the
    // original operation always retain their original vault instruction.
    sessionStorage.removeItem(storageKey(kind));
  });
}

$("place-order")?.addEventListener("click", async () => {
  if (busy || paid || unresolved || submittingPayment || !mounted) return;
  if (savedCard()) {
    await payWithSavedCard();
    return;
  }
  if (approvedOrderId) {
    // Approval chooses the instrument; only this explicit merchant-page action
    // captures that exact order. Never create a second direct-charge order.
    await captureOrder(approvedOrderId).catch(() => {});
    return;
  }
  busy = true;
  clearDiagnosticOrder();
  activeMethod = "paypal";
  sessionStorage.removeItem(storageKey("card"));
  cardOrderId = approvedCardOrderId = undefined;
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
    controls();
  }
});

function clearDiagnosticOrder() {
  diagnosticOrderId = undefined;
  sessionStorage.removeItem(lastOrderStorageKey);
  lastOrderControls();
}

function lastOrderControls() {
  const button = $("check-last-order");
  button.disabled = checkingLastOrder || !diagnosticOrderId;
  button.textContent = checkingLastOrder ? "Checking last order…" : "Check last order status";
  button.title = diagnosticOrderId ? `Order ${diagnosticOrderId}` : "No order ID is available from a payment attempt.";
}

async function checkLastOrderStatus() {
  if (checkingLastOrder || !diagnosticOrderId) return;
  const orderID = diagnosticOrderId;
  checkingLastOrder = true;
  lastOrderControls();
  try {
    // This is a diagnostic GET only. Its result never restores a checkout,
    // changes payment controls, submits card fields, or starts a payment.
    const result = await api(`/api/orders/${encodeURIComponent(orderID)}`, undefined, { showTraces: false });
    const data = { orderID, response: result.traces?.get?.response || { status: 200, body: result.order } };
    log("Get last order details response", data);
    console.info("Get last order details response", data);
  } catch (error) {
    const data = { orderID, code: error.code, message: error.message, debugId: error.details?.debugId,
      response: error.details?.traces?.get?.response || null };
    log("Get last order details error", data);
    console.error("Get last order details error", data);
  }
  finally {
    checkingLastOrder = false;
    lastOrderControls();
  }
}

$("check-last-order").addEventListener("click", checkLastOrderStatus);

$("refresh-vault").addEventListener("click", async () => {
  if (busy || unresolved) return;
  try {
    await api("/api/refresh-vault", {});
    location.reload();
  } catch (error) { showError(error); }
});

$("another-checkout").addEventListener("click", () => {
  for (const kind of ["saved-card", "card", "direct", "component"]) sessionStorage.removeItem(storageKey(kind));
  location.href = location.pathname;
});

start().catch(showError);
