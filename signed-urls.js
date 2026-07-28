// ----------------------------- Signed file URLs -----------------------------
// The storage bucket is private, so file URLs bypassing RLS is no longer
// possible — every access needs a short-lived signed URL minted on demand.
//
// The awkwardness this module exists to absorb: createSignedUrl() is async, but
// every render site in app.js is a synchronous template string. So instead of
// signing during render, templates emit a placeholder:
//
//     <img data-signed-path="attachments/1753...-photo.jpg">
//
// and hydrate() fills in `src` afterwards, batching every placeholder on the
// page into one request. Signed URLs are cached so re-renders (which happen
// constantly) don't re-sign the same file over and over.

const EXPIRES_IN = 3600;               // ask Supabase for 1 hour
const REFRESH_AFTER = 55 * 60 * 1000;  // treat as stale at 55 min, so no in-flight
                                       // URL is ever close to expiring

const cache = new Map();               // path -> { url, staleAt }

function cached(path) {
  const hit = cache.get(path);
  return hit && hit.staleAt > Date.now() ? hit.url : null;
}

function cloud() {
  return globalThis.__TRAVELER_CLOUD__ || null;
}

/**
 * Sign a batch of paths, using the cache where possible.
 * Returns { [path]: url } containing only those that succeeded.
 */
async function signBatch(paths) {
  const out = {};
  const need = [];
  for (const p of paths) {
    if (!p) continue;
    const hit = cached(p);
    if (hit) out[p] = hit;
    else if (!need.includes(p)) need.push(p);
  }
  if (!need.length) return out;

  const cl = cloud();
  if (!cl?.signedUrls) return out;   // local mode: nothing to sign

  let signed;
  try {
    signed = await cl.signedUrls(need, EXPIRES_IN);
  } catch (err) {
    console.warn('Could not sign file URLs:', err);
    return out;
  }
  const staleAt = Date.now() + REFRESH_AFTER;
  for (const [path, url] of Object.entries(signed)) {
    cache.set(path, { url, staleAt });
    out[path] = url;
  }
  return out;
}

/** One path, for click-time use (downloads). Returns null if unavailable. */
export async function resolveSigned(path) {
  if (!path) return null;
  const map = await signBatch([path]);
  return map[path] || null;
}

/**
 * Fill in every unresolved [data-signed-path] under `root`. Safe to call after
 * every render — elements are new each time, so nothing is double-processed, and
 * cached paths resolve without a network request.
 */
export async function hydrateSigned(root) {
  const scope = root || document;
  const els = [...scope.querySelectorAll('[data-signed-path]')]
    .filter((el) => !el.dataset.signedDone && el.dataset.signedPath);
  if (!els.length) return;

  // Mark immediately so a re-render mid-flight doesn't queue duplicates.
  els.forEach((el) => { el.dataset.signedDone = 'pending'; });

  const map = await signBatch(els.map((el) => el.dataset.signedPath));

  for (const el of els) {
    const url = map[el.dataset.signedPath];
    if (!url) {
      el.dataset.signedDone = 'error';
      el.setAttribute('title', 'This file could not be loaded. It may have been removed.');
      el.classList.add('signed-missing');
      continue;
    }
    if (el.tagName === 'IMG') el.src = url;
    else el.href = url;
    el.dataset.signedDone = 'ok';
  }
}

/**
 * Best available href for an attachment, in preference order:
 *   1. data:  base64 embedded by the local desktop version (pre-cloud imports)
 *   2. path:  in the private bucket — signed on demand
 *   3. url:   an external link (Google Drive), or a legacy public-bucket URL
 */
export async function attachmentHref(item) {
  if (!item) return null;
  if (item.data) return item.data;
  if (item.path) {
    const signed = await resolveSigned(item.path);
    if (signed) return signed;
  }
  return item.url || null;
}

/** Clear the cache — used after sign-out so URLs don't outlive the session. */
export function clearSignedCache() {
  cache.clear();
}
