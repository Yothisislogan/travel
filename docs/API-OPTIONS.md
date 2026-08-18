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
| **Seats.aero** (Pro, ~$10/mo) | Award availability API across ~20 programs | Miles backups only - no Frontier/GoWild |

The agent already integrates SerpAPI, Amadeus, Seats.aero, and Amtraker via `.env` keys (see README), and now the InternalSelect checker for GoWild itself.
