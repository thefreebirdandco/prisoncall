/**
 * Prisoncall Admin API — Cloudflare Pages Function
 * Route: /api/admin-api
 *
 * All Supabase operations here. Service role key never leaves this file.
 * Request: POST { action, token, params }
 * Response: { data } | { error }
 *
 * Transfers use the orders table with order_type = 'TRANSFER'.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const BASE        = env.SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const AUTH_KEY    = env.SUPABASE_ANON_KEY || SERVICE_KEY;

  if (!BASE || !SERVICE_KEY) {
    return json({ error: 'Server configuration error: missing Supabase credentials' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { action, token, params = {} } = body;

  // ── Supabase REST helper (service role) ─────────────────
  async function sb(path, opts = {}) {
    const url = `${BASE}/rest/v1/${path}`;
    return fetch(url, {
      ...opts,
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
        ...(opts.headers || {}),
      },
    });
  }

  // ── Verify caller token ──────────────────────────────────
  async function verifyToken() {
    if (!token) return null;
    const r = await fetch(`${BASE}/auth/v1/user`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? u : null;
  }

  async function requireAuth() {
    const user = await verifyToken();
    if (!user) throw { status: 401, message: 'Unauthorized' };
    const role = user.user_metadata?.role || 'admin';
    return { user, role };
  }

  // ── Route ────────────────────────────────────────────────
  try {
    switch (action) {

      // ── Auth ───────────────────────────────────────────────
      case 'login': {
        const { email, password } = params;
        if (!email || !password) return json({ error: 'Email and password required' }, 400);

        const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'apikey': AUTH_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await r.json();

        if (!r.ok) {
          const msg = data.error_description || data.msg || 'Invalid email or password';
          return json({ error: msg }, 400);
        }

        return json({ data });
      }

      case 'verify-session': {
        const user = await verifyToken();
        if (!user) return json({ error: 'Invalid or expired session' }, 401);
        const role = user.user_metadata?.role || 'admin';
        return json({ data: { user, role } });
      }

      // ── Subscribers ────────────────────────────────────────
      case 'get-subscribers': {
        await requireAuth();
        const r = await sb('subscriptions?order=created_at.desc&select=*');
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || 'Query failed' }, 500);
        return json({ data });
      }

      case 'get-subscriber': {
        await requireAuth();
        const { id } = params;
        if (!id) return json({ error: 'id required' }, 400);

        const [subRes, txRes] = await Promise.all([
          sb(`subscriptions?id=eq.${id}&select=*&limit=1`),
          sb(`transfers?subscription_id=eq.${id}&order=created_at.desc&select=*`),
        ]);

        const [subs, transfers] = await Promise.all([subRes.json(), txRes.json()]);

        if (!subRes.ok) return json({ error: subs.message || 'Query failed' }, 500);

        const sub = Array.isArray(subs) ? subs[0] : null;
        if (!sub) return json({ error: 'Subscriber not found' }, 404);

        const lookup = await sb(`prison_did_lookup?prison_name=eq.${encodeURIComponent(sub.prison_name)}&select=primary_town&limit=1`);
        const lookupData = await lookup.json();
        const exchange = Array.isArray(lookupData) ? lookupData[0] : null;

        return json({ data: { subscriber: sub, transfers: Array.isArray(transfers) ? transfers : [], exchange } });
      }

      case 'update-subscriber': {
        const { role } = await requireAuth();
        const { id, ...updates } = params;
        if (!id) return json({ error: 'id required' }, 400);

        // Only permit safe columns
        const allowed = ['status', 'current_did', 'admin_notes', 'subscription_attributes', 'updated_at'];
        const patch = { updated_at: new Date().toISOString() };
        for (const key of allowed) {
          if (key in updates) patch[key] = updates[key];
        }

        const r = await sb(`subscriptions?id=eq.${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || 'Update failed' }, 500);
        return json({ data: Array.isArray(data) ? data[0] : data });
      }

      // ── Transfers (dedicated transfers table) ──────────────
      case 'get-transfers': {
        await requireAuth();
        // Join with subscriptions for customer_name and seal_subscription_id
        const r = await sb(
          'transfers?order=created_at.desc&select=*,subscriptions(customer_name,seal_subscription_id,customer_email)'
        );
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || 'Query failed' }, 500);
        return json({ data });
      }

      case 'update-transfer': {
        await requireAuth();
        const { id, ...updates } = params;
        if (!id) return json({ error: 'id required' }, 400);

        const allowed = ['new_did', 'status', 'fulfilled_at', 'window_expires_at', 'old_did_released_at', 'admin_notes'];
        const patch = { updated_at: new Date().toISOString() };
        for (const key of allowed) {
          if (key in updates) patch[key] = updates[key];
        }

        const r = await sb(`transfers?id=eq.${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || 'Update failed' }, 500);
        return json({ data: Array.isArray(data) ? data[0] : data });
      }

      // ── Prison DID Lookup ──────────────────────────────────
      case 'get-prison-lookup': {
        await requireAuth();
        const { prison_name } = params;
        if (!prison_name) return json({ error: 'prison_name required' }, 400);

        const r = await sb(`prison_did_lookup?prison_name=eq.${encodeURIComponent(prison_name)}&select=*&limit=1`);
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || 'Query failed' }, 500);
        return json({ data: Array.isArray(data) ? data[0] : null });
      }

      case 'replace-prison-lookup': {
        const { role } = await requireAuth();
        if (role !== 'super_admin') return json({ error: 'Forbidden' }, 403);

        const { rows } = params;
        if (!Array.isArray(rows) || !rows.length) return json({ error: 'rows array required' }, 400);

        // Delete all existing rows
        const del = await sb('prison_did_lookup?id=gte.0', { method: 'DELETE', headers: { 'Prefer': '' } });
        if (!del.ok && del.status !== 404) {
          // Try alternative delete (delete by truthy primary key)
          await sb('prison_did_lookup', { method: 'DELETE', headers: { 'Prefer': '' } });
        }

        // Insert new rows
        const ins = await sb('prison_did_lookup', {
          method: 'POST',
          body: JSON.stringify(rows),
          headers: { 'Prefer': 'return=minimal' },
        });

        if (!ins.ok) {
          const err = await ins.json().catch(() => ({}));
          return json({ error: err.message || 'Insert failed' }, 500);
        }

        return json({ data: { inserted: rows.length } });
      }

      // ── Fulfilment (delegates to n8n WF1b — no Supabase write here) ──
      case 'fulfil-subscriber': {
        await requireAuth();
        const { seal_subscription_id, did, customer_name, customer_email, customer_mobile, prison_name } = params;

        if (!seal_subscription_id || !did) {
          return json({ error: 'seal_subscription_id and did are required' }, 400);
        }

        // Server-side DID validation: exactly 11 digits, starts with 61
        const didClean = String(did).replace(/\D/g, '');
        if (didClean.length !== 11 || !didClean.startsWith('61')) {
          return json({ error: 'Invalid DID: must be exactly 11 digits starting with 61' }, 400);
        }

        // POST to n8n WF1b — WF1b owns all Supabase writes for fulfilment
        const n8nRes = await fetch('https://thefreebirdandco.app.n8n.cloud/webhook/prisoncall-fulfil', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seal_subscription_id: String(seal_subscription_id),
            did: didClean,
            customer_name:   customer_name   || '',
            customer_email:  customer_email  || '',
            customer_mobile: customer_mobile || '',
            prison_name:     prison_name     || '',
          }),
        });

        if (!n8nRes.ok) {
          const errText = await n8nRes.text().catch(() => 'n8n error');
          return json({ error: `Fulfilment service returned ${n8nRes.status}: ${errText}` }, 502);
        }

        return json({ data: { ok: true } });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    if (err?.status === 401) return json({ error: 'Unauthorized' }, 401);
    console.error('[admin-api] Error:', err);
    return json({ error: err?.message || 'Internal server error' }, 500);
  }
}
