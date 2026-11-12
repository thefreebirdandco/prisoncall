/* POST /api/submit-transfer
   Body: { did, currentPrison, newPrison, newPrisonState, mobile, currentState, seal_subscription_id }
   Looks up the active subscription by DID. Lifetime Protection inserts
   PENDING_VOIPLINE / payment_status NOT_REQUIRED and texts admins.
   Otherwise inserts PENDING_PAYMENT / payment_status PENDING_PAYMENT,
   skips admin SMS, and returns { success: false, payment_required: true, transfer_id }.
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
  const bodySealSubId  = (body.seal_subscription_id || '').toString().trim();

  if (!did || !currentPrison || !newPrison || !mobile) {
    return jsonResponse({ success: false, error: 'Missing required fields' });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: 'Server misconfiguration' });
  }

  /* ── Look up subscription_id, customer_name, seal_subscription_id by DID ─ */
  let subscriptionId = null;
  let customerName   = '';
  let sealSubId      = bodySealSubId;
  let hasLifetimeProtection = false;
  try {
    const e164 = toE164(did);
    const subUrl = SUPABASE_URL + '/rest/v1/subscriptions?current_did=eq.' +
      encodeURIComponent(e164) + '&status=eq.ACTIVE&select=id,customer_name,seal_subscription_id,has_lifetime_protection&limit=1';
    const subRes = await fetch(subUrl, {
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
    });
    if (subRes.ok) {
      const subRows = await subRes.json();
      if (Array.isArray(subRows) && subRows[0]) {
        subscriptionId = subRows[0].id;
        customerName   = subRows[0].customer_name        || '';
        sealSubId      = subRows[0].seal_subscription_id || bodySealSubId;
        hasLifetimeProtection = subRows[0].has_lifetime_protection === true;
      }
    }
  } catch {
    /* non-fatal — insert will proceed with subscription_id null and no lifetime protection */
    hasLifetimeProtection = false;
  }

  const payload = {
    subscription_id:      subscriptionId,   /* FK — null if DID lookup failed */
    old_did:              did,
    old_prison_name:      currentPrison,
    new_prison_name:      newPrison,
    new_prison_state:     newPrisonState || null,
    assigned_mobile:      mobile,
    seal_subscription_id: bodySealSubId,
    status:               hasLifetimeProtection ? 'PENDING_VOIPLINE' : 'PENDING_PAYMENT',
    payment_status:       hasLifetimeProtection ? 'NOT_REQUIRED' : 'PENDING_PAYMENT',
  };

  try {
    /* Clear an abandoned payment row so this mobile + plan starts fresh. */
    const deleteUrl = SUPABASE_URL + '/rest/v1/transfers?assigned_mobile=eq.' +
      encodeURIComponent(mobile) + '&seal_subscription_id=eq.' + encodeURIComponent(bodySealSubId);
    const delRes = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer:        'return=minimal',
      },
    });
    if (!delRes.ok) {
      let detail = '';
      try { const d = await delRes.json(); detail = d.message || d.error || ''; } catch {}
      return jsonResponse({ success: false, error: detail || 'Insert failed' });
    }

    const res = await fetch(SUPABASE_URL + '/rest/v1/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer:        'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = '';
      try { const d = await res.json(); detail = d.message || d.error || ''; } catch {}
      return jsonResponse({ success: false, error: detail || 'Insert failed' });
    }

    const inserted = await res.json().catch(() => null);
    const transferId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;

    if (!hasLifetimeProtection) {
      return jsonResponse({ success: false, payment_required: true, transfer_id: transferId });
    }

    /* ── Admin SMS — non-blocking via context.waitUntil ──────────────────── */
    const twilioSid  = env.TWILIO_ACCOUNT_SID;
    const twilioAuth = env.TWILIO_AUTH_TOKEN;
    const twilioFrom = env.TWILIO_SMS_NUMBER;
    const smsBody    = `TRANSFER REQUEST - Seal ID: ${sealSubId}. ${customerName}. Prison: ${newPrison} (${newPrisonState.toUpperCase()}). Log in to admin portal to action.`;
    context.waitUntil(
      Promise.all(['+61413598815', '+61422749601'].map(to =>
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(`${twilioSid}:${twilioAuth}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: twilioFrom, To: to, Body: smsBody }),
        })
      ))
    );

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
