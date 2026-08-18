// GoWild relay - a ~100-line edge function that makes live seats work on the
// phone with nothing installed and no computer running at home.
//
// Why this exists: Frontier serves GoWild fares and seat counts to a normal
// browser request, but (a) a browser can't read the response cross-origin (no
// CORS headers on booking.flyfrontier.com) and (b) GitHub's build runners get
// bot-blocked. The relay sits in the middle: it makes the request server-side
// and answers with CORS headers, so the dashboard fetches it straight from your
// phone, on cellular, anywhere.
//
// Deploy anywhere that runs `fetch` handlers - Cloudflare Workers, Deno Deploy,
// Vercel Edge - or run it as a plain Node server on any always-on box you
// already have (`node src/worker.js`). See docs/RELAY.md.
//
// Deliberately NOT an open proxy: it only ever talks to Frontier's own search
// URL, only for 3-letter airport codes and ISO dates, max 8 pairs per call,
// with a 5-minute cache so repeated taps don't hammer Frontier.
import { searchURL, parseGowildFlights, summarizeGowild } from './gowild-parse.js';

const MAX_PAIRS = 8;
const CACHE_SECONDS = 300;
const CODE = /^[A-Z]{3}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Mimic a real browser; a bare fetch() UA gets challenged immediately.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${CACHE_SECONDS}`, ...CORS },
  });

// "RIC-LAS,LAS-SFO" -> [['RIC','LAS'], ['LAS','SFO']], rejecting anything else.
export function parsePairs(raw) {
  const pairs = [];
  for (const chunk of String(raw ?? '').split(',')) {
    const [o, d] = chunk.trim().toUpperCase().split('-');
    if (!CODE.test(o ?? '') || !CODE.test(d ?? '') || o === d) continue;
    if (!pairs.some((p) => p[0] === o && p[1] === d)) pairs.push([o, d]);
  }
  return pairs.slice(0, MAX_PAIRS);
}

async function checkPair(origin, dest, date) {
  const url = searchURL(origin, dest, date);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) return { pair: `${origin}-${dest}`, status: 'blocked', httpStatus: res.status, url };
    const flights = parseGowildFlights(await res.text());
    if (!flights.length) return { pair: `${origin}-${dest}`, status: 'no-data', httpStatus: res.status, url };
    return { pair: `${origin}-${dest}`, status: 'live', httpStatus: res.status, url, ...summarizeGowild(flights) };
  } catch (err) {
    return { pair: `${origin}-${dest}`, status: 'unreachable', error: String(err?.message ?? err), url };
  }
}

export async function handle(request) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);

  if (url.pathname === '/' || url.pathname === '/health') {
    return json({ ok: true, service: 'gowild-relay', usage: '/seats?pairs=RIC-LAS,LAS-SFO&date=2026-08-19', maxPairs: MAX_PAIRS });
  }
  if (url.pathname !== '/seats') return json({ ok: false, error: 'not found' }, 404);

  const date = url.searchParams.get('date') ?? '';
  if (!ISO.test(date)) return json({ ok: false, error: 'date must be YYYY-MM-DD' }, 400);
  const pairs = parsePairs(url.searchParams.get('pairs') ?? `${url.searchParams.get('o') ?? ''}-${url.searchParams.get('d') ?? ''}`);
  if (!pairs.length) return json({ ok: false, error: 'pairs must look like RIC-LAS,LAS-SFO' }, 400);

  // Sequential, not parallel: this is one person checking their own trip, and a
  // burst of simultaneous hits is exactly what bot protection looks for.
  const results = [];
  for (const [o, d] of pairs) results.push(await checkPair(o, d, date));

  const live = results.filter((r) => r.status === 'live').length;
  return json({
    ok: true,
    date,
    checkedAt: new Date().toISOString(),
    live,
    blocked: results.some((r) => r.status === 'blocked'),
    results,
  });
}

export default { fetch: handle };

// Node fallback: `node src/worker.js` serves the same handler on :8788, so the
// relay can live on a Raspberry Pi, a NAS, or any box that stays on.
if (globalThis.process?.argv?.[1]?.endsWith('worker.js')) {
  const { createServer } = await import('node:http');
  const port = Number(process.env.PORT ?? 8788);
  createServer(async (req, res) => {
    const response = await handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  }).listen(port, '0.0.0.0', () => console.log(`GoWild relay on http://localhost:${port}  (try /seats?pairs=LAS-SFO&date=2026-08-19)`));
}
