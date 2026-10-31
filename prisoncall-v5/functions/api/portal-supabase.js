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

function positiveInt(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function sealRequestHeaders(env) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Seal-Token': String(env.SEAL_API_TOKEN || '').trim(),
  };
}

// Seal 301s some routes onto a trailing slash. Workers would follow that
// redirect as GET and drop the PUT body, so follow it manually and keep the method.
async function sealFetch(env, path, opts = {}) {
  const headers = sealRequestHeaders(env);
  if (!headers['X-Seal-Token']) {
    return new Response(JSON.stringify({ error: 'missing_seal_token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const init = {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: 'manual',
  };
  let res = await fetch(`${SEAL_API}${path}`, init);
  if ([301, 302, 307, 308].includes(res.status)) {
    const location = res.headers.get('Location');
    if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
    if (location) {
      const nextUrl = new URL(location, `${SEAL_API}${path}`);
      res = await fetch(nextUrl, init);
    }
  }
  return res;
}

function pickBillingAttemptId(attempts, preferred) {
  const list = Array.isArray(attempts) ? attempts : [];
  const withId = list
    .map((attempt) => ({ attempt, id: positiveInt(attempt && attempt.id) }))
    .filter((entry) => entry.id);
  if (preferred && withId.some((entry) => entry.id === preferred)) return preferred;
  const failed = withId.find(({ attempt }) => {
    const status = String(attempt.status || '').toLowerCase();
    return attempt.error_code || status.includes('fail') || status.includes('error');
  });
  if (failed) return failed.id;
  const open = withId.find(({ attempt }) => {
    const status = String(attempt.status || '').toLowerCase();
    return status !== 'completed' && !attempt.completed_at;
  });
  if (open) return open.id;
  return preferred;
}

async function findSealSubscription(env, candidates) {
  const ids = candidates.filter(Boolean);
  for (const id of ids) {
    const res = await sealFetch(env, `/subscription/?id=${id}`);
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    const payload = data && data.success ? data.payload : null;
    if (!payload) continue;
    const payloadIds = [positiveInt(payload.id), positiveInt(payload.internal_id)];
    if (payloadIds.some((payloadId) => ids.includes(payloadId))) return payload;
  }
  return null;
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

  // ── get-pending-transfer ─────────────────────────────────────────────────
  if (action === 'get-pending-transfer') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);

    // session.mobile is E.164 no-plus (61xxxxxxxxx); transfers.assigned_mobile
    // is local 10-digit (0xxxxxxxxx) — normalise before querying.
    const rawMobile   = session.mobile || '';
    const localMobile = rawMobile.startsWith('61') ? '0' + rawMobile.slice(2) : rawMobile;

    const res = await sb(
      `transfers?assigned_mobile=eq.${encodeURIComponent(localMobile)}&status=in.(PENDING_VOIPLINE,CANCELLATION_REQUESTED)&order=created_at.desc&limit=1`
    );
    if (!res.ok) return json(null);
    const rows = await res.json();
    return json(Array.isArray(rows) && rows[0] ? rows[0] : null);
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

    const subRes = await sb(
      `subscriptions?id=eq.${encodeURIComponent(subscription_id)}&status=in.(ACTIVE,PAUSED)&select=seal_subscription_id,assigned_mobile,status&limit=1`
    );
    if (!subRes.ok) return json({ error: 'db_error' }, 500);
    const subData = await subRes.json();
    const sub = Array.isArray(subData) ? subData[0] : null;
    if (!sub || sub.assigned_mobile !== session.mobile) return json({ error: 'forbidden' }, 403);
    if (sub.status !== 'ACTIVE' && sub.status !== 'PAUSED') return json({ error: 'forbidden' }, 403);

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

    // Fetch subscription from Supabase — verify ownership and status server-side.
    // seal_subscription_id is the short Plan ID; Seal's charge API needs the
    // subscription id from seal_id (not the internal id) and a numeric billing attempt.
    const subRes = await sb(
      `subscriptions?seal_subscription_id=eq.${encodeURIComponent(seal_subscription_id)}&select=assigned_mobile,status,latest_billing_attempt_id,seal_subscription_id,seal_id&limit=1`
    );
    if (!subRes.ok) {
      const dbText = await subRes.text().catch(() => '');
      console.error('pay-now supabase error', subRes.status, dbText.slice(0, 300));
      return json({ error: 'db_error' }, 500);
    }
    const subData = await subRes.json();
    const sub = Array.isArray(subData) ? subData[0] : null;

    if (!sub || sub.assigned_mobile !== session.mobile) return json({ ok: false, error: 'Not found' }, 404);
    if (sub.status !== 'PAUSED') return json({ ok: false, error: 'Subscription is not paused' }, 400);

    try {
      const candidates = [positiveInt(sub.seal_id), positiveInt(sub.seal_subscription_id)];
      const payload = await findSealSubscription(env, candidates);
      const subscriptionId = payload
        ? positiveInt(payload.id)
        : (candidates[0] || candidates[1]);
      const billingAttemptId = pickBillingAttemptId(
        payload && payload.billing_attempts,
        positiveInt(sub.latest_billing_attempt_id)
      );

      if (!subscriptionId || !billingAttemptId) {
        return json({ ok: false, error: 'No outstanding charge was found for this plan.' }, 409);
      }

      const sealRes = await sealFetch(env, '/subscription-process-charge/', {
        method: 'PUT',
        body: JSON.stringify({
          subscription_id: subscriptionId,
          billing_attempt_id: billingAttemptId,
        }),
      });

      if (!sealRes.ok) {
        const errText = await sealRes.text().catch(() => '');
        console.error('Seal process-charge error', sealRes.status, errText.slice(0, 500));
        return json({ ok: false, error: `Payment processor error (${sealRes.status})` }, 502);
      }

      return json({ ok: true });
    } catch (err) {
      console.error('pay-now failed', err && err.message);
      return json({ ok: false, error: 'Payment processor error' }, 502);
    }
  }

  // ── cancel-transfer-request ──────────────────────────────────────────────
  if (action === 'cancel-transfer-request') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);

    // session.mobile is E.164 no-plus (61xxxxxxxxx); transfers.assigned_mobile
    // is local 10-digit (0xxxxxxxxx) — normalise before comparing.
    const rawMobile   = session.mobile || '';
    const localMobile = rawMobile.startsWith('61') ? '0' + rawMobile.slice(2) : rawMobile;

    const { transfer_id } = body;
    if (!transfer_id) return json({ error: 'missing_fields' }, 400);

    // Fetch transfer and verify it belongs to this customer
    const trRes = await sb(`transfers?id=eq.${encodeURIComponent(transfer_id)}&limit=1`);
    if (!trRes.ok) return json({ error: 'db_error' }, 500);
    const trRows = await trRes.json();
    if (!trRows.length) return json({ error: 'not_found' }, 404);
    const transfer = trRows[0];
    if (transfer.assigned_mobile !== localMobile) return json({ error: 'forbidden' }, 403);
    if (transfer.status !== 'PENDING_VOIPLINE') return json({ error: 'invalid_status' }, 400);

    // PATCH transfer to CANCELLATION_REQUESTED
    await sb(`transfers?id=eq.${encodeURIComponent(transfer_id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ status: 'CANCELLATION_REQUESTED', updated_at: new Date().toISOString() }),
    });

    // Look up customer name for SMS (subscriptions.assigned_mobile is E.164)
    const subRes = await sb(`subscriptions?assigned_mobile=eq.${encodeURIComponent(rawMobile)}&select=customer_name&limit=1`);
    const subRows = await subRes.json();
    const customerName = (Array.isArray(subRows) && subRows[0]?.customer_name) || rawMobile;

    // Admin SMS
    const twilioSid  = env.TWILIO_ACCOUNT_SID;
    const twilioAuth = env.TWILIO_AUTH_TOKEN;
    const twilioFrom = env.TWILIO_SMS_NUMBER;
    const prisonInfo = (transfer.new_prison_name || '') + (transfer.new_prison_state ? ' (' + transfer.new_prison_state + ')' : '');
    const smsBody = `TRANSFER CANCELLATION REQUESTED - ${customerName} has requested to cancel their transfer to ${prisonInfo}. Log in to admin portal to action.`;

    await Promise.all(['+61413598815', '+61422749601'].map(to =>
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${twilioSid}:${twilioAuth}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: twilioFrom, To: to, Body: smsBody }),
      })
    ));

    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
}
