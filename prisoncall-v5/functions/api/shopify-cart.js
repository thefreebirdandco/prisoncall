/**
 * Cloudflare Pages Function — POST /api/shopify-cart
 *
 * Supports two request formats:
 *
 * NEW (simple): { variant_id, assigned_mobile, redirect_after }
 *   Builds a single-line cart with an assigned_mobile attribute. When
 *   redirect_after starts with https://prisoncall.com.au/, stores it as a
 *   cart attribute { key: "return_url" } and inserts a transfer_intents row.
 *   Returns { checkout_url } exactly as Shopify sends it.
 *
 * LEGACY: { lineItems, attributes, discountCodes }
 *   Full cart build used by choose-plan.html. Returns { success, checkoutUrl }.
 *
 * Required env vars (Cloudflare Pages → Settings → Environment variables):
 *   SHOPIFY_STORE_DOMAIN              e.g. nq5ig1-5w.myshopify.com
 *   SHOPIFY_STOREFRONT_ACCESS_TOKEN   public Storefront API token
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
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
  let redirectAfter = '';
  if (isSimple) {
    /* New format: build a single-line cart from variant_id + assigned_mobile */
    cartInput = {
      lines: [{
        quantity: 1,
        merchandiseId: 'gid://shopify/ProductVariant/' + body.variant_id,
        attributes: [
          { key: 'assigned_mobile', value: String(body.assigned_mobile || '') },
          { key: 'sub_id', value: String(body.sub_id || '') },
        ],
      }],
    };
    /* Cart-level attribute becomes order note_attributes.return_url for WF9.
       Only same-origin Prisoncall return URLs are stored. */
    const redirectCheckPassed = typeof body.redirect_after === 'string' && body.redirect_after.startsWith('https://prisoncall.com.au/');
    console.log('[shopify-cart] redirect_after check', redirectCheckPassed ? 'passed' : 'failed', body.redirect_after);
    if (redirectCheckPassed) {
      redirectAfter = body.redirect_after;
      cartInput.attributes = [{ key: 'return_url', value: redirectAfter }];
    }
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
    if (redirectAfter) {
      const SUPABASE_URL = env.SUPABASE_URL;
      const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[shopify-cart] Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      } else {
        try {
          console.log('[shopify-cart] Transfer intent insert attempt', body.assigned_mobile, String(redirectAfter).slice(0, 50));
          const intentRes = await fetch(SUPABASE_URL + '/rest/v1/transfer_intents', {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: 'Bearer ' + SUPABASE_KEY,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({
              assigned_mobile: body.assigned_mobile,
              transfer_url: redirectAfter,
            }),
          });
          const detail = await intentRes.text();
          console.log('[shopify-cart] transfer_intents response', intentRes.status, detail);
          if (!intentRes.ok) {
            console.error('[shopify-cart] transfer_intents insert failed:', intentRes.status, detail);
          }
        } catch (err) {
          console.error('[shopify-cart] transfer_intents insert error:', err);
        }
      }
    }
    const res = jsonRes({ checkout_url: checkoutUrl });
    const debugRedirect = (typeof body.redirect_after === 'string' && body.redirect_after)
      ? body.redirect_after
      : 'missing';
    res.headers.set('X-Debug-Redirect', debugRedirect);
    return res;
  } else {
    /* Legacy response shape — choose-plan.html checks data.checkoutUrl */
    return jsonRes({ success: true, checkoutUrl: checkoutUrl });
  }
}

/* Handle pre-flight CORS requests */
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
