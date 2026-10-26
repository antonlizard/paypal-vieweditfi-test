import { AppError, config, errorResponse, json } from "./paypal.js";
export { VaultStore } from "./vault-store.js";

async function authenticate(request, env) {
  if (!env.BASIC_AUTH_USERNAME || !env.BASIC_AUTH_PASSWORD) {
    throw new AppError(503, "AUTH_NOT_CONFIGURED", "Configure BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD before opening this test site.");
  }
  const supplied = request.headers.get("Authorization") || "";
  const expected = `Basic ${btoa(`${env.BASIC_AUTH_USERNAME}:${env.BASIC_AUTH_PASSWORD}`)}`;
  const digest = (value) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  return mismatch === 0;
}

function secured(response) {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store, private");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("X-Robots-Tag", "noindex, nofollow");
  result.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  // Do not constrain PayPal's script/frame/connect origins with an incomplete
  // allowlist. This narrow policy does not interfere with the SDK/paysheet.
  result.headers.set("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
  return result;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const webhook = url.pathname === "/api/paypal/webhook";
      if (webhook) {
        if (!env.PAYPAL_WEBHOOK_ID) return secured(json({ error: "NOT_FOUND" }, 404));
        if (request.method !== "POST") return secured(json({ error: "METHOD_NOT_ALLOWED" }, 405));
        // PayPal cannot send our Basic credentials. The Durable Object verifies
        // this one endpoint with PayPal's signature-verification REST API.
      } else if (!await authenticate(request, env)) {
        return secured(new Response("Authentication required.", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="PayPal EditFI test", charset="UTF-8"' },
        }));
      }

      if (url.pathname.startsWith("/api/")) {
        const settings = config(env);
        if (request.method === "POST" && !webhook) {
          const origin = request.headers.get("Origin");
          if ((origin && origin !== url.origin) || request.headers.get("X-EditFI-Request") !== "1") {
            throw new AppError(403, "INVALID_ORIGIN", "Use this site's checkout page to submit requests.");
          }
          if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
            throw new AppError(415, "JSON_REQUIRED", "Send application/json.");
          }
        }
        if (url.pathname === "/api/config" && request.method === "GET") {
          const { apiBase, ...browserConfig } = settings;
          return secured(json(browserConfig));
        }
        if (!env.VAULT_STORE) throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Deploy the VAULT_STORE Durable Object binding.");
        const id = env.VAULT_STORE.idFromName(`editfi:${settings.environment}:${settings.clientId}`);
        const store = env.VAULT_STORE.get(id);
        // The original headers include PayPal's webhook signature when needed.
        return secured(await store.fetch(request));
      }

      if (!["GET", "HEAD"].includes(request.method)) return secured(json({ error: "METHOD_NOT_ALLOWED" }, 405));
      if (url.pathname === "/") {
        return secured(new Response(null, { status: 302, headers: { Location: "/new-customer" } }));
      }
      const pages = {
        "/new-customer": "/new-customer.html",
        "/returning-customer": "/returning-customer.html",
      };
      if (pages[url.pathname]) url.pathname = pages[url.pathname];
      if (!["/new-customer.html", "/returning-customer.html", "/app.js", "/styles.css"].includes(url.pathname)) {
        return secured(new Response("Not found.", { status: 404 }));
      }
      return secured(await env.ASSETS.fetch(new Request(url, request)));
    } catch (error) {
      return secured(errorResponse(error));
    }
  },
};
