// Admin API helper.
// Dev Dashboard apps don't give a fixed token anymore, so we get one using
// client id + secret. It's valid for ~24h and only kept in memory.

let token = null;
let tokenExpiresAt = 0;

export function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors;
  return err;
}

async function getToken() {
  // reuse the token until 5 min before it expires
  if (token && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return token;
  }

  const res = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    console.error('Could not get Shopify token, status', res.status);
    throw httpError(502, 'Service unavailable, please try again');
  }

  const data = await res.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return token;
}

export async function shopifyQuery(query, variables = {}, isRetry = false) {
  const version = process.env.SHOPIFY_API_VERSION || '2026-10';
  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${version}/graphql.json`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await getToken(),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    if (e.status) throw e; // came from getToken
    console.error('Shopify request failed:', e.message);
    throw httpError(504, 'Service unavailable, please try again');
  }

  // token revoked or expired early, get a fresh one and try once more
  if (res.status === 401 && !isRetry) {
    token = null;
    return shopifyQuery(query, variables, true);
  }

  if (res.status === 429) {
    throw httpError(503, 'Too busy right now, please try again in a moment');
  }

  if (!res.ok) {
    console.error('Shopify returned', res.status);
    throw httpError(502, 'Service unavailable, please try again');
  }

  const json = await res.json();

  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors));
    const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
    throw httpError(throttled ? 503 : 502, 'Service unavailable, please try again');
  }

  return json.data;
}
