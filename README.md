# PayPal EditFI test lab

Two simple checkout pages on one Cloudflare Worker, using **PayPal JS SDK v5** in the browser and **Orders v2 REST API** on the server. This implementation follows the uploaded **View and Edit Saved Payment Method** integration guide; the component's SDK name is `paypal.SavedPaymentMethods()`.

This is a **sandbox-only integration test**. It defaults to a $10.00 USD purchase. No Lightsail server is needed.

## The two pages

| Page | Behavior |
| --- | --- |
| `/new-customer` | Starts with three equal, unselected radio choices: PayPal, Credit or debit card, and Apple Pay / Google Pay. Selecting one reveals only its button or fields. PayPal and card each have an unchecked **Save payment method for future payments** checkbox. Only an opted-in successful purchase saves its method. |
| `/returning-customer` | Offers the last method saved with a purchase. Saved PayPal uses ViewEditFI; saved cards use a masked card option with 3DS. Other payment options remain available. |

Both pages display the shared saved buyer and an expandable activity panel. The returning page shows an empty state until a payment method is available. No simulated funding instrument is displayed.

Both pages also offer **Credit or debit card** through real PayPal Sandbox **Card Fields** and a disabled, **display-only** digital wallet button. Apple Pay is shown on detected Apple devices in any browser, including Chrome on Mac, iPhone, and iPad, or when the browser exposes `ApplePaySession`; other devices show Google Pay. iPad desktop mode is recognized by its Mac platform. This display choice is a browser/device heuristic, not a wallet eligibility check. On the new page the wallet radio remains selectable and reveals the disabled button and explanation. No Apple Pay/Google Pay SDK, payment session, order, or capture is started.

On the new page no payment control is rendered until its radio is selected. The PayPal button and hosted card iframes are reused when switching methods; save-checkbox choices remain intact. Selecting a method never creates an order. The radio selector is locked while a submission is actively running. After a failed/cancelled authentication, card fields are rebuilt and methods can be switched without a page reload. Card inputs remain editable when a capture result is unknown, while another payment submission waits for a status check. Reloading an existing checkout restores its method and status for recovery.

Select the card radio on the new page, or open the card option on the returning page, to render PayPal-hosted name, number, expiry, and CVV fields. Enter sandbox card details, then select **Pay by card**. The form does not collect a billing address. All card requests use `payment_source.card.attributes.verification.method=SCA_ALWAYS`; the SDK submits card details directly to PayPal and handles authentication. Only flow/page, the save-consent flag on the new page, and the idempotency UUID go from this form to the Worker. Before capturing a card, the backend retrieves its authentication result from PayPal and requires status `APPROVED` with `three_d_secure.authentication_status=Y`. Failed, incomplete, attempted-only, or absent authentication is blocked. Successful frictionless authentication is accepted; a visible bank challenge is not guaranteed.

On the new page, selecting the save checkbox adds `store_in_vault: ON_SUCCESS` to that payment source. A successful opted-in PayPal or card purchase replaces the shared saved method. Unchecked purchases, purchases through the other methods on the returning page, and failed payments preserve it. The cache records the method type and minimal card display data (brand, last digits, expiry) in addition to the vault/customer IDs; card numbers and security codes are never stored.

The Sandbox business account/app must be enabled for **Advanced Credit and Debit Card Payments**. The page checks `CardFields.isEligible()` and displays an availability message instead of fake card inputs when it cannot render. Use the [PayPal sandbox card generator](https://developer.paypal.com/tools/sandbox/card-testing/) for testing, including [3D Secure scenarios](https://developer.paypal.com/v5/expanded/3d-secure/test/). Card Fields are rendered only after opening the card option, so their iframe sizes can be measured in a visible container.

The returning page displays the Order ID as soon as ViewEditFI creates the order. Approving a payment-method change returns to the merchant page without capturing payment. The buyer clicks **Place order with saved method** to capture that approved order, after which its Transaction ID (capture ID) is displayed. These details also appear for payments made directly with the saved method and for recovered payment results.

Order and Transaction IDs also appear for card payments on both pages. Duplicate submissions reuse the same payment operation. Interrupted captures require a status check; an approved card order can be captured using **Complete approved card payment**. Reloads and card return redirects restore that browser's existing card attempt without automatically capturing. An unapproved card order confirmed by a status check can be retried with its original create key when no capture was attempted.

For card/3DS troubleshooting, **Integration activity** records results from `CardFields.onApprove`, `onError`, `onCancel`, and the `submit()` promise. Approval includes the frontend `liabilityShift` and any supplied authentication result; `null` means the SDK did not supply that value. Error logs include the checkout stage, callback, order ID, and any structured SDK error name/code, PayPal debug ID, or API issue code. Serialized SDK error messages are parsed for these identifiers; raw messages, URLs, stacks, card fields, and credentials are not logged. The error category is a best-effort classification, not a confirmed root cause.

PayPal Card Fields v5 does **not** expose `onLookupComplete`; that hook belongs to Braintree's 3DS API. The activity panel records this callback availability explicitly. Backend Get Order calls log `payment_source.card.authentication_result` separately from frontend results, including the authentication check before capture. Use **Get order / 3DS result** to inspect the redacted REST request and full response, or select **Check payment status** for a read-only refresh. These lookups never capture.

Failed or cancelled card authentication releases the busy state, closes/rebuilds the hosted card fields, and allows another payment method. Each SDK instance owns its callbacks: late approvals, errors, or submit completions from an abandoned instance cannot capture or change the state of a newer checkout. A raw card order approved without a capture attempt can also be abandoned for PayPal. A possibly submitted capture remains protected against a second payment until its result is checked; method selection and card editing still work.

Both pages include expandable **Create order**, **Confirm saved card / 3DS**, **Get order / 3DS result**, and **Capture** panels showing the backend's PayPal REST method, URL, safe headers, JSON request body, response HTTP status, and full response body. Errors are shown too. Confirm details apply to saved-card purchases. Get Order details include card authentication checks and manual status refreshes; the latest lookup is retained. Capture details appear only after a capture is requested; direct saved-PayPal payments identify that no separate capture call was sent and show the payment result in Create order.

Traces are retained with the checkout for retries and reloads. Create, confirm, Get Order, and capture calls display the Bearer authorization method, but replace the token value and `Authorization` header with `[REDACTED]`. This applies to immediate success/error responses as well as saved history. The browser also masks legacy token values and does not retain them for later display. Actual PayPal requests still use the server's cached access token.

OAuth exchanges, client secrets, site passwords, and other sensitive response fields remain excluded or redacted. Tokens are not written to browser storage or activity logs. Orders created before tracing was introduced may not have their original responses available; start a new purchase to record both steps.

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

1. On **New customer**, select the **PayPal** radio, select **Save payment method for future payments**, then complete a sandbox purchase. Confirm a completed capture and a saved vault ID.
2. Open **Returning customer**. Confirm the actual PayPal component displays the saved payment method.
3. Test the edit path: engage the component and approve in PayPal. Confirm the Order ID is visible and no capture has occurred. Click **Place order with saved method** and confirm that the same order is captured and its Transaction ID is displayed. Duplicate clicks must not create another payment.
4. Select **Start another returning-customer purchase**. Keep the saved method and press **Place order with saved method**. Confirm it completes without a second `/capture` request.
5. Reload or use another browser with the same Basic credentials. The saved vault ID should remain the same.
6. Complete a new-customer purchase with saving selected and a different buyer. The returning page should now use the replacement vault ID. A returning page left open with the old buyer will reject payment and request a reload.
7. Cancel a new checkout or test a declined capture. The previous saved buyer should remain selected.
8. Complete a purchase with the save checkbox unchecked for each payment type. Confirm the saved method remains unchanged.
9. On the new page, select the **Credit or debit card** radio, select the card save checkbox, and use a 3DS-enabled sandbox card. After successful authentication and capture, confirm the saved method is now a card with its brand and last digits.
10. Open the returning page and select **Place order with saved card**. Follow PayPal's 3DS flow. After returning, select **Complete approved card payment** to capture. Confirm the create, confirm, and capture details and transaction ID. Failed/incomplete authentication must not permit capture.

## How the integration works

### New customer

The SDK loads from `https://www.sandbox.paypal.com/sdk/js` with `components=buttons,card-fields`, `vault=true`, and `intent=capture`. The SDK supports optional vaulting; the backend adds vault instructions only when the corresponding checkbox is selected. An opted-in PayPal purchase creates an order using:

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

After approval the server captures the order and, for an opted-in purchase, reads `payment_source.paypal.attributes.vault.id` or `payment_source.card.attributes.vault.id` and the associated customer ID. Each saving checkout has a unique merchant customer ID; this harness has one shared saved method instead of user accounts. The consent and exact request payload are fixed per idempotency UUID.

### Returning customer: ViewEditFI

When the last saved method is **PayPal**, the server resolves its vault ID and calls `POST /v1/oauth2/token` with URL-encoded form fields:

```text
grant_type=client_credentials
response_type=client_token
claims[]=vault_id:<the saved vault ID>
```

The returned scoped token is attached as the **`data-sdk-client-token` script attribute**. The SDK query includes the **four components required for ViewEditFI plus Card Fields**:

```text
buttons,funding-eligibility,messages,saved-payment-methods,card-fields
```

`paypal.SavedPaymentMethods({ createOrder, onApprove, onCancel, onError })` renders into the returning page. No `vaultId` is passed to this constructor.

The component's `createOrder` callback invokes the server only when the buyer engages it. That order contains `payment_source.paypal.experience_context.preferred_payment_source.vault_id`, using the same ID as the token's scope. The returning SDK uses `commit=false`, matched by `experience_context.user_action=CONTINUE` in the Orders request.

`onApprove` retains the approved Order ID and enables **Place order with saved method** without submitting a capture. That button captures the existing approved order; it does not create a second direct-charge order. Reloads, PayPal redirects, and status checks restore an approved order without capturing it. A further edit creates a new order, and only the latest approved order can be submitted from this page. The new-customer flow continues to capture immediately after PayPal approval.

If the buyer keeps the saved method, the separate place-order button calls the server with the expected cache revision. The server uses **`payment_source.paypal.vault_id`**. A completed auto-capture response is handled directly; the app never also captures that direct-charge order. An incomplete or payer-action-required result is shown as incomplete, not paid.

### Returning customer: saved card

ViewEditFI is used for saved PayPal accounts. A saved card is displayed using its brand, last digits, and expiry, alongside new Card Fields, PayPal Buttons, and the display-only wallet. The saved-card flow does not mint a PayPal-wallet-scoped SDK token.

Selecting **Place order with saved card** calls the backend with a request UUID and cache revision. The server first creates an order without a payment source, then calls **`/v2/checkout/orders/{id}/confirm-payment-source`** with the server-resolved `payment_source.card.vault_id`, `verification.method=SCA_ALWAYS`, and customer-initiated, one-time, subsequent stored-credential indicators. Creation and confirmation have separate stable idempotency keys. Confirmation retries reuse the same order.

The backend validates the returned PayPal `payer-action` URL and appends the merchant return URI as `redirect_uri`. The browser follows it for authentication. On return, it retrieves order status without capturing automatically. Only an order that PayPal reports as `APPROVED` and successfully authenticated (`Y`) enables **Complete approved card payment**. The backend rechecks the current saved-method revision and PayPal authentication result immediately before capture; browser claims cannot bypass those checks. A frictionless result already approved on the initial Place order action can be captured by that action. Status checks and reloads remain read-only.

### Cache and payment handling

- One named Durable Object per PayPal REST app holds the current vault ID. Returning checkouts do not replace it or give it a time-to-live. Changing the client ID selects separate state.
- Only a completed new-customer purchase with explicit save consent replaces the method. An unchecked, abandoned, or failed checkout preserves the previous method. Late PayPal/card captures cannot overwrite a more recent successful opted-in purchase.
- Every returning token/order/capture is checked against the cache revision. A page opened before another buyer replaced the cache must reload.
- Duplicate clicks, retries, and interrupted responses reuse stable `PayPal-Request-Id` values. The exact request payload is persisted before a create call. An unresolved create older than five hours is blocked to avoid retrying after PayPal's default idempotency window may have elapsed.
- Browser session storage holds request UUIDs only. The vault ID is stored server-side. The REST app secret and REST Bearer access token stay on the server; request panels and API traces redact credentials for new calls and saved history. The vault-scoped client token is supplied only for SDK initialization. Neither token is written to browser storage or activity logs.
- Backend REST access tokens are cached in the active Durable Object's memory for the OAuth response's `expires_in` lifetime in seconds, measured from the start of that exchange. Every REST call checks expiry; the first call after expiry obtains and caches a new token, and concurrent callers share one OAuth exchange. Missing or invalid lifetimes are rejected instead of assuming a duration. SDK client tokens are separate from this REST cache. An object restart or deployment can require a fresh token because usable tokens are not persisted in storage.
- Authentication runs before every HTML, JS, CSS, and API response. Mutating browser API calls also require a same-origin request marker. All responses use `Cache-Control: no-store`.

### Optional: asynchronous vault completion

PayPal can complete a PayPal or card payment but return `vault.status=APPROVED` before a token is ready. In that case the app selects the **new pending method** and blocks returning payments, so the old method cannot accidentally be charged. **Refresh saved method** checks the original order again. A card token webhook must identify a card source and match the pending checkout; a PayPal token cannot activate a pending card.

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
- [PayPal Card Fields: vaulting, 3DS, and cancellation callbacks](https://developer.paypal.com/platforms/checkout/save-payment-methods/during-purchase/js-sdk/cards/)
- [PayPal Card Fields v5 public API types](https://github.com/paypal/paypal-js/blob/main/packages/paypal-js/types/components/card-fields.d.ts)
- [PayPal webhook signature verification](https://developer.paypal.com/api/webhooks/v1)
- [Cloudflare Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [Cloudflare runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Durable Objects pricing and Free plan support](https://developers.cloudflare.com/durable-objects/platform/pricing/)
