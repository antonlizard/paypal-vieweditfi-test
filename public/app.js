const $ = (id) => document.getElementById(id);
const flow = document.body.dataset.flow;
let settings, buyer, mounted = false, busy = false, paid = false, unresolved = false, lastOrderId, approvedOrderId, submittingPayment = false;
let cardFields, cardMounted = false, cardRendering, cardSubmitting = false, cardOrderId, approvedCardOrderId, cardCapturePromise, activeMethod = "paypal";
let savePayPalChoice = false, saveCardChoice = false, savedCardAuthenticationUrl;
let selectedMethod, renderNewPayPalButton, renderCardFields;
const activity = [];
const context = () => flow === "new" ? "new" : `returning:${buyer?.revision}`;
const storageKey = (kind) => `editfi:${kind === "card" ? flow : context()}:${kind}`;
const placeOrderPrompt = 'Payment method approved. Click "Place order with saved method" to complete the purchase.';
const savedCard = () => buyer?.methodType === "card";
const savedPayPal = () => flow === "returning" && buyer?.state === "VAULTED" && !savedCard();
const cardLabel = (value) => `${value?.brand || "Card"} •••• ${value?.lastDigits || ""}`.trim();

function log(event, data) {
  activity.unshift({ time: new Date().toLocaleTimeString(), event, ...(data ? { data } : {}) });
  $("activity").textContent = activity.slice(0, 12).map((entry) => JSON.stringify(entry, null, 2)).join("\n\n");
}

function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = `status ${type}`;
}

function resetApiTraces() {
  for (const kind of ["create", "confirm", "capture"]) {
    $(`${kind}-trace`).open = false;
    $(`${kind}-trace-status`).textContent = "Not requested";
    $(`${kind}-request`).textContent = "No request recorded yet.";
    $(`${kind}-response`).textContent = "No response recorded yet.";
  }
}

function showApiTraces(traces) {
  for (const kind of ["create", "confirm", "capture"]) {
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
  }
  if (traces.create?.request?.body?.payment_source?.paypal?.vault_id && !traces.capture) {
    $("capture-trace-status").textContent = "No separate call";
    $("capture-request").textContent = "Direct saved-method payments use Create order. No separate capture request was sent.";
    $("capture-response").textContent = "See the Create order response for this payment's result.";
  }
}

function controls() {
  const locked = busy || paid || unresolved || cardSubmitting;
  if (flow === "new") {
    $("payment-methods").disabled = locked;
    $("payment-methods").hidden = paid;
  }
  const container = $("checkout-controls");
  container.inert = locked;
  if ($("place-order")) $("place-order").disabled = locked || !mounted;
  // Keep hosted fields interactive during their own submission so a 3DS
  // authentication challenge inside a PayPal iframe remains usable.
  $("alternative-controls").inert = locked && !cardSubmitting;
  $("card-submit").disabled = locked || !cardMounted;
  $("resume-card").hidden = paid || !approvedCardOrderId;
  $("resume-card").disabled = busy || submittingPayment || cardSubmitting;
  if ($("authenticate-saved-card")) {
    $("authenticate-saved-card").hidden = paid || !savedCardAuthenticationUrl;
    $("authenticate-saved-card").disabled = busy || submittingPayment;
  }
  for (const id of ["save-paypal", "save-card"]) if ($(id)) $(id).disabled = locked;
  $("check-status").hidden = !unresolved;
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
  $("saved-method-type").textContent = value ? value.methodType === "card" ? "Credit / debit card" : "PayPal" : "—";
  $("buyer-detail-label").textContent = value?.methodType === "card" ? "Saved card" : "Buyer";
  $("buyer-email").textContent = value?.methodType === "card" ? cardLabel(value.card) : value?.payerEmail || "—";
  $("saved-at").textContent = value?.savedAt ? new Date(value.savedAt).toLocaleString() : "—";
}

function showPaymentDetails(order) {
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
    const saving = flow === "new" && (activeMethod === "card" ? saveCardChoice : savePayPalChoice);
    status(`${activeMethod.includes("card") ? "Card payment" : "Payment"} completed. Order ${order.id}.${saving && current.buyer?.state !== "VAULTED" ? " Vaulting is pending; refresh the saved method before using it." : ""}`, "success");
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
  if (flow === "new" && selectedMethod !== "paypal") throw new Error("Select PayPal to start this payment.");
  if (paid || unresolved || submittingPayment) throw new Error("This checkout already submitted a payment. Start a new purchase after checking its result.");
  if (flow === "returning" && approvedOrderId) {
    // A further edit gets a fresh order. The previous approved order remains
    // uncaptured; it must never be reused for the buyer's new selection.
    sessionStorage.removeItem(storageKey("component"));
    approvedOrderId = undefined;
  }
  busy = true;
  activeMethod = "paypal";
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
  if (activeMethod.includes("card")) {
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

async function recoverAttempt() {
  for (const kind of ["saved-card", "card", "direct", "component"]) {
    const key = sessionStorage.getItem(storageKey(kind));
    if (!key) continue;
    const previous = await api(`/api/operations/${encodeURIComponent(key)}`);
    if (kind === "component" && flow === "new" && typeof previous.savePaymentMethod === "boolean") {
      savePayPalChoice = $("save-paypal").checked = previous.savePaymentMethod;
    }
    if (kind === "card" && flow === "new" && typeof previous.savePaymentMethod === "boolean") {
      saveCardChoice = $("save-card").checked = previous.savePaymentMethod;
    }
    if (!previous.order?.id) continue;
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
  }
  return false;
}

async function start() {
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
  const query = new URLSearchParams(location.search);
  if (query.get("card") || query.get("saved-card")) {
    history.replaceState(null, "", location.pathname);
    // Restore only an order belonging to this browser's card attempt. Redirects
    // and reloads check status; they never submit a fresh payment or capture.
    await recoverAttempt();
    if (paid) return;
  }
  if (query.get("paypal") === "cancel") onCancel();
  if (query.get("paypal") === "return" && query.get("token")) {
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
  if (!approvedOrderId && !cardOrderId) await recoverAttempt();
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
  if (!unresolved && !cardOrderId) status(approvedOrderId ? placeOrderPrompt : flow === "new" ? "Ready. Select a payment method to continue." : mounted ? "Ready. Review or edit the saved method, or choose a card payment." : "No saved PayPal method is ready. You can pay by card below.");
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
      if (busy || paid || unresolved || submittingPayment || cardSubmitting) {
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

function cardError(error) {
  if (paid) return;
  busy = false;
  unresolved = Boolean(cardOrderId) && !paid;
  // SDK error objects can contain field-level data. Never log or persist them.
  const safe = error?.code && error.details?.traces ? error : new Error(
    cardOrderId ? "Card submission was interrupted. Check payment status before trying again." :
      "Card payment could not be submitted. Review the card and billing fields, then retry.",
  );
  showError(safe);
}

async function createCardOrder() {
  if (!cardSubmitting || paid || unresolved) throw new Error("Submit the card form to start this payment.");
  const result = await api("/api/orders", { flow: "card", page: flow, requestId: requestId("card"), ...(flow === "new" ? { savePaymentMethod: saveCardChoice } : {}) });
  cardOrderId = lastOrderId = result.order.id;
  showPaymentDetails(result.order);
  log("Card order created", { orderID: cardOrderId });
  return cardOrderId;
}

function initializeCardFields(paypal) {
  try {
    if (typeof paypal.CardFields !== "function") throw new Error("Card Fields is not available in this SDK.");
    cardFields = paypal.CardFields({
      createOrder: createCardOrder,
      onApprove(data) {
        if (paid || unresolved) return;
        if (!cardSubmitting || data.orderID !== cardOrderId) throw new Error("Unexpected card order approval.");
        if (!cardCapturePromise) {
          approvedCardOrderId = data.orderID;
          cardCapturePromise = captureOrder(data.orderID).finally(() => { cardCapturePromise = undefined; });
        }
        return cardCapturePromise;
      },
      onError: cardError,
      style: { input: { "font-family": "Arial, sans-serif", "font-size": "15px", color: "#152544", padding: "12px" }, ".invalid": { color: "#a64237" } },
    });
    if (!cardFields.isEligible()) throw new Error("This Sandbox REST app is not eligible for Card Fields.");
    $("card-status").textContent = "Pay securely with a sandbox credit or debit card.";
    $("card-form").hidden = false;
    const render = () => {
      if ((flow === "new" ? selectedMethod !== "card" : !$("card-option").open) || cardRendering) return cardRendering;
      cardRendering = Promise.resolve().then(() => Promise.all([
        cardFields.NameField({ ariaLabel: "Cardholder name" }).render("#card-name-field"),
        cardFields.NumberField({ ariaLabel: "Card number" }).render("#card-number-field"),
        cardFields.ExpiryField({ ariaLabel: "Expiry date" }).render("#card-expiry-field"),
        cardFields.CVVField({ ariaLabel: "Security code" }).render("#card-cvv-field"),
      ])).then(() => { cardMounted = true; controls(); }).catch(() => {
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
  if (result.order.completed || hasCapture(result.order)) return finish(result);
  busy = false;
  showPaymentDetails(result.order);
  approvedCardOrderId = result.order.status === "APPROVED" && result.order.cardAuthenticated === true ? result.order.id : undefined;
  savedCardAuthenticationUrl = method === "saved-card" ? result.order.payerActionUrl : undefined;
  // A confirmed unapproved order can be retried with the SAME create key. A
  // previous capture attempt always keeps the checkout locked for recovery.
  const retryable = ["CREATED", "PAYER_ACTION_REQUIRED"].includes(result.order.status) && !result.traces?.capture?.attempted;
  unresolved = Boolean(savedCardAuthenticationUrl) || !retryable;
  status(approvedCardOrderId ? "Card payment approved. Click Complete approved card payment to capture this order." : savedCardAuthenticationUrl ? "Complete card authentication before capturing this payment." :
    retryable ? "Card payment is not approved. Review the card details and retry the same checkout." : "Card payment is not confirmed. Check its status before another purchase.");
  controls();
}

$("card-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (flow === "new" && selectedMethod !== "card") return;
  if (busy || paid || unresolved || submittingPayment || cardSubmitting || !cardMounted) return;
  busy = submittingPayment = cardSubmitting = true;
  controls();
  try {
    const state = await cardFields.getState();
    if (!state.isFormValid) {
      status("Check the card number, expiry date, and security code.", "error");
      return;
    }
    activeMethod = "card";
    saveCardChoice = flow === "new" && $("save-card").checked;
    approvedOrderId = approvedCardOrderId = cardOrderId = lastOrderId = undefined;
    sessionStorage.removeItem(storageKey("component"));
    sessionStorage.removeItem(storageKey("direct"));
    showPaymentDetails(null);
    resetApiTraces();
    status("Submitting the card payment to PayPal Sandbox…");
    // Billing details and hosted card fields go directly to PayPal through the
    // SDK. Our Worker receives only flow/page and the idempotency request ID.
    await cardFields.submit({ billingAddress: {
      addressLine1: $("billing-line1").value.trim(), addressLine2: $("billing-line2").value.trim(),
      adminArea1: $("billing-region").value.trim(), adminArea2: $("billing-city").value.trim(),
      postalCode: $("billing-postal").value.trim(), countryCode: $("billing-country").value.trim().toUpperCase(),
    } });
    if (!paid && !unresolved && cardOrderId) {
      unresolved = true;
      status("Card payment is awaiting confirmation. Check payment status before retrying.");
    }
  } catch (error) { if (!paid) cardError(error); }
  finally {
    busy = submittingPayment = cardSubmitting = false;
    controls();
  }
});

$("resume-card").addEventListener("click", async () => {
  if (!approvedCardOrderId || busy || paid || submittingPayment || cardSubmitting) return;
  await captureOrder(approvedCardOrderId).catch(() => {});
  controls();
});

async function payWithSavedCard() {
  busy = submittingPayment = true;
  activeMethod = "saved-card";
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
  }
});

$("check-status").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    if (lastOrderId) {
      const result = await api(`/api/orders/${encodeURIComponent(lastOrderId)}`);
      if (activeMethod.includes("card")) {
        await restoreCard(result);
      } else if (approvedOrderId === lastOrderId && result.order.status === "APPROVED" && !hasCapture(result.order)) {
        awaitPlacement(result.order);
      } else {
        await finish(result);
      }
    } else {
      if (activeMethod === "saved-card") {
        await recoverAttempt();
        busy = false;
        controls();
        return;
      }
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
  for (const kind of ["saved-card", "card", "direct", "component"]) sessionStorage.removeItem(storageKey(kind));
  location.href = location.pathname;
});

start().catch(showError);
