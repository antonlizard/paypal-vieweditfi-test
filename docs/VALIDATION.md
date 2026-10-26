# Validation

Validated on 2026-10-26 with Node.js 24.22.1.

- JavaScript syntax checks passed for the Worker, PayPal client, Durable Object, and browser code.
- 33 automated tests passed using Node's built-in test runner, mocked PayPal HTTP responses, simulated persistent Durable Object storage, and a simulated browser DOM/SDK.
- Covered authentication on pages/assets/APIs, cross-origin request rejection, both checkout paths, token scoping, cache persistence and replacement, stale pages, out-of-order callbacks, idempotency/restart recovery, pending captures/vaulting, and verified asynchronous vault events.
- A receiver-sensitive fetch regression test reproduces the original adapter's failure and verifies OAuth, Orders, and scoped-token requests use the Worker global receiver. Error tests distinguish network, timeout, abort, and invocation failures without returning raw exceptions or credentials.
- Frontend checks verify that the returning checkout shows the Order ID on creation and the completed capture's Transaction ID after payment, including direct-payment recovery and a pending capture transitioning to completion.

Not verified in this session:

- Wrangler installation and bundle/deployment validation: this execution environment rejected the npm registry request for Wrangler with HTTP 403.
- Visual/browser validation: a supported browser execution tool was not available.
- Actual PayPal SDK rendering and sandbox transactions: no sandbox credentials or provisioned component access were supplied.
- Cloudflare deployment and GitHub auto-deploy connection: no Cloudflare account connection was available.

The README includes the runtime-variable and Cloudflare setup steps needed to complete those checks in the connected accounts. No real secrets are included in this repository.
