/**
 * GET /api/check-session
 *
 * Reads the HttpOnly pc_session cookie set by /api/get-session.
 * Returns { authenticated: true, mobile: '04•• ••• XXX' } if the cookie
 * is present and valid, or { authenticated: false } otherwise.
 *
 * Used by all pages to check login state and update their header CTA.
 * Because the cookie is HttpOnly, JavaScript cannot read it directly —
 * pages must call this endpoint instead.
 */
export async function onRequestGet(context) {
  const { request } = context;

  const cookieHeader = request.headers.get('Cookie') || '';
  const rawValue     = parseCookie(cookieHeader, 'pc_session');

  function json(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!rawValue) {
    return json({ authenticated: false });
  }

  let session;
  try {
    session = JSON.parse(decodeURIComponent(rawValue));
  } catch (_) {
    return json({ authenticated: false });
  }

  if (!session || !session.mobile) {
    return json({ authenticated: false });
  }

  return json({
    authenticated: true,
    mobile:        maskMobile(session.mobile),
  });
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function parseCookie(header, name) {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function maskMobile(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length < 3) return raw || '';
  return '04\u2022\u2022 \u2022\u2022\u2022 ' + digits.slice(-3);
}
