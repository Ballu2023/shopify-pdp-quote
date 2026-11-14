# PDP – Shopify (Horizon) + Quote request backend

Product detail page built from the Figma design on a Shopify dev store running
**Horizon**, plus a small Node backend (Shopify App Proxy) that turns quote
requests into **draft orders**.

## Links

| | |
|---|---|
| Store | https://pranic-drug-store.myshopify.com |
| Storefront password | shared in the submission email |
| Normal product (Add to cart) | https://pranic-drug-store.myshopify.com/products/saunf-rusk |
| Quote-only product | https://pranic-drug-store.myshopify.com/products/saunf-rusk-bulk-order |
| Demo video | Google Drive link in the submission email |

The backend is live, so the quote form can be tested on the quote-only product.

The demo video covers both flows in one recording:

1. **Normal product:** variant selection, quantity, Add to cart (loading state, cart
   count update), cart, and on to checkout. No order was placed.
2. **Quote-only product:** price and Add to cart hidden, quote popup, validation,
   submit, success message and redirect to `/collections/all`.
3. **Backend:** the new draft order in Shopify admin (tags, note with name, phone
   and postcode), since draft orders aren't visible on the storefront.

## What's in the repo

```
theme/             full Horizon theme exported from the store
server/            Node/Express app proxy backend (draft orders)
shopify.app.toml   app config: scopes + app proxy
```

**My code in the theme** (everything else is stock Horizon):

| File | What it is |
|---|---|
| `theme/blocks/pdp-variant-rows.liquid` | variant rows, Add → stepper |
| `theme/blocks/pdp-quote.liquid` | quote button + popup |
| `theme/blocks/pdp-nutrition.liquid` | nutrition accordion + FSSAI |
| `theme/blocks/pdp-gallery-style.liquid` | editor settings for the native gallery |
| `theme/assets/pdp-custom.js` | cart AJAX, cart count event, quote form |
| `theme/assets/pdp-custom.css` | styles for the blocks + gallery overrides |
| `theme/templates/product.json` | block placement on the product page (theme editor) |
| `theme/config/settings_data.json` | theme editor settings (fonts, colour scheme) |

No Horizon file was edited; the last two are where the theme editor saves its settings.
To try it on another store: `shopify theme push --path theme --unpublished`.

**Backend:** [server/README.md](server/README.md) (endpoint, env vars, deploy, tests).

**Config files are templates.** `shopify.app.toml` and `server/.env.example` only
contain placeholders so the setup is clear without sharing anything. The deployed
server has the same files with the real values; the real `.env` is never committed.

## How it works

**PDP (Liquid + theme)**

I kept Horizon's own *Product information* section (media gallery, title,
description, structured data) and only built the parts the design needs that
Horizon doesn't have, as theme blocks the merchant can add/move/remove in the editor:

- **Variant rows**: one row per pack size with price, stock state and its own
  **Add** button. After adding, the button becomes a `− qty +` stepper bound to the
  cart line. Uses the AJAX Cart API (`/cart/add.js`, `/cart/change.js`) and
  Horizon's `CartUpdateEvent` so the header cart count updates. Every Add button
  is a real `/cart/add` form, so it still works without JS.
- **Quote request**: shown instead of prices/Add when the product metafield
  `custom.for_sale` is `false`. Popup form → app proxy → draft order. After success
  it counts down and sends the shopper to all products (delay/URL are block settings).
- **Nutrition info**: accordion from a JSON metafield + FSSAI number.
- **Gallery style**: editor settings for the native gallery (card colour, padding,
  radius, thumbnail size/alignment), applied as CSS variables. No Horizon file is edited.

States handled: sold out (disabled + label), low stock ("Only 3 left"), stepper
capped at available stock, per-row loading spinner, inline cart errors from Shopify.

**Backend (one endpoint)**

`POST /apps/quote/request` → app proxy → `server/` →

1. verify the app proxy HMAC signature, shop and timestamp (replay window)
2. drop honeypot (bot) submissions
3. validate input (variant id, qty 1–100, name, email, mobile, postcode)
4. rate limit per email
5. re-read the variant and its `custom.for_sale` metafield from the Admin API.
   The browser is never trusted for product data or price.
6. `draftOrderCreate` with tags `quote-request` + `serviceable` / `non-serviceable`,
   name/phone/postcode in the note

Errors return a safe message (400 / 401 / 404 / 422 / 429 / 5xx); details stay in the server log.

## Assumptions

- The store uses **Horizon**, so the PDP follows Horizon's block architecture.
- The design has an Add button per pack, so each variant row is the variant
  selector, quantity control and add to cart in one. Products are expected to have
  one option (pack size); multi-option products still work, one row per variant.
- `custom.for_sale` = `false` means quote only. Blank means for sale.
- India store: ₹ prices, 6-digit postcodes. Serviceable postcodes are a list in `.env`.
- Header, footer and "People also bought" are outside the task scope; the
  recommendations row is Horizon's native section.
- Single-store app in the same org as the dev store, so it uses the client
  credentials grant (no OAuth install flow).

## How Shopify credentials are secured

- **No long-lived token.** The app is a Dev Dashboard app; the server exchanges
  client ID + secret for an Admin API token (valid ~24h), keeps it **only in memory**
  and renews it 5 minutes before expiry. It is never written to disk, logged or sent
  to the browser.
- **Secrets only in the server's `.env`**: outside `public_html`, `chmod 600`,
  readable only by the app user. The repo has `.env.example` with empty values and
  `.env` is git-ignored. The server refuses to start if a required variable is missing.
- **Least privilege scopes**: `read_products`, `write_draft_orders`, `write_app_proxy`.
- **Only Shopify can call the endpoint**: every request must carry a valid app proxy
  HMAC (timing-safe compare), the right shop, and a recent timestamp.
- The Node process listens on `127.0.0.1` only; Apache proxies to it.
- In production I'd move secrets to a secret manager (AWS Secrets Manager / GCP
  Secret Manager / Vault) read via the server's IAM role, use separate apps per
  environment, and rotate the client secret on a schedule and whenever it may have
  leaked. The secret used during development has been rotated.

## How I'd optimise Shopify API usage / performance

- **Don't call the API for the page at all.** The PDP reads product, variants,
  stock and metafields in Liquid, which Shopify serves and caches. The backend is only
  hit on a quote submit.
- **Ask only for the fields you use.** The variant query fetches 4 fields, which keeps
  query cost low. Log `extensions.cost` and watch `throttleStatus`.
- **Reuse the access token** (cached in memory) instead of fetching one per request.
- **Respect rate limits**: on `THROTTLED` / 429, back off and retry using
  `currentlyAvailable` and `restoreRate` instead of hammering.
- **Cache read-heavy data** (e.g. product/metafield lookups) with a short TTL in
  Redis and clear it from `products/update` webhooks, rather than polling.
- **Batch work**: bulk operations for large exports/imports, one mutation with many
  line items rather than many small calls.
- Timeouts on every call (8s) so a slow upstream can't hang the storefront request.

## How I'd debug stale product data after a Shopify update

Work from the source outwards and find the first layer that shows the old value:

1. **Admin / API**: confirm the change saved. Query the product over the Admin
   GraphQL API and check `updatedAt` and the field itself (right variant, market,
   locale and price list).
2. **Storefront JSON**: open `/products/<handle>.js`. If it's correct here but not
   on the page, the problem is caching or the theme.
3. **Theme**: am I looking at the published theme or a preview? Is the metafield
   definition's *storefront access* on? Is the Liquid reading the right
   namespace/key (`.value`)?
4. **CDN / page cache**: Shopify caches storefront pages briefly. Compare with a
   cache-busting query string (`?v=123`) or a private window.
5. **Browser state**: hard refresh. Horizon keeps the cart count in
   `sessionStorage`, which can look stale after admin edits.
6. **Our backend**: it doesn't cache product data today, so it always reads fresh.
   If a cache is added, check its TTL and whether the `products/update` webhook
   arrived (Dev Dashboard → app → Logs / webhook deliveries) and cleared it.
7. **Other apps**: translation, B2B/price list or inventory sync apps can overwrite
   values after the update.

## Decisions and known limitations

- **Draft order shows "No name provided" as the customer.** Name, phone and postcode
  are in the draft note and the email is set on the draft. Linking a named customer
  needs `read_customers` / `write_customers` and protected customer data access, which
  I left out to keep least privilege. Next step: find or create the customer by email
  and pass `purchasingEntity.customerId`.
- Picking a variant row doesn't switch Horizon's gallery image; in this design all
  packs share the same photos.
- Rate limit is in memory (single instance). With more instances it moves to Redis.
- Serviceable postcodes are a static list; in production they'd come from a courier API.

## Product metafields

Settings → Custom data → Products → Add definition (storefront access on):

| Name | Namespace and key | Type |
|---|---|---|
| For sale | `custom.for_sale` | True or false (`false` = quote only, blank = for sale) |
| Nutrition | `custom.nutrition` | JSON |
| FSSAI licence | `custom.fssai_license` | Single line text |

`custom.nutrition` example:

```json
{
  "per": "100 g",
  "facts": [
    { "label": "Total calories", "value": "473 kcal" },
    { "label": "Protein", "value": "10 g" }
  ]
}
```

## Theme editor setup

Product template → Product information → Details:

1. Remove **Price**, **Variant picker** and **Buy buttons** (prices and Add are in the rows).
2. Add **Variant rows**, **Quote request**, **Nutrition info** and **Gallery style**.
3. Product media: carousel, thumbnails at the bottom, media fit *contain*.

## Run / deploy

- Backend: see [server/README.md](server/README.md) (env vars, Cloudways + PM2,
  app proxy setup, tests: `cd server && npm test`).
- Theme: copy the files listed above into a Horizon theme (or push the whole
  `theme/` folder), then follow the metafield and editor setup above.
