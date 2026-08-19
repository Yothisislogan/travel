# GoWild Trip Agent

A personal travel agent for one specific mission: fly **RIC (preferred) or ORF (backup) → Las Vegas → San Francisco → back to the east coast** on a **Frontier GoWild! all-you-can-fly pass**, with a ranked backup plan (cash fares + airline miles) in case you get stuck on the west coast, and a return planner that combines **flights, Amtrak, intercity buses, and local transit**, sorted by **travel time first, then cost**.

Zero dependencies - Node.js 18+ is all you need. Nothing polls in the background: **data syncs only when you ask** (a CLI command or a dashboard Refresh button).

**Start with [TRIP-PLAYBOOK.md](TRIP-PLAYBOOK.md)** - the researched strategy for this exact trip: which connections exist, the days they run, the LAS→IAD trick home, and the stuck-out-west decision tree.

## Quick start

```bash
node src/cli.js status      # trip overview, data freshness, booking windows
node src/cli.js sync        # refresh all live data on request
node src/cli.js dashboard   # web UI at http://localhost:8787
```

## The trip, command by command

| Step | Command | What it does |
|------|---------|--------------|
| 1. Get to Vegas | `node src/cli.js outbound` | GoWild paths RIC/ORF → LAS with booking-window status and prefilled Frontier search links |
| 2. Vegas → Bay Area | `node src/cli.js hop` | GoWild paths LAS → SFO/OAK/SJC |
| 3. Come home | `node src/cli.js return --from SFO` | Every way east - GoWild, cash flights, miles, Amtrak, bus, mixed - ranked by total time, then cost |
| Stuck out west? | `node src/cli.js backup --from LAS` | Cash fares and miles options across airlines, cheapest first, with positioning tips |
| Where to stay | `node src/cli.js hotels --city vegas` | Vegas MGM Rewards + Caesars Rewards properties (public + member rate, resort fee, booking link); `--city sf` for Priceline Express Deals by star tier |
| Live seats on your phone | `node src/cli.js phone` | An 8-action iPhone Shortcut that checks real GoWild seat counts from the phone itself — see [docs/RELAY.md](docs/RELAY.md) for the hosted alternative |

Useful flags:

```bash
node src/cli.js return --from SFO --sort cost      # cheapest first instead of fastest
node src/cli.js return --from LAS --to RIC         # Richmond arrivals only
node src/cli.js outbound --from ORF --date 2026-09-03
node src/cli.js sync --section frontier,amtrak     # refresh just some sections
```

## How GoWild tracking works (and its honest limits)

GoWild fares are **capacity-controlled and normally bookable starting the day before domestic departure** (Eastern time; community reports put inventory release around midnight ET), so "tracking availability" means:

**Live seat counts always show their age.** GoWild inventory turns over in minutes, so a bare "live" badge on a capture from this morning is worse than no badge — every live count is labelled `live · 12m`, and past an hour it becomes `4h old — recheck`. Counts are resolved **per segment**, so a nonstop's availability never decorates a connection through another city, and a connection is only marked confirmed when every one of its segments was actually searched.

1. The agent knows the **booking window**: for any date it tells you exactly when GoWild booking opens and whether you can book *right now* (`status` and every GoWild view show this). If your pass promo grants advance booking (e.g. the 2026 Fall & Winter purchase-by-Aug-17 promo allowed booking through Jan 4, 2027 for an early-booking fee), set `gowild.promoAdvanceBookingThrough` in `trip.config.json` and the agent treats those dates as bookable now.
2. It knows the **Frontier route map** (`src/data/frontier-routes.json`, refreshed on `sync`) and computes nonstop + one-connection GoWild paths for each leg - including **day-of-week checks**: RIC's Frontier flights run ~Thu/Sun only, and the agent flags any path that does not operate on your chosen date.
3. It flags **blackout dates** from `src/data/gowild.json` (2026 calendar; conservative VERIFY placeholders for early 2027). Since 2026, Frontier sells a Peak Day Charge ($79-$159) that unlocks blackout dates.
4. It generates **prefilled Frontier search links** for every pair you need to check, and links the community trackers (**GoWilder**, **WildFares**) that watch GoWild seat availability in real time. Frontier's booking site sits behind bot protection and requires your logged-in GoWild account to show pass fares, so no self-hosted tool can reliably confirm the final fare - the agent gets you one click away with everything precomputed.

`sync` probes Frontier reachability and refreshes a checklist of pair-searches for the next bookable day; the dashboard renders it with live/seed/stale badges.

**Connection reality check:** Frontier only sells connections its own system builds for published city pairs - never assume two GoWild segments will combine, and prefer same-itinerary connections: a self-built misconnect onto a 2x-weekly route can strand you for days.

## Live data sources (all optional, all sync-on-request)

| Section | Live source | Without it |
|---------|-------------|------------|
| Frontier GoWild | **Live seat counts** parsed from Frontier's own search response (`goWildFareSeatsRemaining`, no login needed) for this trip's route pairs - the same source 1491 Club/GoWilder poll at scale; see [docs/API-OPTIONS.md](docs/API-OPTIONS.md) | Seed route map + prefilled links + community trackers |
| Backup cash fares | 1st choice: [SerpAPI](https://serpapi.com) Google Flights (all carriers). Fallback: [Amadeus Self-Service](https://developers.amadeus.com) free tier - **caveat: excludes AA/Delta/Southwest/Breeze** | Seed price ranges + Google Flights/Kayak links |
| Award (miles) | [Seats.aero Partner API](https://seats.aero) key and/or the [Apify flight-award-scraper](https://apify.com/igolaizola/flight-award-scraper) (`APIFY_TOKEN`) — set either or both in `.env`; results merge, cheapest wins | Seed miles estimates + program search links |
| Amtrak | [Amtraker](https://amtraker.com) live train status - free, no key | Seed schedules/fares |
| Intercity bus | (no stable public API) | Seed estimates + FlixBus/Greyhound links |
| Hotels | [SerpAPI](https://serpapi.com) `google_hotels` for live public rates (reuses `SERPAPI_KEY`) | Seed nightly ranges + member/express booking links. MGM Rewards / Caesars Rewards member rates and Priceline Express opaque rates are captured by booking through the linked source (logged in) — like GoWild, they aren't in any public API |

```bash
cp .env.example .env   # then add any keys you have
```

## Return planner details

The planner builds a multimodal graph - GoWild nonstops (both directions of the route map), single-ticket backup flights, award flights (cheapest program per market), Amtrak long-distance legs (California Zephyr, Southwest Chief, Cardinal, Chicago→DC, Northeast Regional), intercity buses, and local transfers (BART, Metro, FlyAway, rideshares) - then searches all combinations up to 5 legs from your west coast location to Richmond or Norfolk.

- **Sorting**: itineraries that actually *operate* on your date come first — a 2×/week chain that doesn't run that day is not a faster option, it's not an option — then total travel time, then cost (`--sort cost` flips the last two). Award miles are valued at 1.3¢/mile so miles itineraries rank fairly against cash.
- **Dates that move with you**: each leg is stamped with the day you actually reach it, so the booking link for the last bus of a 55-hour chain is for the day you board it, not the day you left. Itineraries report their **arrival date** (`arrive Sun Aug 23 (+3 days)`), and a live price fetched for the start date is downgraded to its estimate range on any leg you board later — fares climb toward departure, so a stale price is always the cheap-looking one.
- **Blackout dates are priced, not ignored**: since 2026 a blackout isn't a wall, it's a Peak Day Charge ($79–$159/segment). The planner adds it, so blackout itineraries stop winning the cost sort by pretending to be $30.
- **Transfer buffers**: 2h between separately booked flights, 1.5h air↔ground, 1h ground↔ground, 30m around local transit. Overnight waits between separately booked legs are *not* modeled - a 52h Zephyr ride is 52h of scheduled travel, but your actual door-to-door depends on departure times.
- **Mode diversity**: even when flights sweep the top of the list, the best train-based and bus-based itineraries are always included, so you can see the "no-fly" fallback at a glance.

## Tuning

- `trip.config.json` - home airports, acceptable east coast arrivals, max legs/results, allowed modes, staleness threshold.
- `src/data/frontier-routes.json` - the Frontier route map. **Frontier changes routes seasonally**; update this when `sync` or your own checking shows changes.
- `src/data/backup-flights.json` - backup markets, airlines, price/miles estimates.
- `src/data/ground.json` - train/bus legs, durations, fares.
- `src/data/sources.json` - live endpoints and deep-link templates (editable without touching code).

## Phone kit: serverless dashboard on GitHub Pages

For mid-trip use with no computer and no server, the repo also ships a **static dashboard** (`site/index.html`) served by one GitHub Action:

1. **Enable Pages once**: repo Settings → Pages → Source: **GitHub Actions**. The `pages` workflow **builds `site/data.json` fresh, then deploys `site/`**, giving you a URL that works on your phone.
2. **Sync on request** = rebuild + redeploy. The dashboard's **Sync** button (or Actions → *pages* → *Run workflow*) triggers `pages` as a `workflow_dispatch`, which runs a full live provider sync using your repo **Secrets** (put SERPAPI_KEY etc. in Settings → Secrets → Actions), regenerates `data.json`, and redeploys. Ordinary code pushes rebuild with **seed data only** (no paid API calls), so routine pushes never burn your SerpAPI quota. `data.json` is **generated at deploy time, never committed** — that's deliberate: a committed 600 KB single-line file was getting corrupted by branch merges.
3. **Live GoWild seats on the phone — deploy the relay once.** Frontier publishes GoWild fares and seat counts on its own search page without a login, but a browser can't read another site's response (no CORS) and GitHub's build servers get bot-blocked. So something has to make that request for you. [`src/worker.js`](src/worker.js) is that something — ~100 lines on Cloudflare Workers' free tier:

   ```bash
   npm i -g wrangler && wrangler login
   wrangler deploy      # prints https://gowild-relay.<you>.workers.dev
   ```

   Paste the URL into the dashboard under **Set up one-tap live seats**, press **↻ check now**, and real seat counts land in the seats card and in every route card — on cellular, on any device, with nothing running at home. Full details, including why it only ever talks to Frontier and why the dashboard calls it one route at a time, are in [docs/RELAY.md](docs/RELAY.md).

   Don't want to host anything?
   - **`node src/cli.js phone`** prints an 8-action **iPhone Shortcut** that makes the same request from the phone itself. Shortcuts isn't a browser, so CORS doesn't apply. One tap from the home screen, nothing hosted.
   - **`node src/cli.js publish --install`** registers a background job (launchd/systemd) that syncs from your home connection every 30 minutes and pushes the result, so the dashboard is just fresh when you open it. (`publish` alone does it once; `--watch` runs it in the foreground.)
   - **Tap a "check fares ↗" link** — Frontier opens prefilled and shows the fare itself. Zero setup, always works.
   - **`node src/cli.js dashboard`** binds all interfaces and prints a LAN address, so a phone on the same Wi-Fi gets a live-seats button with no relay at all.

   A bookmarklet is still included as an optional extra, but it only works in desktop Chrome — Safari and Firefox block `javascript:` bookmarklets on pages with a Content-Security-Policy, which Frontier sends.

The static page renders precomputed views (outbound/hop over a rolling 10-day window, return plans from SFO/LAS both sorts, backup plans, hotels) and reads its same-origin `data.json`. Amtrak live status refreshes directly in the browser (Amtraker's API allows it). If the dashboard moves to a different fork, update the `OWNER`/`REPO`/`BRANCH` constants at the top of `site/index.html`.

## Tests

```bash
npm test
```

## Caveats

- **A blocked refresh never deletes good data.** Frontier blocking a datacenter IP is the expected outcome, not an exception, so a failed sync keeps the last live payload and marks it `stale` with its capture time instead of overwriting it with seed estimates. `publish` merges over the previous publish for the same reason — an unattended `--watch` run that got blocked can't wipe the seats off your phone.
- Seed prices/durations are planning estimates, not quotes. Anything tagged `[estimate]` should be verified through the provided links before you rely on it; anything tagged `[live]` came from an API on your last `sync`.
- GoWild fine print changes program-year to program-year (blackouts, fees, booking windows). `src/data/gowild.json` records what the agent assumes; verify against your pass's current terms.
