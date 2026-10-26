export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function config(env) {
  // This harness intentionally uses sandbox endpoints only.
  if (env.PAYPAL_ENV && env.PAYPAL_ENV !== "sandbox") {
    throw new AppError(503, "SANDBOX_ONLY", "Use PAYPAL_ENV=sandbox for this test application.");
  }
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new AppError(503, "PAYPAL_NOT_CONFIGURED", "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the Worker.");
  }
  const currency = env.PAYPAL_CURRENCY || "USD";
  const amount = env.PAYPAL_AMOUNT || "10.00";
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{1,5}\.\d{2}$/.test(amount) || Number(amount) <= 0) {
    throw new AppError(503, "INVALID_AMOUNT", "Configure a positive PAYPAL_AMOUNT with two decimal places and a three-letter PAYPAL_CURRENCY.");
  }
  return {
    clientId: env.PAYPAL_CLIENT_ID,
    environment: "sandbox",
    apiBase: "https://api-m.sandbox.paypal.com",
    sdkBase: "https://www.sandbox.paypal.com",
    currency,
    amount,
  };
}

function basic(clientId, secret) {
  return btoa(`${clientId}:${secret}`);
}

const privateFields = new Set([
  "authorization", "proxyauthorization", "cookie", "setcookie", "password", "basicauthpassword",
  "secret", "clientsecret", "paypalclientsecret", "accesstoken", "refreshtoken", "idtoken",
  "clienttoken", "sdkclienttoken", "token", "apikey", "cvv", "cvc", "securitycode", "number", "cardnumber",
]);

function redact(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, privateFields.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase()) ? "[REDACTED]" : redact(item, secrets),
    ]));
  }
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[REDACTED]");
  }
  return value;
}

export class PayPal {
  constructor(env, transport = fetch) {
    this.env = env;
    this.settings = config(env);
    // workerd requires native fetch's receiver to be the Worker global scope.
    // Calling an unbound fetch as this.transport() would use this PayPal
    // instance as its receiver and throw before any HTTP request is sent.
    this.transport = transport.bind(globalThis);
    this.accessToken = null;
  }

  safeTrace(value) {
    return redact(value, [
      basic(this.settings.clientId, this.env.PAYPAL_CLIENT_SECRET),
      this.env.PAYPAL_CLIENT_SECRET, this.env.BASIC_AUTH_PASSWORD, this.accessToken?.value,
    ]);
  }

  async request(path, init, trace) {
    let response;
    try {
      if (trace) trace.attempted = true;
      response = await this.transport(this.settings.apiBase + path, {
        ...init,
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      const invalidReceiver = /Illegal invocation|incorrect.*this.*reference/i.test(error?.message || "");
      const reason = invalidReceiver ? "INVALID_FETCH_CONTEXT" :
        error?.name === "TimeoutError" ? "TIMEOUT" :
        error?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR";
      // Return only a known category and API path. Raw exception messages can
      // contain request details and must not expose credentials or tokens.
      if (invalidReceiver) {
        throw new AppError(500, "WORKER_FETCH_ERROR", "The Worker could not invoke its outbound HTTP client.", { endpoint: path, reason });
      }
      throw new AppError(502, "PAYPAL_UNREACHABLE", "The Worker could not complete its request to PayPal. Retry the same operation; its payment idempotency key is preserved.", { endpoint: path, reason });
    }
    const text = await response.text();
    let body = {};
    let responseBody = text;
    try { body = responseBody = JSON.parse(text); } catch {}
    if (trace) {
      trace.response = this.safeTrace({
        status: response.status,
        headers: Object.fromEntries(["content-type", "paypal-debug-id"].flatMap((name) => {
          const value = response.headers.get(name);
          return value ? [[name, value]] : [];
        })),
        body: responseBody,
      });
    }
    if (!response.ok) {
      // Do not forward raw OAuth bodies, headers, or credentials to the browser.
      throw new AppError(502, "PAYPAL_API_ERROR", body.message || body.error_description || "PayPal rejected the request.", {
        httpStatus: response.status,
        name: body.name || body.error,
        debugId: body.debug_id || response.headers.get("paypal-debug-id"),
        issues: body.details?.map(({ issue, description, field }) => ({ issue, description, field })),
      });
    }
    return body;
  }

  async oauth(extra = {}) {
    return this.request("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic(this.settings.clientId, this.env.PAYPAL_CLIENT_SECRET)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", ...extra }),
    });
  }

  async token() {
    if (!this.accessToken || this.accessToken.expiresAt <= Date.now()) {
      const result = await this.oauth();
      if (!result.access_token) throw new AppError(502, "INVALID_OAUTH_RESPONSE", "PayPal did not return an access token.");
      this.accessToken = {
        value: result.access_token,
        expiresAt: Date.now() + Math.max(0, (result.expires_in || 300) - 60) * 1000,
      };
    }
    return this.accessToken.value;
  }

  async clientToken(vaultId) {
    // The guide requires claims[] and response_type=client_token, NOT a
    // generic /v1/identity/generate-token client token or a top-level vault_id.
    const result = await this.oauth({
      response_type: "client_token",
      "claims[]": `vault_id:${vaultId}`,
    });
    if (!result.access_token) throw new AppError(502, "INVALID_CLIENT_TOKEN", "PayPal did not return a vault-scoped client token.");
    return { clientToken: result.access_token, expiresIn: result.expires_in };
  }

  async api(path, { method = "GET", body, requestId, trace } = {}) {
    const headers = {
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    };
    if (trace) {
      // Trace only the explicit Orders calls requested by the caller. OAuth
      // requests/responses and Authorization headers never enter the trace.
      Object.assign(trace, {
        request: this.safeTrace({ method, url: this.settings.apiBase + path, headers, body: body ?? null }),
        response: null,
        attempted: false,
      });
    }
    try {
      const token = await this.token();
      return await this.request(path, {
        method,
        headers: { ...headers, Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, trace);
    } catch (error) {
      if (trace) trace.error = this.safeTrace({
        code: error instanceof AppError ? error.code : "REQUEST_FAILED",
        message: error instanceof AppError ? error.message : "The request could not be completed.",
      });
      throw error;
    }
  }
}

export function isCompleted(order) {
  return order?.status === "COMPLETED" && order.purchase_units?.some(
    (unit) => unit.payments?.captures?.some((capture) => capture.status === "COMPLETED"),
  );
}

export function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error) {
  return json({
    error: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    message: error instanceof AppError ? error.message : "The request could not be completed.",
    ...(error instanceof AppError && error.details ? { details: error.details } : {}),
  }, error instanceof AppError ? error.status : 500);
}
