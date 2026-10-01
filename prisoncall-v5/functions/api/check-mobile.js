/* POST /api/check-mobile
   Body: { did: "0312345678", mobile: "0412345678" }
   Verifies that the supplied mobile matches the account for the given DID.
   Returns { success: true } or { success: false }.
*/

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false });
  }

  const rawDid = (body.did    || '').replace(/\D/g, '');
  const did    = rawDid.startsWith('0') ? '61' + rawDid.slice(1) : rawDid;
  const mobile = (body.mobile || '').replace(/\D/g, '');

  if (!did || !mobile) {
    return jsonResponse({ success: false });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false });
  }

  try {
    const res = await fetch(
      SUPABASE_URL +
        '/rest/v1/subscriptions?current_did=eq.' +
        encodeURIComponent(did) +
        '&status=eq.ACTIVE&select=assigned_mobile&limit=1',
      {
        headers: {
          Authorization: 'Bearer ' + SUPABASE_KEY,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      return jsonResponse({ success: false });
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonResponse({ success: false });
    }

    const storedMobile = (rows[0].assigned_mobile || '').replace(/\D/g, '');
    return jsonResponse({ success: storedMobile === mobile });
  } catch {
    return jsonResponse({ success: false });
  }
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
