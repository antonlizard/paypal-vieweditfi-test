const $ = (id) => document.getElementById(id);
const flow = document.body.dataset.flow;
let settings, buyer, mounted = false, busy = false, paid = false, unresolved = false, lastOrderId;
const activity = [];
const context = () => flow === "new" ? "new" : `returning:${buyer?.revision}`;
const storageKey = (kind) => `editfi:${context()}:${kind}`;

function log(event, data) {
  activity.unshift({ time: new Date().toLocaleTimeString(), event, ...(data ? { data } : {}) });
  $("activity").textContent = activity.slice(0, 12).map((entry) => JSON.stringify(entry, null, 2)).join("\n\n");
}

function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = `status ${type}`;
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
  log("Error", { code: error.code, message: error.message, details: error.details });
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

async function createOrder() {
  if (paid || unresolved) throw new Error("This checkout already submitted a payment. Start a new purchase after checking its result.");
  busy = true;
  showPaymentDetails(null);
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
  busy = true;
  controls();
  status("Capturing the approved PayPal order…");
  lastOrderId = data.orderID;
  showPaymentDetails({ id: data.orderID });
  try {
    await finish(await api(`/api/orders/${encodeURIComponent(data.orderID)}/capture`, {}));
  } catch (error) {
    // An interrupted capture might still have settled at PayPal. Block another
    // purchase and offer status recovery instead of creating a second charge.
    unresolved = error.code !== "BUYER_CHANGED";
    showError(error);
    if (error.code === "BUYER_CHANGED") $("checkout-controls").hidden = true;
    throw error;
  }
}

function onCancel() {
  busy = false;
  sessionStorage.removeItem(storageKey("component"));
  status("PayPal checkout was cancelled. The saved buyer has not changed.");
  log("PayPal checkout cancelled");
  controls();
}

function loadSDK(clientToken) {
  return new Promise((resolve, reject) => {
    const components = flow === "new" ? "buttons" : "buttons,funding-eligibility,messages,saved-payment-methods";
    const parameters = new URLSearchParams({
      "client-id": settings.clientId, components, vault: "true", commit: "true",
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
    const hasCapture = result.order.purchase_units?.some((unit) => unit.payments?.captures?.length);
    if (result.order.completed || kind === "direct" || hasCapture) {
      await finish(result);
      return true;
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
    await onApprove({ orderID: query.get("token") });
    history.replaceState(null, "", location.pathname);
    return;
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
  if (await recoverAttempt()) return;
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
  status(flow === "new" ? "Ready. Use a sandbox buyer account to pay and save." : "Ready. Review or edit the saved method, or place the order below.");
  log(flow === "new" ? "PayPal Buttons rendered" : "SavedPaymentMethods rendered");
}

$("place-order")?.addEventListener("click", async () => {
  if (busy || paid || unresolved || !mounted) return;
  busy = true;
  controls();
  status("Charging the saved payment method…");
  try {
    // Create Order with a vault_id can auto-capture. Never also call /capture.
    await finish(await api("/api/direct-charge", { requestId: requestId("direct"), vaultRevision: buyer.revision }));
  } catch (error) {
    unresolved = !["BUYER_CHANGED", "NO_VAULTED_BUYER"].includes(error.code);
    showError(error);
    if (!unresolved) $("checkout-controls").hidden = true;
  }
});

$("check-status").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    if (lastOrderId) {
      await finish(await api(`/api/orders/${encodeURIComponent(lastOrderId)}`));
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
