# Trip Playbook: RIC/ORF → LAS → SFO → home, on GoWild

The strategy behind the tool, distilled from research current as of **2026-08-17**. Route facts change monthly - run `node src/cli.js sync` and re-verify before travel day.

## The one fact that shapes everything

**Frontier at Richmond runs ~2 days a week (Thu/Sun), on exactly two routes: RIC-DEN and RIC-MCO.** Norfolk has ORF-ATL (~3x weekly) and ORF-MCO. Under GoWild's day-before booking window, that means your outbound only works on the days those flights operate, and the agent flags any date they don't (`outbound --date ...`).

## Leg 1: RIC/ORF → LAS

| Path | Time | Notes |
|------|------|-------|
| RIC → DEN → LAS | ~7h | Thu/Sun only; DEN-LAS runs many times daily, so the connection usually builds |
| ORF → ATL → LAS | ~7.5h | ~3x weekly |
| ORF → MCO → LAS | ~8.5h | MCO is a Frontier hub |
| RIC → MCO → LAS | ~8.5h | Thu/Sun only |

Book as **one Frontier itinerary** when the site offers the connection - Frontier only sells connections its system builds, and a same-ticket misconnect is Frontier's problem, while a self-built one is yours (and can strand you for days on a 2x-weekly route). Expect ~$20-30 in taxes/fees.

## Leg 2: LAS → Bay Area

Easy - three GoWild nonstops: **LAS-SFO, LAS-OAK (from Aug 20, 11x weekly), LAS-SJC**, ~1.5h, ~$15-25 in fees. Check the evening before, book at release (~midnight ET, unofficially).

## Leg 3: Home (the interesting one)

Run `node src/cli.js return --from SFO` (or `--from LAS`). The structural options, fastest first:

1. **Cash/miles nonstop**: Breeze SFO-RIC (~2x/wk, ~6h) or from LAS, Breeze LAS-RIC (~3x/wk). ~$200-600 cash last-minute, or ~15k Atmos/AA miles via a connection.
2. **All-GoWild**: SFO → DEN → RIC (~$30-50 fees total) - but DEN-RIC is **Thu/Sun only**. From SFO there is **no Frontier path to ORF** anymore.
3. **The LAS-IAD trick**: Frontier flies **LAS → Dulles daily**, GoWild-eligible. From the Bay Area: GoWild SFO→LAS, GoWild LAS→IAD (~$30-50 total in fees), then Metro + Amtrak Northeast Regional (or a 2h drive) to Richmond. Daily frequency = your most reliable all-GoWild route home.
4. **Miles into DC**: SFO-IAD on United (up to ~10x/day - great same-day rebooking odds) ~15-17.5k miles, then train/bus south.
5. **No-fly fallback**: California Zephyr Emeryville→Chicago (51.5h) + Floridian Chicago→DC (~18h) + Regional to RIC/NFK. ~3.5 days, ~$255-655. From Vegas: nightly Amtrak Thruway bus to Kingman + Southwest Chief, through-ticketed LVS→CHI. Cross-country bus runs 60-84h, $150-330.

The planner ranks all of these (plus mixed combos) by **total travel time, then cost**; `--sort cost` flips it. Train/bus options always appear even when flights dominate the top of the list.

## Stuck-out-west decision tree

Run `node src/cli.js backup --from LAS` (or SFO), then:

1. **Tomorrow OK?** → check GoWild for tomorrow at ~midnight ET (LAS-IAD daily is the reliable one).
2. **Must leave today, have miles?** → Atmos (~15k + $20 fee, books AA metal), AA (~12.5-35k), UA (~12.5-35k into IAD). No close-in fees anywhere anymore.
3. **Must leave today, cash?** → check Breeze direct first (not in every OTA), then BWI/DCA/IAD arrivals - usually far cheaper than RIC/ORF - and finish with Amtrak/FlixBus south (~$15-45, 2.5h from DC to Richmond).
4. **Nothing flyable?** → the train leaves tonight either way: Thruway bus from Harry Reid ~9pm meets the Southwest Chief.

## GoWild fine print that bites

- **Blackouts**: Labor Day weekend 2026, Oct 8-12 window, Thanksgiving, Dec 19-31 - but since 2026 a Peak Day Charge (from $79) unlocks them. Early 2027 dates aren't published yet; the agent warns conservatively.
- **Promo cohort**: if you bought the Fall & Winter Pass by **Aug 17, 2026**, you got dedicated GoWild inventory + advance booking through Jan 4, 2027 (fee from $29). Set `gowild.promoAdvanceBookingThrough: "2027-01-04"` in `trip.config.json` and the agent's booking windows adjust.
- **Bags**: personal item only is free. A carry-on/checked bag costs more than the fare - decide before the airport.
- Availability is capacity-controlled and last-seat-ish on popular flights; the RIC/ORF connections are the scarce resource, the LAS-Bay Area hop rarely is.
