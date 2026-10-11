/**
 * admin-supabase.js — API client, page init, shared utilities
 * All data goes through /api/admin-api (Cloudflare Pages Function)
 */

import { getSession, getAccessToken, clearSession, redirectToLogin } from './admin-auth.js';

const API_URL = '/api/admin-api';

// ── Core API function ──────────────────────────────────────

export async function api(action, params = {}) {
  const token = getAccessToken();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token, params }),
  });

  if (res.status === 401) {
    redirectToLogin('session-expired');
    throw new Error('Session expired');
  }

  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.data;
}

// ── Page initialisation ────────────────────────────────────

/**
 * Call at the top of every protected page.
 * Verifies session server-side, sets up nav + user display.
 * @param {string} [requiredRole] - 'super_admin' to gate a page
 * @returns {object} { user, role }
 */
export async function initAdminPage(requiredRole = null) {
  const session = getSession();
  if (!session?.access_token) {
    redirectToLogin();
    return null;
  }

  let result;
  try {
    result = await api('verify-session');
  } catch {
    redirectToLogin('session-expired');
    return null;
  }

  const { user, role } = result;

  // Role guard
  if (requiredRole === 'super_admin' && role !== 'super_admin') {
    window.location.replace('/admin/subscribers.html');
    return null;
  }

  // Populate user email in sidebar
  const emailEl = document.getElementById('userEmail');
  if (emailEl) emailEl.textContent = user?.email || '';

  // Hide settings link for non-super_admin
  if (role !== 'super_admin') {
    document.querySelectorAll('[data-super-only]').forEach(el => el.remove());
  }

  // Active sidebar link
  const page = window.location.pathname.split('/').pop().replace('.html','');
  document.querySelectorAll('.sidebar-link').forEach(link => {
    const linkPage = link.dataset.page;
    if (linkPage && page.startsWith(linkPage)) link.classList.add('active');
  });

  // Sidebar toggle (mobile)
  const hamburger = document.getElementById('hamburger');
  const sidebar   = document.getElementById('sidebar');
  const overlay   = document.getElementById('sidebarOverlay');
  const close     = document.getElementById('sidebarClose');

  function openSidebar()  { sidebar?.classList.add('open'); overlay?.classList.add('open'); }
  function closeSidebar() { sidebar?.classList.remove('open'); overlay?.classList.remove('open'); }

  hamburger?.addEventListener('click', openSidebar);
  overlay?.addEventListener('click', closeSidebar);
  close?.addEventListener('click', closeSidebar);

  // Logout
  document.getElementById('btnLogout')?.addEventListener('click', () => {
    clearSession();
    window.location.href = '/admin/login.html';
  });

  return { user, role };
}

// ── Formatters ─────────────────────────────────────────────

/** 61XXXXXXXXX → 0X XXXX XXXX (landline) or 04XX XXX XXX (mobile) */
export function formatDID(did) {
  if (!did) return '—';
  const d = String(did).replace(/\D/g,'');
  let local = d;
  if (d.length === 11 && d.startsWith('61')) local = '0' + d.slice(2);
  if (local.length !== 10) return did;
  if (local.startsWith('04')) return `${local.slice(0,4)} ${local.slice(4,7)} ${local.slice(7)}`;
  return `${local.slice(0,2)} ${local.slice(2,6)} ${local.slice(6)}`;
}

/** Any mobile → 04XX XXX XXX */
export function formatMobile(mobile) {
  if (!mobile) return '—';
  const m = String(mobile).replace(/\D/g,'');
  let local = m;
  if (m.length === 11 && m.startsWith('61')) local = '0' + m.slice(2);
  if (local.length === 10 && local.startsWith('04')) {
    return `${local.slice(0,4)} ${local.slice(4,7)} ${local.slice(7)}`;
  }
  return mobile;
}

/** ISO date → "2 Sep 2026" */
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
}

/** ISO date → "2 Sep 2026, 10:23 am" */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' })
    + ', ' + d.toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true });
}

/** Derive VoipLine PBX name: "FirstName LastName SealID" */
export function derivePBXName(sub) {
  if (!sub) return '—';
  const parts = (sub.customer_name || '').trim().split(/\s+/);
  const first = parts[0] || '';
  const last  = parts.slice(1).join(' ');
  const seal  = sub.seal_subscription_id || '';
  return [first, last, seal].filter(Boolean).join(' ');
}

/** Status → CSS class suffix */
export function statusClass(status) {
  const map = {
    'PENDING': 'pending', 'ACTIVE': 'active',
    'PAUSED': 'paused', 'CANCELLED': 'cancelled',
    'WINDOW_OPEN': 'window-open', 'COMPLETED': 'completed',
  };
  return map[(status||'').toUpperCase()] || 'pending';
}

/** Status → human label */
export function statusLabel(status) {
  const map = {
    'PENDING': 'Pending', 'ACTIVE': 'Active',
    'PAUSED': 'Paused', 'CANCELLED': 'Cancelled',
    'WINDOW_OPEN': 'Window Open', 'COMPLETED': 'Completed',
  };
  return map[(status||'').toUpperCase()] || status || 'Unknown';
}

export function statusPill(status) {
  return `<span class="status-pill status-pill--${statusClass(status)}">${statusLabel(status)}</span>`;
}

// ── Toast ──────────────────────────────────────────────────

let toastWrap = null;

export function showToast(message, type = 'success', duration = 3500) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-container';
    document.body.appendChild(toastWrap);
  }
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = message;
  toastWrap.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// ── Clipboard copy helper ──────────────────────────────────

export function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
  }).catch(() => showToast('Could not copy — please copy manually.', 'error'));
}

// ── DID validation ─────────────────────────────────────────

export function validateDID(val) {
  const clean = String(val).replace(/\D/g,'');
  return clean.length === 11 && clean.startsWith('61');
}

// ── HTML escape ────────────────────────────────────────────

export function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
