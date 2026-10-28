# Validation

Validated locally on 2026-10-28 with Node.js 24.22.1.

- JavaScript syntax checks passed for the Worker, PayPal client, Durable Object, and browser code.
- 70 automated tests passed using Node's built-in test runner, mocked PayPal HTTP responses, simulated persistent Durable Object storage, and a simulated browser DOM/SDK.
- Covered authentication on pages/assets/APIs, cross-origin request rejection, both checkout paths, token scoping, cache persistence and replacement, stale pages, out-of-order callbacks, idempotency/restart recovery, pending captures/vaulting, and verified asynchronous vault events.
- A receiver-sensitive fetch regression test reproduces the original adapter's failure and verifies OAuth, Orders, and scoped-token requests use the Worker global receiver. Error tests distinguish network, timeout, abort, and invocation failures without returning raw exceptions or credentials.
- Controlled-clock tests verify that create/capture calls reuse the REST token for its reported `expires_in` lifetime, renew at expiry, and cache each replacement using its own lifetime without extending it by network time. Concurrent callers share one OAuth exchange. Failed renewals never send an expired token and can be retried; missing/invalid lifetimes are rejected. Vault-scoped SDK tokens remain separate from the REST cache.
- Frontend checks verify that the returning checkout shows the Order ID on creation and the completed capture's Transaction ID after payment, including direct-payment recovery and a pending capture transitioning to completion.
- Returning-customer approval makes no capture call. Tests verify capture only after Place order, direct payment when there was no edit, repeated edits, cancellation, duplicate clicks, reload/redirect recovery, and lost capture responses. The new-customer flow still captures after approval.
- Trace tests compare displayed requests/responses with the actual PayPal HTTP calls, verify persistence and replay, and cover failed captures and non-JSON errors. New calls display their exact Bearer authorization in the protected debug response; tests verify saved traces redact it and client secrets/site passwords remain hidden. Frontend checks verify distinct create/capture tokens, page-only retention, redaction after reload, and exclusion from activity logs and browser storage.
- Card Fields contract tests cover both pages, including no saved PayPal buyer, hosted-field eligibility/validation, lazy iframe rendering, direct SDK submission of billing details, SDK approval followed by backend capture, duplicate submissions/approvals, lost capture responses, status checks, reload/redirect recovery, and safe retries using the original key. The simulated authentication step remains interactive while other payment submissions are locked. Backend tests verify the card request's SCA preference, server-controlled amounts, ignored browser-supplied card data, buyer-cache preservation, and capture after the PayPal buyer changes.
- Wallet display checks cover Safari on macOS/iPhone, Chrome on macOS/Android, and browsers exposing ApplePaySession. Each placeholder is disabled and has no payment handler.

Not verified in this session:

- Local Wrangler bundle validation: this execution environment rejected the npm registry request for Wrangler with HTTP 403.
- Visual/browser validation: a supported browser execution tool was not available.
- Actual PayPal SDK rendering, Card Fields account eligibility, real 3DS challenges, and Sandbox transactions: runtime credentials remain in Cloudflare and no supported browser execution tool is available here. The deployed pages use the actual Sandbox SDK and REST API, not the test mocks.

Cloudflare builds and deployments are monitored through its GitHub check run; see the latest commit's check for the current deployment result. The README includes the runtime-variable and Cloudflare setup steps. No real secrets are included in this repository.
