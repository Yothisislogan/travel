# The GoWild relay

**What it fixes:** the dashboard could never show live GoWild seats, only tell
you where to go look for them. The relay makes seats appear *on the page*, on
your phone, on cellular, with nothing running at home.

## Why a relay is needed at all

Frontier publishes everything we want — `isGoWildFareEnabled`, `goWildFare`,
`goWildFareSeatsRemaining` — inside the HTML of its own search page, no login
required. Two separate walls stop this app from reading it:

| Who asks | What happens |
|----------|--------------|
| Your phone's browser (the dashboard) | The request goes out fine, but `booking.flyfrontier.com` sends no `Access-Control-Allow-Origin` header, so the browser refuses to let the page read the response. **CORS.** |
| GitHub Actions (the Pages build) | Bot protection blocks datacenter IPs. **No CORS problem, but no data either.** |
| Your laptop at home (`node src/cli.js sync`) | Works — it's a normal request from a residential connection, and not a browser. |

So the missing piece is *a non-browser HTTP client that Frontier answers*. The
relay is exactly that, and nothing more: ~100 lines that fetch the page, parse
the GoWild fields, and answer with CORS headers so the dashboard can read it.

## Deploy it (Cloudflare Workers, free tier)

```bash
npm i -g wrangler
wrangler login
wrangler deploy          # prints https://gowild-relay.<you>.workers.dev
```

Open the dashboard → **Set up one-tap live seats** → paste that URL → **Test** →
**Save**. Press **↻ check now**. Seat counts land in the seats card and in the
outbound/hop route cards. The URL is remembered in that browser; to set it on
another device, open the dashboard as `…/?relay=https://gowild-relay.you.workers.dev`.

### Anywhere else

`src/worker.js` is a standard `export default { fetch }` handler, so it also runs
on Deno Deploy or Vercel Edge unchanged — and as a plain Node server on any box
that stays on (a Pi, a NAS, an old laptop):

```bash
node src/worker.js        # serves on :8788
```

## What it will and won't do

- **Only Frontier.** The only URL it ever fetches is
  `booking.flyfrontier.com/Flight/InternalSelect`, built from a 3-letter airport
  code and an ISO date. Anything else in `?pairs=` is dropped, so it can't be
  used as an open proxy (there's a test for this).
- **At most 8 route pairs per call**, and the dashboard calls it **one pair at a
  time**. That paces the hits on Frontier, and keeps each Worker invocation to a
  single fetch and a single parse — Cloudflare's free tier caps CPU *per
  invocation*, and parsing Frontier's ~600 KB page eight times in one request
  would exceed it.
- **Caches 5 minutes**, so repeated taps don't re-hit Frontier.
- **Fails honestly.** `status` is `live`, `no-data` (page returned, no fare
  payload — usually a layout change), `blocked` (bot protection), or
  `unreachable`. The dashboard shows which, rather than an empty list.
- Automated access sits outside Frontier's ToS. This is personal-scale: your own
  routes, your own trip, a handful of requests when you tap the button. There is
  no proxy rotation or challenge-solving here, and there shouldn't be.

## API

```
GET /health
GET /seats?pairs=LAS-SFO,RIC-LAS&date=2026-08-19
```

```json
{
  "ok": true, "date": "2026-08-19", "checkedAt": "…", "live": 1, "blocked": false,
  "results": [{
    "pair": "LAS-SFO", "status": "live", "gowildFlights": 2, "seatsTotal": 4,
    "cheapestFare": 9.11,
    "flights": [{ "flightNumber": "F9999", "departure": "…", "goWildFare": 9.11, "goWildSeatsRemaining": 1 }],
    "url": "https://booking.flyfrontier.com/Flight/InternalSelect?…"
  }]
}
```

## If you'd rather not host anything

- **`node src/cli.js phone`** prints an 8-action iPhone Shortcut that does the
  same fetch from the phone itself. Shortcuts isn't a browser, so CORS doesn't
  apply, and your phone's connection isn't blocked. One tap from the home
  screen; nothing hosted, nothing running.
- **`node src/cli.js publish --install`** registers a background job (launchd on
  macOS, systemd on Linux) that syncs from your home machine every 30 minutes
  and pushes the result, so the phone dashboard is simply fresh when you open it.
- **Tap a “check fares ↗” link.** Frontier opens prefilled and shows the GoWild
  fare itself. Zero setup, always works — you just read it there.
