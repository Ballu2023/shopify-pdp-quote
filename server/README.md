# PDP Quote — backend (Shopify App Proxy)

Products with the `custom.for_sale` metafield set to `false` show a **Request a quote** button
on the PDP instead of price and Add to Cart. The popup posts to `/apps/quote/request`.
Shopify's App Proxy forwards that request to this server, which:

1. verifies the App Proxy HMAC signature, the shop and the timestamp
2. drops honeypot (bot) submissions
3. validates and normalises the input
4. rate-limits per email
5. re-reads the variant and its `for_sale` metafield from the Admin API, so the browser is never trusted
6. creates a **draft order** tagged `quote-request` and `serviceable` or `non-serviceable`, with the postcode in the note

## Files

```
src/
  index.js            express setup, env check, error handler
  routes/quote.js     validation, rate limit, draft order creation
  lib/shopify.js      access token (client credentials) + GraphQL helper
  lib/verifyProxy.js  app proxy signature check
test/quote.test.js    tests with Shopify calls faked
```

## API

`POST /apps/quote/request` (storefront), forwarded to `POST /proxy/request`

```json
{ "variantId": "4455", "quantity": 3, "name": "…", "email": "…", "phone": "…", "postcode": "400001", "website": "" }
```

| Status | When |
|---|---|
| 201 | Draft order created → `{ ok, reference, serviceable, message }` |
| 400 | Validation failed → `{ errors: { field: message } }` |
| 401 | Bad or missing signature, wrong shop, or stale request |
| 404 | Variant no longer exists |
| 422 | Product is not quote-only, or Shopify rejected the draft order |
| 429 | Rate limited |
| 502/503/504 | Shopify error, throttled, or timed out (details only in server logs) |

## Setup

1. **Dev Dashboard**: create the app (not embedded, legacy install flow off), then
   install it on the dev store (same organisation).
2. Fill in `shopify.app.toml` (it's a template: client_id + your server URL), then run
   `shopify app deploy` to push the scopes and App Proxy config. Approve the scopes
   in the store admin.
3. **Metafield**: Settings → Custom data → Products → `custom.for_sale` (True or false).
4. On the server, copy `.env.example` to `.env` and fill in the client ID and secret
   from the app's Settings. `.env.example` is a template with empty values; the real
   `.env` exists only on the server and is git-ignored.

## Deploy (Cloudways, what's running now)

```bash
# Cloudways panel: new Application (default domain has SSL), Varnish OFF
cd ~/applications/<app>/private_html          # not public_html: never web-served
# upload/clone the server folder here as pdp-quote-server
cd pdp-quote-server
npm ci --omit=dev
cp .env.example .env && chmod 600 .env        # fill in real values

# PM2 in the home folder (no root on Cloudways)
npm config set prefix ~/.npm-global
export PATH=$HOME/.npm-global/bin:$PATH
npm install -g pm2
pm2 start src/index.js --name pdp-quote && pm2 save
# reboot persistence: crontab -e
# @reboot cd ~/applications/<app>/private_html/pdp-quote-server && ~/.npm-global/bin/pm2 resurrect
```

`public_html/.htaccess` (the only file in public_html):

```apache
RewriteEngine On
RewriteRule ^(.*)$ http://127.0.0.1:3010/$1 [P,L]
```

The app listens on `127.0.0.1` only, so it can't be reached except through the proxy.
Check: `https://<server>/health` → `{"ok":true}`. Logs: `pm2 logs pdp-quote`.

## Decisions and known limitations

- **Draft order customer shows "No name provided".** The app only asks for
  `read_products`, `write_draft_orders` and `write_app_proxy`. The shopper's name,
  phone and postcode are saved in the draft order **note**, and the email is set on
  the draft, so the merchant has everything needed to reply.
  Linking a named Shopify customer would need `read_customers` + `write_customers`
  and protected customer data access. I left that out to keep the app on least
  privilege. Next step if needed: find the customer by email, create one if missing,
  and pass it to `draftOrderCreate` as `purchasingEntity.customerId`.
- **Rate limit is in memory**, so it resets on restart and isn't shared between
  instances. With more than one instance this would move to Redis.
- **Serviceable postcodes are a static list** in `.env`. In production this would
  come from the courier / logistics API.

## Test

```bash
npm test      # 12 tests, Shopify calls faked
```

## Teardown after evaluation

Uninstall the app from the store, rotate the client secret in the Dev Dashboard, `pm2 delete pdp-quote`, delete `.env`, and remove the subdomain.
