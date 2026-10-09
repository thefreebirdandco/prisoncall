// handles GET /api/verify-magic-link?token=xxx
// /portal/verify is routed here via functions/portal/verify.js

const PAGE_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #F4F5F7; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px 16px;
  }
  .wrap { max-width: 400px; width: 100%; text-align: center; }
  .logo { height: 28px; width: auto; margin: 0 auto 32px; display: block; }
  .card {
    background: #fff; border: 1px solid #E5E5E5;
    border-radius: 16px; padding: 32px 28px;
  }
  h1 { font-size: 20px; font-weight: 800; color: #101010; margin-bottom: 12px; }
  p { font-size: 15px; color: #666; line-height: 1.5; margin-bottom: 24px; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    background: #00D258; color: #000; font-family: inherit;
    font-size: 15px; font-weight: 700; padding: 13px 28px;
    border-radius: 80px; text-decoration: none; border: none; cursor: pointer;
  }
  .btn:hover { opacity: 0.88; }
`;

const PAGE_FONTS = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700;800&display=swap" rel="stylesheet">
`;

function errorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} | Prisoncall</title>
${PAGE_FONTS}
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="wrap">
    <img src="/assets/brand_logos/Prisoncall_Black.svg" alt="Prisoncall" class="logo">
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
      <a href="/portal/login.html" class="btn">Request a new sign-in link</a>
    </div>
  </div>
</body>
</html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

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

  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  if (!token) {
    return htmlResponse(
      errorPage('Invalid link', 'This sign-in link is invalid. Please request a new one.')
    );
  }

  // Look up token
  const tokenRes = await sb(
    `magic_links?token=eq.${encodeURIComponent(token)}&limit=1`
  );
  if (!tokenRes.ok) {
    return htmlResponse(
      errorPage('Something went wrong', 'Unable to verify your link. Please try again.'),
      500
    );
  }
  const rows = await tokenRes.json();

  if (!rows.length) {
    return htmlResponse(
      errorPage('Invalid link', 'This sign-in link is invalid. Please request a new one.')
    );
  }

  const link = rows[0];

  if (link.used) {
    return htmlResponse(
      errorPage(
        'Link already used',
        'This sign-in link has already been used. Please request a new one.'
      )
    );
  }

  if (new Date(link.expires_at) < new Date()) {
    // Mark as used even if expired
    await sb(`magic_links?id=eq.${link.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ used: true }),
    });
    return htmlResponse(
      errorPage(
        'Link expired',
        'This sign-in link has expired. Sign-in links are valid for 15 minutes.'
      )
    );
  }

  // Valid — mark as used
  await sb(`magic_links?id=eq.${link.id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify({ used: true }),
  });

  // Look up customer in subscriptions
  const mobile = link.mobile;
  const subRes = await sb(
    `subscriptions?assigned_mobile=eq.${encodeURIComponent(mobile)}&limit=1&select=seal_subscription_id,customer_email,assigned_mobile`
  );
  let sealSubscriptionId = '';
  let email = '';
  if (subRes.ok) {
    const subRows = await subRes.json();
    if (subRows.length) {
      sealSubscriptionId = subRows[0].seal_subscription_id || '';
      email = subRows[0].customer_email || '';
    }
  }

  const sessionPayload = JSON.stringify({ mobile, seal_subscription_id: sealSubscriptionId, email });
  const cookieHeader = [
    `pc_session=${encodeURIComponent(sessionPayload)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=2592000',
  ].join('; ');

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/portal/dashboard.html',
      'Set-Cookie': cookieHeader,
    },
  });
}
