// Central Supabase handler for all portal operations.
// Customer identity is ALWAYS read from the pc_session HttpOnly cookie — never trusted from request body.

function parseCookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function getSession(request) {
  const raw = parseCookieValue(request.headers.get('Cookie') || '', 'pc_session');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSb(supabaseUrl, serviceKey) {
  return async function sb(path, opts = {}) {
    return fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
  };
}

// ─── Seal API ────────────────────────────────────────────────────────────────
const SEAL_API = 'https://app.sealsubscriptions.com/shopify/merchant/api';

function sealApi(env, path, opts = {}) {
  return fetch(`${SEAL_API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Seal-Token': env.SEAL_API_TOKEN,
      ...(opts.headers || {}),
    },
  });
}

// Shopify variant IDs by tier and interval (from Prisoncall_Shopify_Product_IDs_v1_0.xlsx)
const VARIANT_BY_INTERVAL = {
  fortnightly: {
    0: { variant_id: '54535954497815', product_id: '10440892154135', price: 19.99, title: 'Fortnightly Plan' },
    1: { variant_id: '54535954891031', product_id: '10440892317975', price: 23.98, title: 'Fortnightly Plan + Transfer Guarantee' },
    2: { variant_id: '54535954956567', product_id: '10440892383511', price: 23.98, title: 'Fortnightly Plan + Renewal Guarantee' },
    3: { variant_id: '54535955218711', product_id: '10440892514583', price: 26.98, title: 'Fortnightly Plan + Combo (Transfer & Renewal) Guarantee' },
  },
  monthly: {
    0: { variant_id: '54535955382551', product_id: '10440892678423', price: 34.99, title: 'Monthly Plan' },
    1: { variant_id: '54535955546391', product_id: '10440892842263', price: 39.98, title: 'Monthly Plan + Transfer Guarantee' },
    2: { variant_id: '54535955710231', product_id: '10440892940567', price: 39.98, title: 'Monthly Plan + Renewal Guarantee' },
    3: { variant_id: '54535955841303', product_id: '10440893038871', price: 42.98, title: 'Monthly Plan + Combo (Transfer & Renewal) Guarantee' },
  },
  halfyearly: {
    0: { variant_id: '54535956005143', product_id: '10440893104407', price: 174.99, title: 'Half Yearly Plan' },
    1: { variant_id: '54535957020951', product_id: '10440893956375', price: 186.98, title: 'Half Yearly Plan + Transfer Guarantee' },
    2: { variant_id: '54535957086487', product_id: '10440894021911', price: 186.98, title: 'Half Yearly Plan + Renewal Guarantee' },
    3: { variant_id: '54535957119255', product_id: '10440894054679', price: 194.98, title: 'Half Yearly Plan + Combo (Transfer & Renewal) Guarantee' },
  },
};

// Map a Shopify variant_id string → { tier, interval }
const VARIANT_TIER_MAP = {};
for (const [interval, tiers] of Object.entries(VARIANT_BY_INTERVAL)) {
  for (const [tier, v] of Object.entries(tiers)) {
    VARIANT_TIER_MAP[v.variant_id] = { tier: Number(tier), interval };
  }
}

const SEAL_INTERVAL_EDIT = {
  fortnightly: { delivery_interval: '2 week',  billing_interval: '2 week'  },
  monthly:     { delivery_interval: '1 month', billing_interval: '1 month' },
  halfyearly:  { delivery_interval: '6 month', billing_interval: '6 month' },
};

// ─── GET handler — read-only actions ───────────────────────────────────────

export async function onRequestGet(context) {
  const { env, request } = context;
  const sb = makeSb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'get-subscriptions') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const mobile = session.mobile;

    const res = await sb(
      `subscriptions?assigned_mobile=eq.${encodeURIComponent(mobile)}&order=created_at.desc`
    );
    if (!res.ok) return json({ error: 'db_error' }, 500);
    const rows = await res.json();
    return json(rows);
  }

  if (action === 'get-prisons') {
    const state = url.searchParams.get('state') || '';
    if (!state) return json({ error: 'state_required' }, 400);
    const res = await sb(
      `prison_did_lookup?prison_state=eq.${encodeURIComponent(state)}&order=prison_name.asc&select=prison_name,prison_state`
    );
    if (!res.ok) return json({ error: 'db_error' }, 500);
    const rows = await res.json();
    return json(rows);
  }

  return json({ error: 'unknown_action' }, 400);
}

// ─── POST handler — write actions ──────────────────────────────────────────

export async function onRequestPost(context) {
  const { env, request } = context;
  const sb = makeSb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid_body' }, 400); }

  const action = body.action;

  // ── submit-transfer ──────────────────────────────────────────────────────
  if (action === 'submit-transfer') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const mobile = session.mobile;

    const { subscription_id, new_prison_name, new_prison_state } = body;
    if (!subscription_id || !new_prison_name || !new_prison_state) {
      return json({ error: 'missing_fields' }, 400);
    }

    // Verify ownership
    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&limit=1`);
    if (!subRes.ok) return json({ error: 'db_error' }, 500);
    const subRows = await subRes.json();
    if (!subRows.length) return json({ error: 'not_found' }, 404);
    const sub = subRows[0];
    if (sub.assigned_mobile !== mobile) return json({ error: 'forbidden' }, 403);

    // Look up new prison exchange details
    const prisonRes = await sb(
      `prison_did_lookup?prison_name=eq.${encodeURIComponent(new_prison_name)}&limit=1`
    );
    let prison = {};
    if (prisonRes.ok) {
      const prisonRows = await prisonRes.json();
      if (prisonRows.length) prison = prisonRows[0];
    }

    // Insert transfer order
    const order = {
      order_type: 'TRANSFER',
      parent_order_id: sub.id,
      old_did_number: sub.current_did,
      customer_name: sub.customer_name,
      customer_mobile: sub.assigned_mobile,
      customer_email: sub.customer_email,
      assigned_mobile: sub.assigned_mobile || null,
      prison_name: new_prison_name,
      prison_state: new_prison_state,
      primary_exchange: prison.primary_exchange_code || null,
      fallback_1: prison.fallback_1 || null,
      fallback_2: prison.fallback_2 || null,
      fallback_3: prison.fallback_3 || null,
      plan_interval: sub.plan_interval,
      plan_price: sub.plan_price,
      addon_48hr_cancel: sub.addon_48hr_cancel,
      addon_transfers: sub.addon_transfers,
      addon_post_renewal: sub.addon_post_renewal,
      addon_combo23: sub.addon_combo23,
      has_lifetime_protection: sub.has_lifetime_protection,
      order_date: new Date().toISOString(),
      stripe_subscription_id: sub.stripe_subscription_id,
      stripe_customer_id: sub.stripe_customer_id,
      status: 'PENDING',
    };

    const orderRes = await sb('orders', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify(order),
    });
    if (!orderRes.ok) {
      const err = await orderRes.text();
      console.error('Transfer order insert failed:', err);
      return json({ error: 'db_error' }, 500);
    }

    // Update subscription status
    await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ status: 'TRANSFER_PENDING', updated_at: new Date().toISOString() }),
    });

    // STUB: admin SMS
    console.log(
      `TRANSFER ADMIN SMS STUB — To: Guness + Dinisha — TRANSFER ORDER: ${sub.customer_name} / ${sub.prison_name} -> ${new_prison_name} / ${new_prison_state} / DID: ${sub.current_did} / Mobile: ${sub.assigned_mobile} / Exchange: ${prison.primary_exchange_code || '-'} / Fallbacks: ${prison.fallback_1 || '-'} > ${prison.fallback_2 || '-'} > ${prison.fallback_3 || '-'}`
    );

    return json({ success: true });
  }

  // ── cancel-subscription ──────────────────────────────────────────────────
  if (action === 'cancel-subscription') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const mobile = session.mobile;

    const { subscription_id } = body;
    if (!subscription_id) return json({ error: 'missing_fields' }, 400);

    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&limit=1`);
    if (!subRes.ok) return json({ error: 'db_error' }, 500);
    const subRows = await subRes.json();
    if (!subRows.length) return json({ error: 'not_found' }, 404);
    const sub = subRows[0];
    if (sub.assigned_mobile !== mobile) return json({ error: 'forbidden' }, 403);

    // Call Seal API to cancel the subscription
    const sealId = parseInt(sub.seal_subscription_id, 10);
    const sealRes = await sealApi(env, '/subscription', {
      method: 'PUT',
      body: JSON.stringify({ id: sealId, action: 'cancel' }),
    });
    if (!sealRes.ok) {
      const sealErr = await sealRes.text();
      console.error('Seal cancel error:', sealErr);
      return json({ error: 'seal_cancel_failed' }, 502);
    }

    // Mark CANCELLATION_PENDING in Supabase — WF4 (subscription/cancelled webhook) flips to CANCELLED
    await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELLATION_PENDING', updated_at: new Date().toISOString() }),
    });

    return json({ ok: true });
  }

  // ── logout ───────────────────────────────────────────────────────────────
  if (action === 'logout') {
    const clearCookie = [
      'pc_session=',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ].join('; ');
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie,
      },
    });
  }

  // ── dev-bypass ───────────────────────────────────────────────────────────
  if (action === 'dev-bypass') {
    const sb2 = makeSb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const activeRes = await sb2(`subscriptions?status=eq.ACTIVE&limit=1&select=assigned_mobile,stripe_customer_id,customer_email`);
    let sessionPayload;

    if (activeRes.ok) {
      const rows = await activeRes.json();
      if (rows.length) {
        const row = rows[0];
        sessionPayload = JSON.stringify({
          mobile: row.assigned_mobile,
          stripe_customer_id: row.stripe_customer_id || '',
          email: row.customer_email || '',
        });
      }
    }

    if (!sessionPayload) {
      sessionPayload = JSON.stringify({
        mobile: '0400000001',
        stripe_customer_id: 'cus_test',
        email: 'test@prisoncall.com.au',
      });
    }

    const cookieHeader = [
      `pc_session=${encodeURIComponent(sessionPayload)}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=2592000',
    ].join('; ');

    return new Response(JSON.stringify({ success: true, redirect: '/portal/dashboard.html' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader,
      },
    });
  }

  // ─── get-seal-data ──────────────────────────────────────────────────────────
  if (action === 'get-seal-data') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const { subscription_id } = body;
    if (!subscription_id) return json({ error: 'missing_fields' }, 400);

    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&select=seal_subscription_id,customer_email,assigned_mobile&limit=1`);
    const subData = await subRes.json();
    const sub = Array.isArray(subData) ? subData[0] : null;
    if (!sub || sub.assigned_mobile !== session.mobile) return json({ error: 'forbidden' }, 403);

    const sealRes = await sealApi(env, `/subscriptions?customer_email=${encodeURIComponent(sub.customer_email)}&includes=subscription_line_items`);
    if (!sealRes.ok) return json({ error: 'seal_fetch_failed' }, 502);
    const sealData = await sealRes.json();
    const subscriptions = sealData.subscriptions || sealData || [];
    const sealSub = subscriptions.find(s => String(s.id) === String(sub.seal_subscription_id));
    if (!sealSub) return json({ error: 'seal_sub_not_found' }, 404);

    return json({
      ok: true,
      next_billing_date: sealSub.next_billing_date || sealSub.next_billing_at || null,
      delivery_interval: sealSub.delivery_interval || null,
      billing_interval: sealSub.billing_interval || null,
      status: sealSub.status || null,
    });
  }

  // ─── update-payment-method ─────────────────────────────────────────────────
  if (action === 'update-payment-method') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const { subscription_id } = body;
    if (!subscription_id) return json({ error: 'missing_fields' }, 400);

    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&select=seal_subscription_id,assigned_mobile&limit=1`);
    const subData = await subRes.json();
    const sub = Array.isArray(subData) ? subData[0] : null;
    if (!sub || sub.assigned_mobile !== session.mobile) return json({ error: 'forbidden' }, 403);

    const sealId = parseInt(sub.seal_subscription_id, 10);
    const sealRes = await sealApi(env, '/subscription', {
      method: 'PUT',
      body: JSON.stringify({ id: sealId, action: 'send_payment_method_update_email' }),
    });
    if (!sealRes.ok) {
      const sealErr = await sealRes.text();
      console.error('Seal payment update error:', sealErr);
      return json({ error: 'seal_email_failed' }, 502);
    }
    return json({ ok: true, message: 'We\'ve sent a payment update link to your email. Check your inbox.' });
  }

  // ─── change-plan ────────────────────────────────────────────────────────────
  if (action === 'change-plan') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const { subscription_id, target_interval } = body;
    if (!subscription_id || !target_interval) return json({ error: 'missing_fields' }, 400);
    if (!['fortnightly', 'monthly', 'halfyearly'].includes(target_interval)) return json({ error: 'invalid_interval' }, 400);

    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&select=seal_subscription_id,customer_email,assigned_mobile&limit=1`);
    const subData = await subRes.json();
    const sub = Array.isArray(subData) ? subData[0] : null;
    if (!sub || sub.assigned_mobile !== session.mobile) return json({ error: 'forbidden' }, 403);

    const sealId = parseInt(sub.seal_subscription_id, 10);

    // Step 1: GET current subscription to find current line item ID and variant
    const getRes = await sealApi(env, `/subscriptions?customer_email=${encodeURIComponent(sub.customer_email)}&includes=subscription_line_items`);
    if (!getRes.ok) return json({ error: 'seal_fetch_failed' }, 502);
    const getData = await getRes.json();
    const subscriptions = getData.subscriptions || getData || [];
    const sealSub = subscriptions.find(s => String(s.id) === String(sub.seal_subscription_id));
    if (!sealSub) return json({ error: 'seal_sub_not_found' }, 404);

    const lineItems = sealSub.subscription_line_items || sealSub.line_items || [];
    if (!lineItems.length) return json({ error: 'no_line_items' }, 422);

    // Find the main subscription line item (exclude one-time add-ons)
    const mainItem = lineItems.find(li => !li.one_time && li.variant_id && VARIANT_TIER_MAP[String(li.variant_id)]);
    if (!mainItem) return json({ error: 'cannot_determine_tier' }, 422);

    const currentVariantId = String(mainItem.variant_id);
    const tierInfo = VARIANT_TIER_MAP[currentVariantId];
    if (!tierInfo) return json({ error: 'unknown_variant' }, 422);

    if (tierInfo.interval === target_interval) return json({ error: 'already_on_this_plan' }, 400);

    const newVariant = VARIANT_BY_INTERVAL[target_interval][tierInfo.tier];
    if (!newVariant) return json({ error: 'target_variant_not_found' }, 422);

    // Step 2: Remove current main line item
    const removeRes = await sealApi(env, '/subscription', {
      method: 'PUT',
      body: JSON.stringify({ id: sealId, action: 'remove_items', remove_items: [mainItem.id] }),
    });
    if (!removeRes.ok) {
      console.error('Seal remove_items error:', await removeRes.text());
      return json({ error: 'seal_remove_failed' }, 502);
    }

    // Step 3: Add new line item for target interval + same tier
    const addRes = await sealApi(env, '/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        id: sealId,
        action: 'add_items',
        add_items: [{
          product_id: newVariant.product_id,
          variant_id: newVariant.variant_id,
          quantity: '1',
          title: newVariant.title,
          price: newVariant.price,
          taxable: 0,
          requires_shipping: 0,
          one_time: 0,
        }],
      }),
    });
    if (!addRes.ok) {
      console.error('Seal add_items error:', await addRes.text());
      return json({ error: 'seal_add_failed' }, 502);
    }

    // Step 4: Update billing interval
    const intervalEdit = SEAL_INTERVAL_EDIT[target_interval];
    const editRes = await sealApi(env, '/subscription', {
      method: 'PUT',
      body: JSON.stringify({ id: sealId, action: 'edit', edit: intervalEdit }),
    });
    if (!editRes.ok) {
      console.error('Seal edit interval error:', await editRes.text());
      return json({ error: 'seal_edit_failed' }, 502);
    }

    // WF6 (subscription/updated webhook) will sync Supabase automatically
    return json({ ok: true, new_interval: target_interval, new_price: newVariant.price, new_title: newVariant.title });
  }

  // ─── pay-now ──────────────────────────────────────────────────────────────────
  if (action === 'pay-now') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);

    const { seal_subscription_id } = body;
    if (!seal_subscription_id) return json({ error: 'missing_fields' }, 400);

    // Fetch subscription from Supabase — verify ownership and status server-side
    const subRes = await sb(
      `subscriptions?seal_subscription_id=eq.${encodeURIComponent(seal_subscription_id)}&select=assigned_mobile,status,latest_billing_attempt_id&limit=1`
    );
    if (!subRes.ok) return json({ error: 'db_error' }, 500);
    const subData = await subRes.json();
    const sub = Array.isArray(subData) ? subData[0] : null;

    if (!sub || sub.assigned_mobile !== session.mobile) return json({ ok: false, error: 'Not found' }, 404);
    if (sub.status !== 'PAUSED') return json({ ok: false, error: 'Subscription is not paused' }, 400);

    // Call Seal subscription-process-charge — billing_attempt_id read from Supabase, not from client
    const sealRes = await fetch(
      `https://seal-subscriptions.com/api/v1/subscriptions/${seal_subscription_id}/subscription-process-charge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Seal-Api-Token': env.SEAL_API_TOKEN,
        },
        body: JSON.stringify({ billing_attempt_id: sub.latest_billing_attempt_id || '' }),
      }
    );

    if (!sealRes.ok) {
      const errText = await sealRes.text().catch(() => '');
      console.error('Seal process-charge error', sealRes.status, errText);
      return json({ ok: false, error: `Payment processor error (${sealRes.status})` }, 502);
    }

    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
}
