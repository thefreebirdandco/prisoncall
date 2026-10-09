export async function onRequestPost(context) {
  const { env, request } = context;

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function sb(path, opts = {}) {
    return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation',
      },
      body: opts.body,
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid_body' }, 400);
  }

  const mobile = (body.mobile || '').replace(/\D/g, '');

  /* Accept E.164 no-plus (61XXXXXXXXX — 11 digits) — matches Supabase assigned_mobile storage format */
  if (!/^61\d{9}$/.test(mobile)) {
    return json({ error: 'invalid_mobile' }, 400);
  }

  // Look up mobile in subscriptions (assigned_mobile stored as E.164 no-plus)
  const subRes = await sb(
    `subscriptions?assigned_mobile=eq.${encodeURIComponent(mobile)}&limit=1&select=id,assigned_mobile`
  );
  if (!subRes.ok) {
    return json({ error: 'db_error' }, 500);
  }
  const subRows = await subRes.json();
  if (!subRows.length) {
    return json({ error: 'not_found' }, 404);
  }

  // Ensure magic_links table exists
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS magic_links (
      id uuid primary key default uuid_generate_v4(),
      mobile text not null,
      token text unique not null,
      expires_at timestamptz not null,
      used boolean default false,
      created_at timestamptz default now()
    )
  `;
  await sb('rpc/query', {
    method: 'POST',
    body: JSON.stringify({ query: createTableSQL }),
  }).catch(() => {
    // Table likely already exists — ignore error
  });

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const insertRes = await sb('magic_links', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify({ mobile, token, expires_at: expiresAt, used: false }),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    console.error('magic_links insert failed:', errText);
    return json({ error: 'db_error' }, 500);
  }

  const verifyUrl = `https://prisoncall.pages.dev/portal/verify?token=${token}`;

  // STUB: Twilio not called — log only
  console.log(
    `MAGIC LINK SMS STUB — To: ${mobile} — Message: Your Prisoncall sign-in link: ${verifyUrl} — Expires in 15 minutes.`
  );
  console.log(`VERIFY URL: ${verifyUrl}`);

  return json({ success: true });
}
