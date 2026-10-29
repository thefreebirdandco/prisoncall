/* POST /api/submit-transfer
   Body: { did, currentPrison, newPrison, newPrisonState, mobile, currentState }
   Inserts a row into the transfers table with status PENDING.
   Column mapping (transfers table):
     subscription_id  <- looked up from subscriptions by old_did (E.164 format)
     old_did          <- did (10-digit local, e.g. "0312345678")
     old_prison_name  <- currentPrison
     new_prison_name  <- newPrison
     new_prison_state <- newPrisonState ('vic' | 'nsw')
     assigned_mobile  <- mobile
     status           <- 'PENDING'
   n8n WF3 watches transfers for status = PENDING and sends the confirmation SMS.
   Returns { success: true } or { success: false, error }.
*/

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* Convert a 10-digit local DID to the 11-digit E.164 (no +) format used in
   the subscriptions table, e.g. "0312345678" → "61312345678".           */
function toE164(did) {
  const digits = did.replace(/\D/g, '');
  const withoutLeadingZero = digits.startsWith('0') ? digits.slice(1) : digits;
  return '61' + withoutLeadingZero;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body' });
  }

  const did            = (body.did            || '').replace(/\D/g, '');
  const currentPrison  = (body.currentPrison  || '').toString().trim();
  const newPrison      = (body.newPrison       || '').toString().trim();
  const newPrisonState = (body.newPrisonState  || body.currentState || '').toString().trim();
  const mobile         = (body.mobile          || '').replace(/\D/g, '');

  if (!did || !currentPrison || !newPrison || !mobile) {
    return jsonResponse({ success: false, error: 'Missing required fields' });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: 'Server misconfiguration' });
  }

  /* ── Look up subscription_id by DID (stored as E.164 "61xxx" in Supabase) ─ */
  let subscriptionId = null;
  try {
    const e164 = toE164(did);
    const subUrl = SUPABASE_URL + '/rest/v1/subscriptions?current_did=eq.' +
      encodeURIComponent(e164) + '&status=eq.ACTIVE&select=id&limit=1';
    const subRes = await fetch(subUrl, {
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
    });
    if (subRes.ok) {
      const subRows = await subRes.json();
      if (Array.isArray(subRows) && subRows[0]) subscriptionId = subRows[0].id;
    }
  } catch {
    /* non-fatal — insert will proceed with subscription_id null */
  }

  const payload = {
    subscription_id:  subscriptionId,   /* FK — null if DID lookup failed */
    old_did:          did,
    old_prison_name:  currentPrison,
    new_prison_name:  newPrison,
    new_prison_state: newPrisonState || null,
    assigned_mobile:  mobile,
    status:           'PENDING_VOIPLINE',
  };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer:        'return=minimal',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = '';
      try { const d = await res.json(); detail = d.message || d.error || ''; } catch {}
      return jsonResponse({ success: false, error: detail || 'Insert failed' });
    }

    return jsonResponse({ success: true });
  } catch {
    return jsonResponse({ success: false, error: 'Insert failed' });
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
