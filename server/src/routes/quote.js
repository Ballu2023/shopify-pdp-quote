import { Router } from 'express';
import { verifyProxy } from '../lib/verifyProxy.js';
import { shopifyQuery, httpError } from '../lib/shopify.js';

const router = Router();

const VARIANT_QUERY = `
  query ($id: ID!) {
    productVariant(id: $id) {
      id
      product {
        title
        forSale: metafield(namespace: "custom", key: "for_sale") { value }
      }
    }
  }
`;

const CREATE_DRAFT_ORDER = `
  mutation ($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

function getServiceablePostcodes() {
  return (process.env.SERVICEABLE_POSTCODES || '').split(',').map((p) => p.trim());
}

function validate(body) {
  const errors = {};
  const data = {
    variantId: String(body.variantId ?? '').trim(),
    quantity: Number(body.quantity),
    name: String(body.name ?? '').trim(),
    email: String(body.email ?? '').trim().toLowerCase(),
    phone: String(body.phone ?? '').replace(/[\s()-]/g, ''),
    postcode: String(body.postcode ?? '').trim(),
  };
  const postcodeRegex = new RegExp(process.env.POSTCODE_REGEX || '^[1-9][0-9]{5}$');

  if (!/^\d{1,20}$/.test(data.variantId)) errors.variantId = 'Invalid product option';
  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > 100) {
    errors.quantity = 'Quantity should be between 1 and 100';
  }
  if (data.name.length < 2 || data.name.length > 80 || /[<>]/.test(data.name)) {
    errors.name = 'Please enter your name';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 254) {
    errors.email = 'Please enter a valid email';
  }
  if (!/^\+?\d{8,15}$/.test(data.phone)) errors.phone = 'Please enter a valid mobile number';
  if (!postcodeRegex.test(data.postcode)) errors.postcode = 'Please enter a valid postcode';

  return { data, errors };
}

// Simple in-memory limit per email. Not by IP, because behind the app proxy
// every request comes from Shopify's servers. Would use Redis with more than one instance.
const requestLog = new Map();

function isRateLimited(email) {
  const limit = Number(process.env.RATE_LIMIT_MAX) || 5;
  const now = Date.now();
  const recent = (requestLog.get(email) || []).filter((t) => now - t < 60 * 1000);
  recent.push(now);
  requestLog.set(email, recent);
  return recent.length > limit;
}

router.post('/request', verifyProxy, async (req, res, next) => {
  try {
    // hidden "website" field, only bots fill it. Pretend it worked.
    if (req.body.website) {
      return res.json({ ok: true, message: 'Thanks! We will get back to you soon.' });
    }

    const { data, errors } = validate(req.body);
    if (Object.keys(errors).length) {
      throw httpError(400, 'Please check the highlighted fields', errors);
    }

    if (isRateLimited(data.email)) {
      throw httpError(429, 'Too many requests, please try again in a minute');
    }

    // don't trust the browser, check the product on Shopify ourselves
    const result = await shopifyQuery(VARIANT_QUERY, {
      id: `gid://shopify/ProductVariant/${data.variantId}`,
    });
    const variant = result.productVariant;

    if (!variant) {
      throw httpError(404, 'This product is no longer available');
    }
    // empty metafield means the product is for sale (same as the theme)
    if (variant.product.forSale?.value !== 'false') {
      throw httpError(422, 'This product can be added to cart directly');
    }

    const serviceable = getServiceablePostcodes().includes(data.postcode);

    const created = await shopifyQuery(CREATE_DRAFT_ORDER, {
      input: {
        email: data.email,
        lineItems: [{ variantId: variant.id, quantity: data.quantity }],
        tags: ['quote-request', serviceable ? 'serviceable' : 'non-serviceable'],
        note: `Quote request from product page
Name: ${data.name}
Phone: ${data.phone}
Postcode: ${data.postcode} (${serviceable ? 'serviceable' : 'not serviceable'})`,
      },
    });

    const { draftOrder, userErrors } = created.draftOrderCreate;
    if (userErrors.length) {
      console.error('Draft order errors:', userErrors);
      throw httpError(422, 'Could not submit your request, please check your details');
    }

    console.log(`Quote ${draftOrder.name} created for variant ${data.variantId} x${data.quantity}`);

    const message = serviceable
      ? `Thanks! Your request ${draftOrder.name} is received. We'll email you the quote soon.`
      : `Request ${draftOrder.name} received. We don't deliver to ${data.postcode} yet, our team will contact you.`;

    res.status(201).json({ ok: true, reference: draftOrder.name, serviceable, message });
  } catch (err) {
    next(err);
  }
});

export default router;
