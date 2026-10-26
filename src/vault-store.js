import { AppError, PayPal, config, errorResponse, isCompleted, json } from "./paypal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_ID = /^[A-Z0-9]{8,32}$/i;

async function readBody(request) {
  const text = await request.text();
  if (text.length > 131072) throw new AppError(413, "BODY_TOO_LARGE", "Request body is too large.");
  try {
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError(400, "INVALID_JSON", "Send a JSON object.");
  }
}

function summary(order) {
  const paypal = order.payment_source?.paypal;
  return {
    id: order.id,
    status: order.status,
    completed: isCompleted(order),
    ...(paypal ? { payment_source: { paypal: {
      email_address: paypal.email_address,
      account_id: paypal.account_id,
      attributes: { vault: paypal.attributes?.vault },
    } } } : {}),
    purchase_units: order.purchase_units?.map((unit) => ({
      payments: { captures: unit.payments?.captures?.map(({ id, status, amount }) => ({ id, status, amount })) },
    })),
  };
}

function publicBuyer(buyer) {
  if (!buyer) return null;
  const { merchantCustomerId, checkoutSequence, checkoutStartedAt, ...visible } = buyer;
  return visible;
}

function matchingToken(buyer, token) {
  if (!token?.vaultId || !buyer?.checkoutStartedAt) return false;
  const time = Date.parse(token.createdAt);
  if (!Number.isFinite(time) || time < Date.parse(buyer.checkoutStartedAt) || time > Date.now() + 60000) return false;
  if (token.merchantCustomerId) return token.merchantCustomerId === buyer.merchantCustomerId;
  return Boolean(token.customerId && buyer.customerId && token.customerId === buyer.customerId);
}

// A single named object is used per PayPal REST app. Its SQLite-backed storage
// is durable and strongly consistent; no browser-local or eventually consistent
// KV cache is used for the selected buyer. The legacy fetch interface also lets
// us exercise the application with Node's built-in test runner.
export class VaultStore {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.paypal = new PayPal(env);
    this.queue = Promise.resolve();
  }

  fetch(request) {
    // Serialize PayPal calls as well as writes. Input gates alone would allow
    // two requests to interleave while awaiting an external network request.
    const task = this.queue.then(() => this.route(request));
    this.queue = task.catch(() => {});
    return task.catch(errorResponse);
  }

  async current(revision) {
    const buyer = await this.storage.get("current");
    if (!buyer?.vaultId || buyer.state !== "VAULTED") {
      throw new AppError(409, "NO_VAULTED_BUYER", "Complete a new-customer checkout and wait for the payment method to be vaulted first.");
    }
    if (revision !== buyer.revision) {
      throw new AppError(409, "BUYER_CHANGED", "A new-customer checkout replaced the saved buyer. Reload this page before continuing.");
    }
    return buyer;
  }

  async route(request) {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (method === "GET" && path === "/api/state") {
      return json({ buyer: publicBuyer(await this.storage.get("current")) });
    }
    const operationMatch = path.match(/^\/api\/operations\/([0-9a-f-]+)$/i);
    if (method === "GET" && operationMatch && UUID.test(operationMatch[1])) {
      const operation = await this.storage.get(`operation:${operationMatch[1]}`);
      return json({ order: operation?.result || null });
    }
    const orderMatch = path.match(/^\/api\/orders\/([A-Z0-9]+)(\/capture)?$/i);
    if (orderMatch && ORDER_ID.test(orderMatch[1])) {
      if (method === "GET" && !orderMatch[2]) return this.order(orderMatch[1], false);
      if (method === "POST" && orderMatch[2]) return this.order(orderMatch[1], true);
    }
    if (method !== "POST") throw new AppError(404, "NOT_FOUND", "Unknown API route.");
    const body = await readBody(request);
    if (path === "/api/client-token") {
      const buyer = await this.current(body.vaultRevision);
      return json({
        ...await this.paypal.clientToken(buyer.vaultId),
        vaultRevision: buyer.revision,
      });
    }
    if (path === "/api/orders") return this.create(request, body, false);
    if (path === "/api/direct-charge") return this.create(request, body, true);
    if (path === "/api/refresh-vault") return this.refresh();
    if (path === "/api/paypal/webhook") return this.webhook(request, body);
    throw new AppError(404, "NOT_FOUND", "Unknown API route.");
  }

  async create(request, input, direct) {
    if (!UUID.test(input.requestId || "")) {
      throw new AppError(400, "INVALID_REQUEST_ID", "A UUID requestId is required for payment idempotency.");
    }
    const flow = direct ? "direct" : input.flow;
    if (!["new", "returning", "direct"].includes(flow)) throw new AppError(400, "INVALID_FLOW", "Choose the new or returning flow.");
    const key = `operation:${input.requestId}`;
    let operation = await this.storage.get(key);
    if (operation && (operation.flow !== flow || operation.vaultRevision !== input.vaultRevision)) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This requestId already belongs to a different checkout.");
    }
    // Return an existing result before checking the active buyer, so retries
    // after a completed request can still recover the original outcome.
    if (operation?.result) return json({ order: operation.result, replayed: true });
    if (operation && Date.now() - Date.parse(operation.createdAt) > 5 * 60 * 60 * 1000) {
      // PayPal's default idempotency retention is finite. An unresolved create
      // must not be blindly submitted again after that protection might expire.
      throw new AppError(409, "PAYMENT_OUTCOME_UNKNOWN", "This interrupted checkout is too old to retry safely. Check its outcome in the PayPal sandbox dashboard before starting another purchase.");
    }
    const buyer = flow === "new" ? null : await this.current(input.vaultRevision);
    if (!operation) {
      const settings = config(this.env);
      const origin = new URL(request.url).origin;
      const page = flow === "new" ? "new-customer" : "returning-customer";
      const experience = {
        return_url: `${origin}/${page}?paypal=return`,
        cancel_url: `${origin}/${page}?paypal=cancel`,
        shipping_preference: "NO_SHIPPING",
        user_action: flow === "returning" ? "CONTINUE" : "PAY_NOW",
      };
      let source;
      let sequence;
      const merchantCustomerId = `editfi-${input.requestId}`;
      if (flow === "new") {
        sequence = (await this.storage.get("sequence") || 0) + 1;
        await this.storage.put("sequence", sequence);
        source = {
          attributes: {
            customer: { merchant_customer_id: merchantCustomerId },
            vault: {
              store_in_vault: "ON_SUCCESS",
              usage_type: "MERCHANT",
              permit_multiple_payment_tokens: false,
            },
          },
          experience_context: experience,
        };
      } else if (flow === "returning") {
        source = { experience_context: {
          ...experience,
          preferred_payment_source: { vault_id: buyer.vaultId },
        } };
      } else {
        source = { vault_id: buyer.vaultId };
      }
      operation = {
        requestId: input.requestId,
        flow,
        vaultRevision: input.vaultRevision,
        sequence,
        merchantCustomerId,
        createdAt: new Date().toISOString(),
        payload: {
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: settings.currency, value: settings.amount } }],
          payment_source: { paypal: source },
        },
      };
      // Persist the exact payload before sending money-related requests. If a
      // response is lost or the object restarts, retry the same PayPal request.
      await this.storage.put(key, operation);
    }
    const order = await this.paypal.api("/v2/checkout/orders", {
      method: "POST", body: operation.payload, requestId: `create-${operation.requestId}`,
    });
    if (!ORDER_ID.test(order.id || "")) throw new AppError(502, "INVALID_ORDER_RESPONSE", "PayPal did not return an order ID.");
    operation.orderId = order.id;
    operation.result = summary(order);
    await this.finish(operation, order);
    return json({ order: operation.result });
  }

  async order(orderId, capture) {
    const operationKey = await this.storage.get(`order:${orderId}`);
    const operation = operationKey ? await this.storage.get(operationKey) : null;
    if (!operation) throw new AppError(404, "UNKNOWN_ORDER", "This order was not created by this test application.");
    if (capture && operation.result?.completed) return json({ order: operation.result, replayed: true });
    if (capture && operation.flow !== "new") await this.current(operation.vaultRevision);
    if (capture && operation.flow === "direct") {
      throw new AppError(409, "DIRECT_ORDER", "Direct charges are processed by create order. Check their status instead of capturing again.");
    }
    const order = await this.paypal.api(`/v2/checkout/orders/${orderId}${capture ? "/capture" : ""}`, {
      method: capture ? "POST" : "GET",
      ...(capture ? { body: {}, requestId: `capture-${orderId}` } : {}),
    });
    operation.result = summary(order);
    await this.finish(operation, order);
    return json({ order: operation.result, buyer: publicBuyer(await this.storage.get("current")) });
  }

  async finish(operation, order) {
    const writes = {
      [`operation:${operation.requestId}`]: operation,
      [`order:${order.id}`]: `operation:${operation.requestId}`,
    };
    if (operation.flow === "new" && isCompleted(order) && !operation.cacheApplied) {
      const previous = await this.storage.get("current");
      if (!previous || operation.sequence >= previous.checkoutSequence) {
        const source = order.payment_source?.paypal;
        const vault = source?.attributes?.vault;
        const vaulted = vault?.status === "VAULTED" && typeof vault.id === "string" && vault.id.length > 0;
        writes.current = {
          revision: crypto.randomUUID(),
          checkoutSequence: operation.sequence,
          merchantCustomerId: operation.merchantCustomerId,
          checkoutStartedAt: operation.createdAt,
          // A completed checkout with APPROVED vault status supersedes the old
          // buyer with a pending record. Never accidentally charge the old buyer.
          vaultId: vaulted ? vault.id : null,
          customerId: vault?.customer?.id || null,
          payerEmail: source?.email_address || order.payer?.email_address || null,
          sourceOrderId: order.id,
          state: vaulted ? "VAULTED" : "PENDING",
          vaultStatus: vault?.status || "NOT_RETURNED",
          savedAt: new Date().toISOString(),
        };
        // PayPal may deliver the verified token-created webhook before the
        // capture response reaches us. Retain and correlate that event too.
        if (!vaulted) {
          const candidate = await this.storage.get(`token:merchant:${operation.merchantCustomerId}`) ||
            (writes.current.customerId ? await this.storage.get(`token:customer:${writes.current.customerId}`) : null);
          if (matchingToken(writes.current, candidate)) {
            Object.assign(writes.current, {
              vaultId: candidate.vaultId, customerId: candidate.customerId || writes.current.customerId,
              state: "VAULTED", vaultStatus: "VAULTED",
            });
          }
        }
      }
      operation.cacheApplied = true;
    }
    // Multiple-key Durable Object puts are atomic: the cache and the marker
    // preventing a replay from re-applying it are committed together.
    await this.storage.put(writes);
  }

  async refresh() {
    let buyer = await this.storage.get("current");
    if (!buyer || buyer.state === "VAULTED") return json({ buyer: publicBuyer(buyer) });
    const order = await this.paypal.api(`/v2/checkout/orders/${buyer.sourceOrderId}`);
    const vault = order.payment_source?.paypal?.attributes?.vault;
    if (vault?.status === "VAULTED" && vault.id && isCompleted(order)) {
      buyer = { ...buyer, vaultId: vault.id, customerId: vault.customer?.id || buyer.customerId, state: "VAULTED", vaultStatus: "VAULTED" };
      await this.storage.put("current", buyer);
    } else if (!buyer.customerId && vault?.customer?.id) {
      buyer = { ...buyer, customerId: vault.customer.id };
      await this.storage.put("current", buyer);
    }
    return json({ buyer: publicBuyer(buyer) });
  }

  async webhook(request, event) {
    if (!this.env.PAYPAL_WEBHOOK_ID) throw new AppError(404, "NOT_FOUND", "Webhook not configured.");
    const fields = {
      auth_algo: "paypal-auth-algo", cert_url: "paypal-cert-url",
      transmission_id: "paypal-transmission-id", transmission_sig: "paypal-transmission-sig",
      transmission_time: "paypal-transmission-time",
    };
    const verification = {};
    for (const [field, header] of Object.entries(fields)) {
      const value = request.headers.get(header);
      if (!value) throw new AppError(400, "MISSING_SIGNATURE", "Missing PayPal webhook signature.");
      verification[field] = value;
    }
    const verified = await this.paypal.api("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: { ...verification, webhook_id: this.env.PAYPAL_WEBHOOK_ID, webhook_event: event },
    });
    if (verified.verification_status !== "SUCCESS") throw new AppError(403, "INVALID_SIGNATURE", "PayPal webhook verification failed.");
    const buyer = await this.storage.get("current");
    const resource = event.resource;
    const customer = resource?.customer;
    // Match only this pending checkout. Never take a vault ID from an unsigned
    // event or replace a newer buyer using a late event for an older checkout.
    if (event.event_type === "VAULT.PAYMENT-TOKEN.CREATED" && typeof resource?.id === "string") {
      const token = {
        vaultId: resource.id, customerId: customer?.id,
        merchantCustomerId: customer?.merchant_customer_id, createdAt: event.create_time,
      };
      const writes = {};
      if (token.merchantCustomerId) writes[`token:merchant:${token.merchantCustomerId}`] = token;
      if (token.customerId) writes[`token:customer:${token.customerId}`] = token;
      if (buyer?.state === "PENDING" && matchingToken(buyer, token)) {
        writes.current = {
          ...buyer, vaultId: token.vaultId, customerId: token.customerId || buyer.customerId,
          state: "VAULTED", vaultStatus: "VAULTED",
        };
      }
      if (Object.keys(writes).length) await this.storage.put(writes);
    }
    return json({ received: true });
  }
}
