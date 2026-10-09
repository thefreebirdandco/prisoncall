/**
 * GET /api/products
 * Fetches variant prices from Shopify Storefront API and returns a PRICING
 * object used by choose-plan.html.
 *
 * Env vars (Cloudflare Pages):
 *   SHOPIFY_STORE_DOMAIN
 *   SHOPIFY_STOREFRONT_ACCESS_TOKEN
 */

const VARIANT_IDS = [
  'gid://shopify/ProductVariant/54535955382551', // Monthly Plan
  'gid://shopify/ProductVariant/54535991394583', // Lifetime Bundle
];

const PRODUCTS_QUERY = `
  query {
    nodes(ids: [
      "gid://shopify/ProductVariant/54535955382551",
      "gid://shopify/ProductVariant/54535991394583"
    ]) {
      ... on ProductVariant {
        id
        price {
          amount
        }
        product {
          title
        }
      }
    }
  }
`;

function numericId(gid) {
  if (!gid) return '';
  const parts = String(gid).split('/');
  return parts[parts.length - 1];
}

function parseAmount(node) {
  if (!node || !node.price || node.price.amount == null) return null;
  const n = parseFloat(node.price.amount);
  return Number.isFinite(n) ? n : null;
}

function buildPricing(priceById, titleById) {
  const p = function (id) {
    const v = priceById[id];
    if (v == null) throw new Error('Missing Shopify price for variant ' + id);
    return v;
  };
  /* Use Shopify product title if available; fall back to safe defaults */
  const t = function (id, fallback) {
    return (titleById && titleById[id]) || fallback;
  };

  const monthlyPrice  = p('54535955382551');
  const lifetimePrice = p('54535991394583');

  return {
    plans: {
      monthly: {
        price: monthlyPrice,
        interval: 'month',
        label: t('54535955382551', 'Monthly'),
      },
    },
    addons: {
      lifetime: {
        label: t('54535991394583', 'Lifetime Protection'),
        type: 'one-time',
        price: lifetimePrice,
      },
    },
  };
}

export async function onRequestGet(context) {
  const { env } = context;

  const STORE_DOMAIN = env.SHOPIFY_STORE_DOMAIN;
  const ACCESS_TOKEN = env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

  console.log('[products] SHOPIFY_STORE_DOMAIN set:', !!STORE_DOMAIN);
  console.log('[products] SHOPIFY_STOREFRONT_ACCESS_TOKEN set:', !!ACCESS_TOKEN);

  if (!STORE_DOMAIN || !ACCESS_TOKEN) {
    console.error('[products] Missing Shopify Storefront credentials');
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing Shopify credentials' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const endpoint = `https://${STORE_DOMAIN}/api/2025-04/graphql.json`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({ query: PRODUCTS_QUERY }),
    });

    const bodyText = await res.text();
    console.log('[products] Shopify status:', res.status, '— body length:', bodyText.length);

    if (!res.ok) {
      console.error('[products] Shopify HTTP error', res.status, bodyText.slice(0, 300));
      return new Response(JSON.stringify({ error: `Shopify responded with ${res.status}` }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (e) {
      console.error('[products] JSON parse failed:', e && e.message);
      return new Response(JSON.stringify({ error: 'Invalid JSON from Shopify' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (json.errors && json.errors.length) {
      console.error('[products] GraphQL errors:', JSON.stringify(json.errors).slice(0, 400));
      return new Response(JSON.stringify({ error: 'Shopify GraphQL error', details: json.errors }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const nodes = (json.data && json.data.nodes) || [];
    const priceById = {};
    const titleById = {};
    nodes.forEach(function (node) {
      if (!node) return;
      const id = numericId(node.id);
      const amount = parseAmount(node);
      if (id && amount != null) priceById[id] = amount;
      if (id && node.product && node.product.title) titleById[id] = node.product.title;
    });

    console.log('[products] Parsed variant prices:', Object.keys(priceById).length, 'of', VARIANT_IDS.length);

    let pricing;
    try {
      pricing = buildPricing(priceById, titleById);
    } catch (mapErr) {
      console.error('[products] Mapping error:', mapErr && mapErr.message);
      return new Response(JSON.stringify({ error: mapErr.message || 'Failed to map Shopify prices' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(pricing), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    console.error('[products] Fetch error:', err && err.message);
    return new Response(JSON.stringify({ error: 'Failed to reach Shopify: ' + (err && err.message) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
