/**
 * Cloudflare Pages Function — POST /api/shopify-cart
 *
 * Supports two request formats:
 *
 * NEW (simple): { variant_id, assigned_mobile, redirect_after }
 *   Builds a single-line cart with an assigned_mobile attribute, optionally
 *   appends ?return_url=<redirect_after> to the Shopify checkoutUrl, and
 *   returns { checkout_url }.
 *
 * LEGACY: { lineItems, attributes, discountCodes }
 *   Full cart build used by choose-plan.html. Returns { success, checkoutUrl }.
 *
 * Required env vars (Cloudflare Pages → Settings → Environment variables):
 *   SHOPIFY_STORE_DOMAIN              e.g. nq5ig1-5w.myshopify.com
 *   SHOPIFY_STOREFRONT_ACCESS_TOKEN   public Storefront API token
 */

const CART_CREATE_MUTATION = `
  mutation cartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }
`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonRes(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const STORE_DOMAIN  = env.SHOPIFY_STORE_DOMAIN;
  const ACCESS_TOKEN  = env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || env.SHOPIFY_STOREFRONT_TOKEN;

  if (!STORE_DOMAIN || !ACCESS_TOKEN) {
    console.error('[shopify-cart] Missing env: SHOPIFY_STORE_DOMAIN or SHOPIFY_STOREFRONT_ACCESS_TOKEN');
    return jsonRes({ success: false, error: 'Server configuration error' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return jsonRes({ success: false, error: 'Invalid request body' }, 400);
  }

  /* ── Determine request format ─────────────────────────────────────────── */
  const isSimple = !!body.variant_id;

  let cartInput;
  if (isSimple) {
    /* New format: build a single-line cart from variant_id + assigned_mobile */
    cartInput = {
      lines: [{
        quantity: 1,
        merchandiseId: 'gid://shopify/ProductVariant/' + body.variant_id,
        attributes: [{ key: 'assigned_mobile', value: String(body.assigned_mobile || '') }],
      }],
    };
  } else {
    /* Legacy format: pass through pre-built lineItems/attributes/discountCodes */
    cartInput = {
      lines:         body.lineItems     || [],
      attributes:    body.attributes    || [],
      discountCodes: body.discountCodes || [],
    };
  }

  const endpoint = `https://${STORE_DOMAIN}/api/2024-01/graphql.json`;

  let shopifyRes;
  try {
    shopifyRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({ query: CART_CREATE_MUTATION, variables: { input: cartInput } }),
    });
  } catch (err) {
    console.error('[shopify-cart] fetch error:', err && err.message);
    return jsonRes({ success: false, error: 'Network error' }, 500);
  }

  if (!shopifyRes.ok) {
    console.error('[shopify-cart] Shopify HTTP', shopifyRes.status);
    return jsonRes({ success: false, error: 'Shopify API error: ' + shopifyRes.status }, 502);
  }

  let shopifyData;
  try { shopifyData = await shopifyRes.json(); } catch (_) {
    return jsonRes({ success: false, error: 'Failed to parse Shopify response' }, 500);
  }

  if (shopifyData.errors && shopifyData.errors.length > 0) {
    const msg = shopifyData.errors.map(function(e) { return e.message; }).join('; ');
    console.error('[shopify-cart] GraphQL errors:', msg);
    return jsonRes({ success: false, error: msg }, 422);
  }

  const cartCreate = shopifyData.data && shopifyData.data.cartCreate;
  if (!cartCreate) {
    return jsonRes({ success: false, error: 'No cartCreate in response' }, 500);
  }

  if (cartCreate.userErrors && cartCreate.userErrors.length > 0) {
    const msg = cartCreate.userErrors.map(function(e) {
      return (e.field ? e.field.join('.') + ': ' : '') + e.message;
    }).join('; ');
    console.error('[shopify-cart] userErrors:', msg);
    return jsonRes({ success: false, error: msg }, 422);
  }

  let checkoutUrl = cartCreate.cart && cartCreate.cart.checkoutUrl;
  if (!checkoutUrl) {
    return jsonRes({ success: false, error: 'No checkoutUrl in response' }, 500);
  }

  /* ── Return format matches request format ─────────────────────────────── */
  if (isSimple) {
    /* Optionally append ?return_url for post-checkout redirect */
    if (body.redirect_after) {
      const sep = checkoutUrl.includes('?') ? '&' : '?';
      checkoutUrl += sep + 'return_url=' + encodeURIComponent(body.redirect_after);
    }
    return jsonRes({ checkout_url: checkoutUrl });
  } else {
    /* Legacy response shape — choose-plan.html checks data.checkoutUrl */
    return jsonRes({ success: true, checkoutUrl: checkoutUrl });
  }
}

/* Handle pre-flight CORS requests */
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
