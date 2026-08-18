# Frontier / GoWild data: what APIs exist, and how the tracker sites do it

Researched 2026-08-17/18. Short version: **there is no official public API**, and every GoWild tracker - 1491 Club, GoWilder, WildFares, GoWander, the open-source scrapers - reads the same thing: **Frontier's own booking-search endpoint, which embeds GoWild availability in its response, no login required.**

## The endpoint everyone uses

```
GET https://booking.flyfrontier.com/Flight/InternalSelect?o1={ORIG}&d1={DEST}&dd1={Mon D, YYYY}&ADT=1&mon=true&promo=
```

The response embeds a JSON payload of `journeys[].flights[]`, and each flight carries:

| Field | Meaning |
|-------|---------|
| `isGoWildFareEnabled` | whether this flight has a GoWild fare right now |
| `goWildFare` | the GoWild price (typically ~$14.91 with taxes/fees - hence "1491 Club") |
| `goWildFareSeatsRemaining` | **live GoWild seat count** for the flight |

Notes: the `dd1` date is `'Aug 18, 2026'`-style, not ISO. Availability data is visible **anonymously**; you only need a logged-in GoWild account to actually *book*. This is confirmed by the open-source scrapers ([Frontier-GoWild-Search](https://github.com/CalebJiang-at/Frontier-GoWild-Search), [FlightFinder](https://github.com/DavidGracias/FlightFinder), [GWsearch](https://github.com/fly-metothemoon/GWsearch)) which parse exactly these fields with plain `requests` + BeautifulSoup and randomized 2-5s delays.

## How 1491 Club and friends work

[The 1491 Club](https://www.the1491club.com/) ($13.95/month) and the free peers ([GoWilder](https://www.gowilder.net/), WildFares, GoWander) run **server-side pollers** against that endpoint across all of Frontier's routes and the bookable date window, cache the results in their own database, and sell/serve a nice search UI on top ("see everywhere you can go from X"). Their real product is absorbing the operational pain for you:

- Frontier's site sits behind bot protection (press-and-hold challenges consistent with PerimeterX/HUMAN); scrapers report intermittent 403s and breakage.
- Polling every route × every day means thousands of requests/hour - they handle IP reputation, retries, and layout changes, and eat the ToS risk at commercial scale.
- Data lags reality by whatever their poll cycle is; the seat count you see on any tracker is minutes old at best.

## What this repo's agent does

`node src/cli.js sync --section frontier` hits the same endpoint **only for this trip's seven route pairs**, with 2-4s pacing and a hard stop at the first block, then shows per-flight GoWild fares and `goWildFareSeatsRemaining` in `outbound`/`hop` and the dashboard. When Frontier blocks the request (common from datacenter IPs, usually fine from a residential connection), it says so and falls back to prefilled search links.

**ToS caveat**: Frontier's terms don't welcome automated access. A handful of requests on demand for your own trip is the same footprint as you clicking the site, and it's what the community has done openly for years - but it isn't officially sanctioned, heavy polling can get an IP (not your account) blocked, and the page format can change without notice. This agent deliberately does no proxy rotation or challenge-solving; if you want route-wide alerting at scale, pay a tracker to do it.

## Every other API route, ranked by practicality

| Option | What you get | Catch |
|--------|--------------|-------|
| **This repo's built-in checker** | Live GoWild seats for your 7 pairs, on demand | Blocked sometimes; personal-use only |
| **1491 Club** ($13.95/mo) / GoWilder / WildFares | All-routes GoWild search + alerts, zero maintenance | Their poll lag; subscription |
| **SerpAPI / SearchApi google_flights** (free ~100/mo) | Live *cash* fares, all carriers incl. F9 revenue fares | Google Flights never shows GoWild fares |
| **Amadeus Self-Service** (free tier) | GDS cash fares | Excludes AA/DL/Southwest/Breeze and GoWild |
| **Paid scraper APIs** (Crawlbyte FlyFrontier, Apify actors, Bright Data) | Managed Frontier scraping incl. fare data | $; same ToS gray zone, outsourced |
| **AviationStack etc.** | Schedules/status (what the "Frontier Flight Radar"-style apps use) | No fares at all |
| **Frontier's official NDC API** (developer.flyfrontier.com) | Real API access | Accredited travel-trade partners only; revenue fares - not a hobbyist option |
| **Seats.aero** (Pro, ~$10/mo) | Award availability API across ~20 programs; best US-domestic fit | Miles backups only - no Frontier/GoWild |
| **FlixBus/Greyhound search API** (no key) | Live intercity bus fares — Greyhound runs on FlixBus's platform, so one free API covers both; wired into the bus legs | Unofficial front-end API; city UUIDs resolved via their autocomplete |
| **RapidAPI `priceline-com-provider`** (`RAPIDAPI_KEY`) | **Real Priceline Express Deals** — it's a passthrough to Priceline Partner Network's official `getExpress.Results`, so opaque rates are genuine | **Read-only**: no `Express.Book` endpoint, so you still book on priceline.com. Reseller-owned PPN credentials, high latency (~1.7–2.6s), listing last updated Jan 2024 |
| **Apify flight-award-scraper** (`APIFY_TOKEN`, usage-priced) | REST actor returning award miles/taxes/seats as JSON; wired into the app's awards provider as an optional/second source | Departures within ~60 days only; per-run cost; verify program coverage |
| **Award Travel Finder** ([MCP server](https://awardtravelfinder.com/mcp)) | Conversational award search in Claude/Cursor across 19 airlines / 14 programs; strong for international/premium | An MCP server for AI agents, not a REST API — best used from Claude directly, not baked into this app; US-domestic coverage is thinner |

The agent already integrates SerpAPI, Amadeus, Seats.aero, and Amtraker via `.env` keys (see README), and now the InternalSelect checker for GoWild itself.


## Amtrak fares: why they stay estimates

Amtrak publishes a GTFS schedule feed with **no fare data at all** (no `fare_attributes`, no GTFS-Fares v2), and routes all pricing through accredited intermediaries behind an accreditation process. Amtraker is status-only. Rome2Rio returns *modeled* estimates, not live fares.

The only endpoint that returns a real WAS→RVR price is Amtrak's own booking backend, which sits behind Akamai Bot Manager and requires replaying a browser session's cookies — and Amtrak's Terms of Use explicitly prohibit automated retrieval. **This app deliberately does not do that.** Train legs show researched fare ranges plus a prefilled booking link, and that's the honest ceiling for rail.

## Amtraker v3 field notes (verified against the server source, Aug 2026)

- `GET /v3/trains` returns an object keyed by train number; each value is an **array** of train objects (a route can have several instances running at once — distinguish by `trainID`, e.g. `6-14`).
- **`trainTimely`, `arrCmnt` and `depCmnt` are deprecated and always empty strings.** Parsing them for delay silently yields nothing.
- Authoritative delay, matching the API's own icon-colour math:
  `minutesLate = (Date.parse(arr || dep) - Date.parse(schArr || schDep)) / 60000`.
  Use `||`, not `??` — these fields are `""` rather than `null`.
- Timestamps are ISO-8601 with a station-local UTC offset, no milliseconds, no `Z` (e.g. `2026-09-07T14:50:00-05:00`), so `Date.parse` is timezone-safe.
- `arr`/`dep` are dual-purpose: an ETA while `status` is `Enroute`, the posted actual once `Station`/`Departed`, and the schedule for `Predeparture` trains (so a not-yet-departed train correctly reports zero delay).
- Blocked IPs are served a **poisoned payload** — a fake train `9997` / "Error Train" — instead of an HTTP error, so filter it.
- Every response sends `Access-Control-Allow-Origin: *`, but there is **no OPTIONS handler**, so browser requests must stay "simple": plain GET, no custom headers. (The static dashboard's in-browser refresh does exactly that.)
- There is also an undocumented per-station board: `GET /v3/stations/expanded/{code}`.

## Amtrak fares: how the estimates are modelled

No public fare API exists, so ranges in `ground.json` model Amtrak's bucket system instead of guessing from distance. Inventory opens ~11 months out at the lowest bucket and ratchets up as each sells out. Booking **0–7 days out almost always lands in the top buckets**: roughly **2.5–3x** the low bucket on short NEC pairs (WAS→RVR ~$26–31 low vs ~$70–95 walk-up) and **1.6–2.5x** on long-distance coach (EMY→CHI ~$210 low vs ~$306–640). Since 2026 the old Saver/Value/Flexible tiers collapsed into Value/Flex with more low-end buckets, so prices now move in smaller, more frequent steps.

**USA Rail Pass** ($499, 10 segments, 30 days, coach only): a connection burns a segment, so a transcon return via Chicago costs ~3 segments — about $500 for what point-to-point prices at ~$330–650. Not worth it for this single trip; it only pays off if you'd take many separate rides.

## SerpAPI quota note

`departure_id`/`arrival_id` accept comma-separated airport codes and the whole multi-airport query bills as **one** search. The flights sync uses this: all 11 markets are priced in a single search instead of 11, so a free-tier month affords roughly 11x more syncs. Each returned itinerary names its own airports, so results still map back to individual markets.
