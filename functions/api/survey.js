/**
 * POST /api/survey
 *
 * Captures the two post-signup survey answers against an existing Loops contact.
 *
 * WHY THIS EXISTS: Loops' public newsletter-form endpoint can only update
 * `userGroup` on a contact that already exists. Any other custom property sent
 * to it is silently discarded while still returning success:true. Since the
 * waitlist form creates the contact first, the survey answers have to go
 * through the authenticated Contacts API instead, which needs a key, which
 * cannot live in client-side JavaScript. Hence this server-side function.
 *
 * SAFETY: this endpoint is entirely additive. It never touches the waitlist
 * form's own POST to app.loops.so, which runs first and independently. If this
 * function is missing, broken, or erroring, the waitlist keeps working exactly
 * as it does today.
 *
 * SETUP REQUIRED (one time, in the Cloudflare dashboard):
 *   Workers & Pages -> openmote.io Pages project -> Settings -> Variables and
 *   Secrets -> add LOOPS_API_KEY, value = the Loops API key, marked Encrypt.
 */

/** Traffic-source label. Allowlisted so hostile input cannot reach the dashboard. */
function cleanSource(v) {
  if (typeof v !== 'string') return 'signup';
  const c = v.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  return c || 'signup';
}

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequestPost(context) {
  // Stamped once, at the moment the answer arrives, and passed to the dashboard
  // so it can reject an older write that lands after a newer one. Survey writes
  // fire on selection AND on completion, so out-of-order delivery is normal.
  const surveyAt = Date.now();
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }

  const { email, skuPreference, willingnessToPay, surveySource } = payload || {};

  // Validate before spending a Loops call. A malformed email would otherwise
  // create a junk contact, since /contacts/update upserts.
  if (!email || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: 'invalid email' }, 400);
  }
  if (!['board', 'assembled'].includes(skuPreference)) {
    return json({ ok: false, error: 'invalid skuPreference' }, 400);
  }
  // Price is OPTIONAL. Step one is written the moment it is answered, so
  // someone who picks a version and then closes the tab is still counted.
  let wtp = null;
  if (willingnessToPay != null && willingnessToPay !== '') {
    const n = Number(willingnessToPay);
    if (!Number.isFinite(n) || n < 19 || n > 199) {
      return json({ ok: false, error: 'invalid willingnessToPay' }, 400);
    }
    wtp = n;
  }

  const key = context.env.LOOPS_API_KEY;
  if (!key) return json({ ok: false, error: 'not configured' }, 503);

  const send = () =>
    fetch('https://app.loops.so/api/v1/contacts/update', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      // /contacts/update upserts on email, so a repeat submission overwrites
      // the same record rather than duplicating it.
      body: JSON.stringify({
        email,
        skuPreference,
        ...(wtp === null ? {} : { willingnessToPay: wtp }),
        // Free-form so new channels (instagram, tiktok, a creator's link) can be
        // added by changing a URL, with no code or schema change.
        // Allowlist, not just truncation. This value is rendered in the
        // dashboard, so anything outside [a-z0-9._-] must never survive.
        surveySource: cleanSource(surveySource),
      }),
    });

  let res = await send();
  // Loops allows 10 req/sec per team. One retry covers an unlucky burst.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1200));
    res = await send();
  }

  // Tell the dashboard directly rather than waiting on a Loops webhook.
  // Loops fires contact.created but evidently not contact.updated, so relying
  // on it silently lost every survey answer. This path is not optional.
  if (res.ok && context.env.DASH_WEBHOOK_URL && context.env.DASH_WEBHOOK_SECRET) {
    context.waitUntil(
      fetch(
        `${context.env.DASH_WEBHOOK_URL}?s=${encodeURIComponent(context.env.DASH_WEBHOOK_SECRET)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventName: 'contact.updated',
            contact: {
              email,
              surveyAt,
              skuPreference,
              ...(wtp === null ? {} : { willingnessToPay: wtp }),
              // Allowlist, not just truncation. This value is rendered in the
        // dashboard, so anything outside [a-z0-9._-] must never survive.
        surveySource: cleanSource(surveySource),
            },
          }),
        }
      ).catch(() => {})
    );
  }

  return json({ ok: res.ok }, res.ok ? 200 : 502);
}
