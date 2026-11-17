// Which browser origins may call the API with credentials.
// Entries are exact origins ("https://loop.example.com") or patterns with one "*" standing for
// exactly one DNS label ("https://loop-final-*-gowtham.vercel.app" matches one preview host, never
// "evil.com/…" or "a.b.vercel.app"). There is no bare "*": credentials never go to any origin.

function patternToRegExp(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '[a-z0-9-]+');
  return new RegExp(`^${esc}$`, 'i');
}

function originAllowed(origin, allowed = []) {
  if (!origin || origin === 'null') return false;
  let normalised;
  try {
    const u = new URL(origin);
    if (u.origin.toLowerCase() !== origin.replace(/\/+$/, '').toLowerCase()) return false;   // reject paths, userinfo and odd forms
    normalised = u.origin;
  } catch { return false; }
  return allowed.some((entry) => (entry.includes('*') ? patternToRegExp(entry).test(normalised) : entry.toLowerCase() === normalised.toLowerCase()));
}

/** Host header(s) this request reached us under: Host, plus X-Forwarded-Host when a trusted proxy set it. */
function requestHosts(req, trustProxy) {
  const hosts = [req.get('host')];
  if (trustProxy) {
    const fwd = String(req.get('x-forwarded-host') || '').split(',').map((s) => s.trim()).filter(Boolean);
    hosts.push(...fwd);
  }
  return hosts.filter(Boolean).map((h) => h.toLowerCase());
}

module.exports = { originAllowed, requestHosts, patternToRegExp };
