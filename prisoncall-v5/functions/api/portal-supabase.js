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
    const activeRes = await sb2(`subscriptions?status=eq.ACTIVE&limit=1&select=assigned_mobile,seal_subscription_id,customer_email`);
    let sessionPayload;

    if (activeRes.ok) {
      const rows = await activeRes.json();
      if (rows.length) {
        const row = rows[0];
        sessionPayload = JSON.stringify({
          mobile: row.assigned_mobile,
          seal_subscription_id: row.seal_subscription_id || '',
          email: row.customer_email || '',
        });
      }
    }

    if (!sessionPayload) {
      sessionPayload = JSON.stringify({
        mobile: '0400000001',
        seal_subscription_id: '',
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
