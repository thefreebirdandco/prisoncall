// GET  /api/check-existing-customer  — cookie-based (portal / silent recognition)
// POST /api/check-existing-customer  — body { mobile } (OTP-verified identity, sets pc_session cookie)
//
// Both return { recognised: true, stripe_customer_id } or { recognised: false }.
// Never throws — always returns valid JSON.

/* ── Shared Supabase query ──────────────────────────────────────────────────── */
async function querySupabase(env, mobile) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const res = await fetch(
    SUPABASE_URL + '/rest/v1/subscriptions?assigned_mobile=eq.'
    + encodeURIComponent(mobile) + '&status=eq.ACTIVE&limit=1',
    {
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer:        'return=representation',
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0];
}

/* ── Response helper ────────────────────────────────────────────────────────── */
function json(body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
  });
}

/* ── Cookie parser ──────────────────────────────────────────────────────────── */
function parseCookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/* ── GET — reads pc_session cookie (used by portal / legacy flows) ─────────── */
export async function onRequestGet(context) {
  const { env, request } = context;
  try {
    const cookieHeader = request.headers.get('Cookie') || '';
    const raw = parseCookieValue(cookieHeader, 'pc_session');
    if (!raw) return json({ recognised: false });

    let session;
    try { session = JSON.parse(raw); } catch (_) { return json({ recognised: false }); }
    if (!session || !session.mobile) return json({ recognised: false });

    const row = await querySupabase(env, session.mobile);
    if (!row) return json({ recognised: false });

    return json({ recognised: true, stripe_customer_id: row.stripe_customer_id || null });
  } catch (_) {
    return json({ recognised: false });
  }
}

/* ── POST — accepts { mobile } in request body (OTP-verified identity) ─────── *
 *  On success: sets pc_session HttpOnly cookie so portal and check-session
 *  work immediately without a separate login step.                              */
export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    let body;
    try { body = await request.json(); } catch (_) { return json({ recognised: false }); }

    let mobile = (body.mobile || '').toString().trim();

    /* Normalise E.164 → 04xxxxxxxxx */
    if (mobile.startsWith('+61')) mobile = '0' + mobile.slice(3);
    mobile = mobile.replace(/\D/g, '');

    if (!/^04\d{8}$/.test(mobile)) return json({ recognised: false });

    const row = await querySupabase(env, mobile);
    if (!row) return json({ recognised: false });

    /* Build pc_session cookie so the portal recognises this customer immediately */
    const cookiePayload = JSON.stringify({
      mobile,
      stripe_customer_id: row.stripe_customer_id || '',
      email:              row.customer_email   || '',
    });
    const cookieHeader =
      'pc_session=' + encodeURIComponent(cookiePayload)
      + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000';

    return json(
      { recognised: true, stripe_customer_id: row.stripe_customer_id || null },
      { 'Set-Cookie': cookieHeader }
    );
  } catch (_) {
    return json({ recognised: false });
  }
}
