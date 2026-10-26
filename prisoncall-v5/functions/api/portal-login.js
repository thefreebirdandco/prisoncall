/**
 * POST /api/portal-login
 *
 * Two modes controlled by the request body:
 *
 *   { mobile, check_only: true }
 *     — Verify a Prisoncall subscription exists for this mobile.
 *       Returns { found: true } or 404. Does NOT set a cookie.
 *       Called before /send-otp so the customer sees "no account found"
 *       before an OTP is ever dispatched.
 *
 *   { mobile }
 *     — Same look-up, then sets the pc_session HttpOnly cookie and
 *       returns { success: true }. Called after /verify-otp succeeds.
 *
 * mobile accepted as E.164 no-plus (61XXXXXXXXX) or local (04XXXXXXXXX).
 * Subscriptions are queried without a status filter so customers whose
 * number is still being set up (PENDING / DID_ORDERED / ACTIVATING) can
 * also reach their portal.
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
  }

  /* ── Parse body ───────────────────────────────────────────────────────── */
  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'invalid_body' }, 400);
  }

  /* ── Normalise mobile to E.164 no-plus ───────────────────────────────── */
  let mobile = (body.mobile || '').replace(/\D/g, '');
  if (/^04\d{8}$/.test(mobile)) mobile = '61' + mobile.slice(1);
  if (!/^61\d{9}$/.test(mobile)) {
    return json({ error: 'invalid_mobile' }, 400);
  }

  /* ── Look up subscription ─────────────────────────────────────────────── */
  let subRows;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?assigned_mobile=eq.${encodeURIComponent(mobile)}` +
      `&order=created_at.desc&limit=1` +
      `&select=seal_subscription_id,customer_email`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey:        SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!res.ok) return json({ error: 'db_error' }, 500);
    subRows = await res.json();
  } catch (_) {
    return json({ error: 'db_error' }, 500);
  }

  if (!Array.isArray(subRows) || !subRows.length) {
    return json({ error: 'not_found' }, 404);
  }

  /* ── check_only mode — confirm existence, no cookie ──────────────────── */
  if (body.check_only) {
    return json({ found: true });
  }

  /* ── Full mode — set pc_session cookie ───────────────────────────────── */
  const sub = subRows[0];
  const sessionPayload = JSON.stringify({
    mobile,
    seal_subscription_id: sub.seal_subscription_id || '',
    email:                sub.customer_email       || '',
  });
  const cookieHeader = [
    `pc_session=${encodeURIComponent(sessionPayload)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=2592000',   // 30 days
  ].join('; ');

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader,
    },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
