/**
 * Serves the survey page for ANY /survey/... path so the trailing segment can
 * carry the traffic source:  /survey/instagram, /survey/newsletter,
 * /survey/creator-machonacho, and so on. The page reads it from location.pathname.
 *
 * WHY A FUNCTION AND NOT A _redirects RULE:
 * Cloudflare Pages automatically strips ".html" from URLs. A rule pointing at
 * /survey.html therefore bounces to /survey, which the rule rewrites back to
 * /survey.html, forever. Verified: 50 redirects then failure. Pointing a
 * /survey/* rule at /survey/index.html loops for the same reason and wrangler
 * discards the rule outright.
 *
 * The source file is /survey-form.html, deliberately NOT under /survey/, because
 * Pages canonicalises /survey/index.html to /survey/ and ASSETS.fetch returns
 * that 308 instead of the file. A name outside the /survey/ tree returns the
 * body directly.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/survey-form';   // extensionless: Pages 308s any .html path
  const res = await context.env.ASSETS.fetch(new Request(url, context.request));
  // Fresh copy so we can guarantee the content type and stop any caching of
  // one source's page being served to another.
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}
