# GoWild Trip Agent

A personal travel agent for one specific mission: fly **RIC (preferred) or ORF (backup) → Las Vegas → San Francisco → back to the east coast** on a **Frontier GoWild! all-you-can-fly pass**, with a ranked backup plan (cash fares + airline miles) in case you get stuck on the west coast, and a return planner that combines **flights, Amtrak, intercity buses, and local transit**, sorted by **travel time first, then cost**.

Zero dependencies - Node.js 18+ is all you need. Nothing polls in the background: **data syncs only when you ask** (a CLI command or a dashboard Refresh button).

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

Useful flags:

```bash
node src/cli.js return --from SFO --sort cost      # cheapest first instead of fastest
node src/cli.js return --from LAS --to RIC         # Richmond arrivals only
node src/cli.js outbound --from ORF --date 2026-09-03
node src/cli.js sync --section frontier,amtrak     # refresh just some sections
```

## How GoWild tracking works (and its honest limits)

GoWild fares are **capacity-controlled and only bookable starting the day before domestic departure** (Eastern time), so "tracking availability" means:

1. The agent knows the **booking window**: for any date it tells you exactly when GoWild booking opens and whether you can book *right now* (`status` and every GoWild view show this).
2. It knows the **Frontier route map** (seeded in `src/data/frontier-routes.json`, refreshed on `sync`) and computes nonstop + one-connection GoWild paths for each leg of your trip.
3. It flags **blackout dates** from `src/data/gowild.json`.
4. It generates **prefilled Frontier search links** for every pair you need to check. Frontier's booking site sits behind bot protection and requires your logged-in GoWild account to show pass fares, so no tool can reliably confirm the final fare for you - the agent gets you one click away with everything precomputed.

`sync` probes Frontier reachability and refreshes a checklist of pair-searches for the next bookable day; the dashboard renders it with live/seed/stale badges.

## Live data sources (all optional, all sync-on-request)

| Section | Live source | Without it |
|---------|-------------|------------|
| Frontier GoWild | Reachability probe + prefilled search links (no public API exists) | Seed route map + links |
| Backup cash fares | [Amadeus Self-Service API](https://developers.amadeus.com) - free tier, put keys in `.env` | Seed price ranges + Google Flights/Kayak links |
| Award (miles) | [Seats.aero Partner API](https://seats.aero) key in `.env` | Seed miles estimates + program search links |
| Amtrak | [Amtraker](https://amtraker.com) live train status - free, no key | Seed schedules/fares |
| Intercity bus | (no stable public API) | Seed estimates + FlixBus/Greyhound links |

```bash
cp .env.example .env   # then add any keys you have
```

## Return planner details

The planner builds a multimodal graph - GoWild nonstops (both directions of the route map), single-ticket backup flights, award flights (cheapest program per market), Amtrak long-distance legs (California Zephyr, Southwest Chief, Cardinal, Chicago→DC, Northeast Regional), intercity buses, and local transfers (BART, Metro, FlyAway, rideshares) - then searches all combinations up to 5 legs from your west coast location to Richmond or Norfolk.

- **Sorting**: total travel time first, then cost (`--sort cost` flips it). Award miles are valued at 1.3¢/mile so miles itineraries rank fairly against cash.
- **Transfer buffers**: 2h between separately booked flights, 1.5h air↔ground, 1h ground↔ground, 30m around local transit. Overnight waits between separately booked legs are *not* modeled - a 52h Zephyr ride is 52h of scheduled travel, but your actual door-to-door depends on departure times.
- **Mode diversity**: even when flights sweep the top of the list, the best train-based and bus-based itineraries are always included, so you can see the "no-fly" fallback at a glance.

## Tuning

- `trip.config.json` - home airports, acceptable east coast arrivals, max legs/results, allowed modes, staleness threshold.
- `src/data/frontier-routes.json` - the Frontier route map. **Frontier changes routes seasonally**; update this when `sync` or your own checking shows changes.
- `src/data/backup-flights.json` - backup markets, airlines, price/miles estimates.
- `src/data/ground.json` - train/bus legs, durations, fares.
- `src/data/sources.json` - live endpoints and deep-link templates (editable without touching code).

## Tests

```bash
npm test
```

## Caveats

- Seed prices/durations are planning estimates, not quotes. Anything tagged `[estimate]` should be verified through the provided links before you rely on it; anything tagged `[live]` came from an API on your last `sync`.
- GoWild fine print changes program-year to program-year (blackouts, fees, booking windows). `src/data/gowild.json` records what the agent assumes; verify against your pass's current terms.
