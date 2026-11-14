// Runs the real express app, only the calls to Shopify are faked.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SHOPIFY_SHOP_DOMAIN = 'demo-store.myshopify.com';
process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
process.env.SHOPIFY_CLIENT_SECRET = 'test-secret';
process.env.SERVICEABLE_POSTCODES = '400001,411045';
process.env.RATE_LIMIT_MAX = '3';

const { getSignature } = await import('../src/lib/verifyProxy.js');
const { default: app } = await import('../src/index.js');

const realFetch = globalThis.fetch;
let server;
let baseUrl;
let shopify; // controls mocked Shopify behaviour per test
let calls;

function mockShopify(url, init) {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  calls.push(u);

  if (u.endsWith('/admin/oauth/access_token')) {
    return Response.json({ access_token: 'shpca_test', scope: 'read_products,write_draft_orders', expires_in: 86399 });
  }
  const { query, variables } = JSON.parse(init.body);
  if (query.includes('productVariant')) {
    if (shopify.variantMissing) return Response.json({ data: { productVariant: null } });
    return Response.json({
      data: {
        productVariant: {
          id: variables.id,
          title: 'Large',
          product: { id: 'gid://shopify/Product/1', title: 'Spa Bag', forSale: shopify.forSale },
        },
      },
    });
  }
  if (query.includes('draftOrderCreate')) {
    shopify.lastInput = variables.input;
    return Response.json({
      data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/9', name: '#D9' }, userErrors: [] } },
    });
  }
  throw new Error(`unexpected call ${u}`);
}

function signedUrl(path, overrides = {}) {
  const params = new URLSearchParams({
    shop: 'demo-store.myshopify.com',
    path_prefix: '/apps/quote',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '',
    ...overrides,
  });
  params.set('signature', getSignature(params, 'test-secret'));
  return `${baseUrl}${path}?${params}`;
}

let emailSeq = 0;
const validBody = (extra = {}) => ({
  variantId: '4455',
  quantity: 3,
  name: 'Balwant',
  email: `buyer${++emailSeq}@example.com`,
  phone: '+91 98765 43210',
  postcode: '400001',
  ...extra,
});

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  globalThis.fetch = mockShopify;
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/proxy`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  shopify = { forSale: { value: 'false' } };
  calls = [];
});

test('creates a draft order for a quote-only product (serviceable postcode)', async () => {
  const res = await post(signedUrl('/request'), validBody());
  const json = await res.json();
  assert.equal(res.status, 201);
  assert.equal(json.reference, '#D9');
  assert.equal(json.serviceable, true);
  assert.deepEqual(shopify.lastInput.lineItems, [{ variantId: 'gid://shopify/ProductVariant/4455', quantity: 3 }]);
  assert.ok(shopify.lastInput.tags.includes('serviceable'));
  assert.match(shopify.lastInput.note, /Phone: \+919876543210/);
});

test('still creates the enquiry for a non-serviceable postcode, tagged accordingly', async () => {
  const res = await post(signedUrl('/request'), validBody({ postcode: '700001' }));
  const json = await res.json();
  assert.equal(res.status, 201);
  assert.equal(json.serviceable, false);
  assert.ok(shopify.lastInput.tags.includes('non-serviceable'));
  assert.match(json.message, /don't deliver to 700001/);
});

test('rejects a bad signature with 401 and never calls Shopify', async () => {
  const url = signedUrl('/request').replace(/signature=[a-f0-9]+/, 'signature=deadbeef');
  const res = await post(url, validBody());
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('rejects a signed request for a different shop', async () => {
  const res = await post(signedUrl('/request', { shop: 'other.myshopify.com' }), validBody());
  assert.equal(res.status, 401);
});

test('rejects a stale (replayed) request', async () => {
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const res = await post(signedUrl('/request', { timestamp: old }), validBody());
  assert.equal(res.status, 401);
});

test('returns field-level validation errors', async () => {
  const res = await post(signedUrl('/request'), validBody({ email: 'nope', quantity: 0, postcode: '12' }));
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.ok(json.errors.email && json.errors.quantity && json.errors.postcode);
  assert.equal(calls.length, 0);
});

test('refuses to quote a product that is for sale (server re-checks the metafield)', async () => {
  shopify.forSale = { value: 'true' };
  const res = await post(signedUrl('/request'), validBody());
  assert.equal(res.status, 422);
});

test('treats a blank for_sale metafield as sellable', async () => {
  shopify.forSale = null;
  const res = await post(signedUrl('/request'), validBody());
  assert.equal(res.status, 422);
});

test('404 when the variant no longer exists', async () => {
  shopify.variantMissing = true;
  const res = await post(signedUrl('/request'), validBody());
  assert.equal(res.status, 404);
});

test('honeypot submissions get a fake success and no Shopify calls', async () => {
  const res = await post(signedUrl('/request'), validBody({ website: 'spam.example' }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('rate limits repeated requests from the same email', async () => {
  const body = validBody({ email: 'repeat@example.com' });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(signedUrl('/request'), body)).status);
  assert.deepEqual(statuses, [201, 201, 201, 429]);
});

test('malformed JSON returns 400, not 500', async () => {
  const res = await fetch(signedUrl('/request'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(res.status, 400);
});
