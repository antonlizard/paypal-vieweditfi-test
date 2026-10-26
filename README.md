# PayPal EditFI test lab

Two simple checkout pages on one Cloudflare Worker, using **PayPal JS SDK v5** in the browser and **Orders v2 REST API** on the server. This implementation follows the uploaded **View and Edit Saved Payment Method** integration guide; the component's SDK name is `paypal.SavedPaymentMethods()`.

This is a **sandbox-only integration test**. It defaults to a $10.00 USD purchase. No Lightsail server is needed.

## The two pages

| Page | Behavior |
| --- | --- |
| `/new-customer` | Renders PayPal Buttons with `vault=true`. Creates an order with `store_in_vault: ON_SUCCESS`, captures it after approval, and saves the returned vault ID. |
| `/returning-customer` | Uses the latest saved buyer to mint a vault-scoped SDK client token and render `SavedPaymentMethods`. Supports editing through PayPal and paying directly with the saved method. |

Both pages display the shared saved buyer and an expandable activity panel. The returning page shows an empty state until a payment method is available. No simulated funding instrument is displayed.

## Deploy this repository to Cloudflare

Source repository: [antonlizard/paypal-vieweditfi-test](https://github.com/antonlizard/paypal-vieweditfi-test).

To work on the code locally:

```sh
git clone https://github.com/antonlizard/paypal-vieweditfi-test.git
cd paypal-vieweditfi-test
```

In the Cloudflare dashboard:

1. Open **Workers & Pages**, create a new Worker, and choose the option to import/connect a Git repository.
2. Authorize Cloudflare's GitHub integration for this repository and select it.
3. Set the Worker name to **`paypal-vieweditfi-test`**, matching `wrangler.jsonc`.
4. Use the following build configuration:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | Repository root |
   | Build command | `npm run check && npm test` |
   | Deploy command | `npm run deploy` |

   Cloudflare installs the npm dependencies before running these commands. This repository needs no frontend build. Do not add a second GitHub Actions deployment workflow; the included Actions workflow only checks the code.

5. Deploy. Before the runtime variables are configured, the Worker returns **503** and does not expose the pages.
6. Under the Worker's **Settings → Variables and Secrets**, add the values below. These are **runtime Worker values**, not just Workers Builds environment variables. Apply the changes/deploy the resulting Worker version.

   | Name | Cloudflare type | Value |
   | --- | --- | --- |
   | `PAYPAL_CLIENT_ID` | Text | Your PayPal **sandbox** REST app's public client ID |
   | `PAYPAL_CLIENT_SECRET` | Secret | The same REST app's secret |
   | `BASIC_AUTH_USERNAME` | Text or Secret | Your chosen test-site login name, for example `editfi` |
   | `BASIC_AUTH_PASSWORD` | Secret | A long random test-site password |
   | `PAYPAL_ENV` | Text | Optional: `sandbox` (the only supported environment) |
   | `PAYPAL_CURRENCY` | Text | Optional: for example `EUR`; defaults to `USD` if unset |
   | `PAYPAL_AMOUNT` | Text | Optional: for example `10.00`; defaults to `10.00` if unset |

   Runtime variables are managed in the Cloudflare dashboard. `wrangler.jsonc` deliberately leaves `vars` undeclared and uses `keep_vars: true` so Git deployments preserve those dashboard values, including your chosen currency and amount. Cloudflare may show a configuration-sync notice after dashboard edits; that notice is informational for this setup. The application supplies sandbox / USD / 10.00 fallbacks if the optional values are unset and rejects live configuration.

7. Visit your returned `https://…workers.dev/new-customer` URL and enter the HTTP Basic credentials when prompted.
8. Push future changes to `main`; Cloudflare's Git integration builds and deploys them automatically.

The `v1` migration provisions a **SQLite-backed Durable Object**, supported on Cloudflare's Workers Free plan. No KV namespace ID, D1 database, AWS server, or manually created storage binding is required. Keep the Worker name, `VaultStore` class name, binding, and migration history when deploying updates so the cached buyer remains available.

## Local development

Requires Node.js 22 or newer.

```sh
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your sandbox credentials and Basic login.
npm run dev
```

Visit the URL Wrangler prints. Local Durable Object state is stored under `.wrangler/`, is independent from the deployed Worker, and persists until that local directory is deleted. `.dev.vars` and `.wrangler` are ignored by Git. The checkout uses secure-context browser APIs, which work on localhost and HTTPS.

Alternatively, after `npx wrangler login`, configure secrets interactively with `npx wrangler secret put PAYPAL_CLIENT_SECRET` and `npx wrangler secret put BASIC_AUTH_PASSWORD`, set the other Worker values, and run `npm run deploy`. Do not pass secrets as command-line literals.

## PayPal prerequisites and test steps

Use a sandbox merchant REST app with PayPal vaulting enabled and a separate sandbox buyer account. `saved-payment-methods` / `SavedPaymentMethods` must be available to that REST app in the sandbox SDK. If it is missing, confirm component availability with your PayPal contact; the page reports this explicitly instead of replacing the component with a different UI.

1. Complete a purchase on **New customer** with the sandbox buyer. Confirm a completed capture and a saved vault ID.
2. Open **Returning customer**. Confirm the actual PayPal component displays the saved payment method.
3. Test the edit path: engage the component, approve in PayPal, and confirm the approved order is captured. Per the supplied guide, approval completes that purchase; the app then disables the direct-charge button.
4. Select **Start another returning-customer purchase**. Keep the saved method and press **Place order with saved method**. Confirm it completes without a second `/capture` request.
5. Reload or use another browser with the same Basic credentials. The saved vault ID should remain the same.
6. Complete a new-customer purchase with a different buyer. The returning page should now use the replacement vault ID. A returning page left open with the old buyer will reject payment and request a reload.
7. Cancel a new checkout or test a declined capture. The previous saved buyer should remain selected.

## How the integration works

### New customer

The SDK loads from `https://www.sandbox.paypal.com/sdk/js` with `components=buttons`, `vault=true`, and `intent=capture`. The server creates an order using:

```js
payment_source: {
  paypal: {
    attributes: {
      customer: { merchant_customer_id: "a unique ID for this new checkout" },
      vault: {
        store_in_vault: "ON_SUCCESS",
        usage_type: "MERCHANT",
        permit_multiple_payment_tokens: false
      }
    },
    experience_context: { /* return/cancel URLs and checkout settings */ }
  }
}
```

After approval the server captures the order and reads `payment_source.paypal.attributes.vault.id` and `vault.customer.id` from the response. Each new checkout has a unique merchant customer ID; this harness has one shared active buyer instead of user accounts.

### Returning customer: ViewEditFI

The server resolves the selected vault ID and calls `POST /v1/oauth2/token` with URL-encoded form fields:

```text
grant_type=client_credentials
response_type=client_token
claims[]=vault_id:<the saved vault ID>
```

The returned scoped token is attached as the **`data-sdk-client-token` script attribute**. The SDK query includes **all four** components:

```text
buttons,funding-eligibility,messages,saved-payment-methods
```

`paypal.SavedPaymentMethods({ createOrder, onApprove, onCancel, onError })` renders into the returning page. No `vaultId` is passed to this constructor.

The component's `createOrder` callback invokes the server only when the buyer engages it. That order contains `payment_source.paypal.experience_context.preferred_payment_source.vault_id`, using the same ID as the token's scope. `onApprove` captures that specific order.

If the buyer keeps the saved method, the separate place-order button calls the server with the expected cache revision. The server uses **`payment_source.paypal.vault_id`**. A completed auto-capture response is handled directly; the app never also captures that direct-charge order. An incomplete or payer-action-required result is shown as incomplete, not paid.

### Cache and payment handling

- One named Durable Object per PayPal REST app holds the current vault ID. Returning checkouts do not replace it or give it a time-to-live. Changing the client ID selects separate state.
- Only a completed new-customer payment replaces the buyer. An abandoned/failed checkout preserves the previous buyer. Old capture callbacks cannot overwrite a newer successful checkout.
- Every returning token/order/capture is checked against the cache revision. A page opened before another buyer replaced the cache must reload.
- Duplicate clicks, retries, and interrupted responses reuse stable `PayPal-Request-Id` values. The exact request payload is persisted before a create call. An unresolved create older than five hours is blocked to avoid retrying after PayPal's default idempotency window may have elapsed.
- Browser session storage holds request UUIDs only. The vault ID is stored server-side. The REST secret/access token never goes to the browser; the vault-scoped client token is supplied only for SDK initialization and is omitted from activity logs.
- Authentication runs before every HTML, JS, CSS, and API response. Mutating browser API calls also require a same-origin request marker. All responses use `Cache-Control: no-store`.

### Optional: asynchronous vault completion

PayPal can complete a payment but return `vault.status=APPROVED` before a token is ready. In that case the app selects the **new pending buyer** and blocks returning payments, so the old buyer cannot accidentally be charged. **Refresh saved buyer** checks the original order again.

For event-driven completion, register your Worker's `/api/paypal/webhook` URL for **`VAULT.PAYMENT-TOKEN.CREATED`** on the same sandbox REST app, and set the returned **`PAYPAL_WEBHOOK_ID`** as a Worker variable or secret. The endpoint is disabled unless this ID is configured.

This one machine-to-machine endpoint does not require HTTP Basic auth because PayPal cannot send your site password. It verifies the signature through PayPal's REST API before processing anything and accepts a token only when its customer/merchant-customer identity and event time match the pending checkout. Verified events arriving before the capture response are also retained for matching. Unrelated, invalid, or stale events do not change the buyer. If PayPal provides no identity sufficient to match a token, the buyer remains pending instead of guessing.

## Files and validation

| File | Purpose |
| --- | --- |
| `src/worker.js` | HTTP Basic auth, request checks, protected assets, routing |
| `src/paypal.js` | Sandbox OAuth, scoped SDK tokens, Orders v2 REST requests |
| `src/vault-store.js` | Durable cache, order tracking, idempotency, optional webhook |
| `public/*.html` | The two pages |
| `public/app.js` | SDK v5 loading, component callbacks, payment-status recovery |
| `public/styles.css` | Responsive page styles |
| `test/*.test.js` | Backend lifecycle and frontend event/SDK contract tests |
| `wrangler.jsonc` | Worker, protected static assets, SQLite Durable Object migration |

```sh
npm run check
npm test
npm run build
```

The first two commands need only Node's built-ins. The build command requires installing Wrangler. Tests mock PayPal and the browser DOM; they do not make payments and are not a substitute for a real browser/sandbox checkout.

## References

- Supplied integration guide: *View and Edit Saved Payment Method* (uploaded PDF).
- [PayPal JS SDK v5: save with a purchase](https://developer.paypal.com/sdk/js/v5/save-with-purchase/paypal)
- [PayPal JS SDK configuration](https://developer.paypal.com/sdk/js/configuration/)
- [Orders v2 REST API](https://developer.paypal.com/api/orders/v2)
- [PayPal webhook signature verification](https://developer.paypal.com/api/webhooks/v1)
- [Cloudflare Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [Cloudflare runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Durable Objects pricing and Free plan support](https://developers.cloudflare.com/durable-objects/platform/pricing/)
