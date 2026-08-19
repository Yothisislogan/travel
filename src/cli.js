#!/usr/bin/env node
// GoWild Trip Agent CLI.
//   status | sync | outbound | hop | return | backup | dashboard
import { loadJSON, fmtHours, fmtMoney, todayISO, addDaysISO, loadEnv, liveAgeClass, shortAge } from './util.js';
import { gowildOptions, bookingWindow, isBlackout, gowildRules, dayOfWeek } from './providers/frontier.js';
import { backupCashOptions } from './providers/flights.js';
import { awardOptions } from './providers/awards.js';
import { liveStatus } from './providers/amtrak.js';
import { hotelOptions } from './providers/hotels.js';
import { planReturn } from './planner.js';
import { syncAll, syncStatus, SECTIONS } from './sync.js';

loadEnv();
const config = loadJSON('trip.config.json');

const [, , cmd = 'help', ...rest] = process.argv;
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
    flags[key] = val;
  }
}

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const MODE_TAG = { gowild: 'GoWild', flight: 'FLIGHT', award: 'MILES', train: 'TRAIN', bus: 'BUS', transit: 'transit' };

function defaultDate() {
  // GoWild is bookable day-before, so "tomorrow" is the natural planning date.
  return flags.date ?? addDaysISO(todayISO(), 1);
}

// GoWild inventory turns over in minutes, so an unqualified "LIVE" on a capture
// from hours ago is the most expensive kind of wrong. Every live line carries
// its age, and anything past an hour says so loudly.
function liveTag(capturedAt) {
  const cls = liveAgeClass(capturedAt);
  if (!cls) return 'LIVE';
  const age = shortAge(capturedAt);
  return cls === 'fresh' ? `LIVE (${age})` : `LIVE ${age} AGO - RECHECK`;
}

function printLiveSegments(live, capturedAt) {
  const tag = liveTag(capturedAt);
  for (const s of live.segments) {
    const pair = `${s.from}-${s.to}`;
    if (!s.checked) {
      console.log(`    ${pair}: not searched - this connection is unconfirmed`);
      continue;
    }
    if (!s.gowildFlights) {
      console.log(`    ${tag}: no GoWild seats showing on ${pair} right now`);
      continue;
    }
    for (const f of s.flights) {
      const seats = f.goWildSeatsRemaining != null ? `${f.goWildSeatsRemaining} GoWild seat(s) left` : 'GoWild available';
      console.log(`    ${tag}: ${pair} ${f.flightNumber ? `#${f.flightNumber} ` : ''}${f.departure ?? ''}${f.stops ? ` (${f.stops})` : ''} - $${f.goWildFare ?? '?'} - ${seats}`);
    }
  }
  if (!live.complete) {
    console.log(dim(`    (${live.checkedSegments}/${live.totalSegments} segments searched - the whole path is not confirmed bookable)`));
  }
}

function printGowildBlock(title, opts) {
  console.log(B(`\n${title}  (${opts.date})`));
  console.log(`  ${opts.window.note}`);
  if (opts.blackout) {
    const pk = gowildRules().peakDayChargeUSD;
    console.log(`  !! ${opts.blackout.label}: ${opts.date} is a GoWild blackout date - flyable only with the Peak Day Charge`
      + (pk ? ` (+$${pk.min}-$${pk.max} per segment).` : '.'));
  }
  if (!opts.paths.length) {
    console.log('  No Frontier paths in the current route map. Run `sync` and check the route data.');
    return;
  }
  for (const p of opts.paths) {
    const routeStr = p.via ? `${p.from} -> ${p.via} -> ${p.to}` : `${p.from} -> ${p.to} (nonstop)`;
    const freq = p.daysPerWeek && p.daysPerWeek < 7 ? `  [${p.frequencyNote}]` : '';
    const dayFlag = p.operatesOnDate === false ? `  !! does NOT run on ${p.dayOfWeek}` : '';
    console.log(`  ${routeStr.padEnd(28)} ~${fmtHours(p.totalHours).padEnd(7)} est ${fmtMoney(p.estCostUSD)} in taxes/fees${freq}${dayFlag}`);
    if (p.live) printLiveSegments(p.live, opts.capturedAt);
    console.log(dim(`    check: ${p.searchLink}`));
  }
  if (opts.trackers?.length) {
    console.log(dim(`  Community GoWild trackers: ${opts.trackers.map((t) => `${t.name} <${t.url}>`).join('  ')}`));
  }
  console.log(dim(`  Route map: ${opts.freshness}. ${opts.warning}`));
}

async function main() {
  switch (cmd) {
    case 'status': {
      console.log(B('GoWild Trip Agent - status'));
      console.log(`Trip: ${config.traveler.homeAirports.preferred}/${config.traveler.homeAirports.backup} -> LAS -> SFO -> back east`);
      const st = syncStatus();
      console.log(B('\nData sections (sync on request - nothing auto-polls):'));
      for (const [name, s] of Object.entries(st)) {
        console.log(`  ${s.label.padEnd(28)} [${s.status}] ${s.freshness}`);
        console.log(dim(`    ${s.notes}`));
      }
      const trains = liveStatus();
      if (trains.length) {
        console.log(B('\nLive Amtrak (relevant long-distance trains):'));
        for (const t of trains.slice(0, 10)) {
          console.log(`  ${t.route} #${t.trainNum} ${t.heading ?? ''} - ${t.status ?? '?'} ${t.minutesLate ? `(${t.minutesLate})` : ''} ${dim(t.lastStation ?? '')}`);
        }
      }
      const d = defaultDate();
      console.log(B('\nGoWild booking windows:'));
      for (const dd of [todayISO(), d]) {
        const w = bookingWindow(dd);
        const bo = isBlackout(dd);
        console.log(`  ${dd}: ${w.canBookNow ? 'BOOKABLE NOW' : `opens ${w.opensOn}`}${bo ? ` !! ${bo.label}` : ''}`);
      }
      console.log(dim('\nCommands: sync | outbound | hop | return | backup | dashboard'));
      break;
    }

    case 'sync': {
      const sections = flags.section ? flags.section.split(',') : undefined;
      console.log(`Syncing ${sections ? sections.join(', ') : 'all sections'}...`);
      const res = await syncAll({ sections, date: flags.date });
      for (const [name, r] of Object.entries(res)) {
        console.log(`  ${(SECTIONS[name]?.label ?? name).padEnd(28)} [${r.status}] ${r.notes}`);
      }
      break;
    }

    case 'outbound': {
      const d = defaultDate();
      const from = flags.from ? [flags.from.toUpperCase()] : [config.traveler.homeAirports.preferred, config.traveler.homeAirports.backup];
      printGowildBlock(`Outbound to Las Vegas on GoWild: ${from.join('/')} -> LAS`, gowildOptions(from, ['LAS'], d));
      break;
    }

    case 'hop': {
      const d = defaultDate();
      printGowildBlock('Vegas to Bay Area on GoWild: LAS -> SFO/OAK/SJC', gowildOptions(['LAS'], ['SFO', 'OAK', 'SJC'], d));
      break;
    }

    case 'return': {
      const d = defaultDate();
      const from = (flags.from ?? 'SFO').toUpperCase();
      const sort = flags.sort === 'cost' ? 'cost' : 'time';
      const plan = planReturn({ from, date: d, sort, to: flags.to?.toUpperCase() ?? null, maxResults: flags.max ? +flags.max : undefined });
      console.log(B(`\nReturn east from ${from} on ${d} - all modes combined`));
      console.log(dim(`  ${plan.note}\n`));
      if (!plan.itineraries.length) {
        console.log('  No itineraries found - check route data and trip.config.json allowModes.');
        break;
      }
      plan.itineraries.forEach((it, i) => {
        const badge = it.badges.length ? ` [${it.badges.join(', ')}]` : '';
        const miles = it.totalMiles ? ` + ${it.totalMiles.toLocaleString()} miles` : '';
        const arrive = it.arrivalDate ? ` arrive ${it.arrivalDate}${it.daysSpanned ? ` (+${it.daysSpanned}d)` : ''}` : '';
        const grounded = it.flyable === false ? `  !! does not run on ${dayOfWeek(d)}: ${it.groundedLegs.join(', ')}` : '';
        console.log(B(`  ${i + 1}. ${fmtHours(it.totalHours)}  ${fmtMoney(it.totalCostUSD)}${miles}  -> ${it.arrival}${arrive}${badge}${grounded}`));
        for (const leg of it.legs) {
          const board = leg.dayOffset ? `  boards ${leg.legDate}` : '';
          console.log(`     [${(MODE_TAG[leg.mode] ?? leg.mode).padEnd(7)}] ${leg.from} -> ${leg.to}  ${fmtHours(leg.hours)}  ${fmtMoney(leg.costUSD)}${board}  ${dim(leg.operator ?? '')}`);
          if (leg.priceNote) console.log(dim(`               ${leg.priceNote}`));
          if (leg.bookLink) console.log(dim(`               ${leg.bookLink}`));
        }
      });
      break;
    }

    case 'backup': {
      const d = defaultDate();
      const from = (flags.from ?? 'LAS').toUpperCase();
      console.log(B(`\nStuck-on-the-west-coast backup plan from ${from} (${d})`));
      const cash = backupCashOptions(from, d);
      console.log(B('\n  Cash fares (cheapest markets first):'));
      for (const o of cash.options) {
        console.log(`  ${o.from} -> ${o.to}  ${fmtMoney(o.costUSD)}  ~${fmtHours(o.hours)}  ${o.nonstop ? 'nonstop' : '1-stop'}  [${o.dataStatus}]`);
        console.log(dim(`    ${o.airlines.join(', ')}`));
        console.log(dim(`    ${o.links.googleFlights}`));
      }
      const awards = awardOptions(from, d);
      console.log(B('\n  Miles options (fewest miles first):'));
      for (const o of awards.options.slice(0, 10)) {
        console.log(`  ${o.from} -> ${o.to}  ~${o.miles.toLocaleString()} ${o.program} + ${fmtMoney(o.feesUSD)}  [${o.dataStatus}]`);
        if (o.searchLink) console.log(dim(`    ${o.searchLink}`));
      }
      console.log(B('\n  Positioning tips:'));
      for (const tip of cash.positioningTips) console.log(`  - ${tip}`);
      console.log(dim(`\n  ${awards.closeInFees}`));
      console.log(dim('  Tip: `return --from ' + from + '` ranks these against trains/buses by total time.'));
      break;
    }

    case 'hotels': {
      const cityKey = (flags.city || 'vegas').toLowerCase();
      const o = hotelOptions(cityKey, flags.date);
      if (o.error) { console.log(o.error); break; }
      console.log(B(`\nHotels in ${o.city} - ${o.checkIn} to ${o.checkOut} (${o.nights} night${o.nights > 1 ? 's' : ''})`));
      for (const g of o.groups) {
        console.log(B(`\n  ${g.brand}`));
        console.log(dim(`  ${g.pricingNote}`));
        if (g.express) {
          for (const t of g.tiers) {
            console.log(`  ${t.name}`);
            console.log(`    public ~${fmtMoney(t.publicUSD)}/night · express ~${fmtMoney(t.expressUSD)}/night [estimate]`);
          }
          console.log(dim(`  Neighborhoods: ${g.neighborhoods.join(', ')}`));
          console.log(dim(`  ${g.note}`));
          console.log(dim(`  book: ${g.bookLink}`));
        } else {
          for (const p of g.properties) {
            const member = p.memberUSD ? ` · member ~${fmtMoney(p.memberUSD)}` : '';
            console.log(`  ${p.name.padEnd(22)} ${fmtMoney(p.publicUSD)}/night${member} · +$${p.resortFeeUSD} resort fee [${p.dataStatus}] ${dim(p.tier)}`);
            console.log(dim(`    book: ${p.bookLink}`));
          }
        }
      }
      console.log(dim('\n  Live public rates need SERPAPI_KEY + `sync`; member/express rates show when you book via the link (logged in).'));
      break;
    }

    case 'publish': {
      const { publish, watch, installAgent } = await import('./publish.js');

      if (flags.install !== undefined) {
        const r = installAgent();
        if (!r.ok) { console.log(r.message); break; }
        console.log(B(`Wrote the ${r.kind} service file:`));
        console.log(`  ${r.path}`);
        console.log('\nActivate it with:');
        console.log(B(`  ${r.load}`));
        console.log(dim(`\nIt then publishes every 30 minutes from this machine, at boot, with no terminal open.`));
        console.log(dim(`Logs: cache/publish.log   ·   Stop it with: ${r.unload}`));
        break;
      }
      if (flags.watch !== undefined) {
        const every = +(flags.every ?? 30);
        console.log(B(`Publishing every ${every} min from this machine. Ctrl-C to stop.`));
        await watch({ everyMinutes: every, date: flags.date, sections: flags.section?.split(',') });
        break;
      }

      console.log('Syncing from this machine, then publishing to the phone dashboard...');
      const r = await publish({ date: flags.date, push: flags.push !== 'false', sections: flags.section?.split(',') });
      for (const [name, s] of Object.entries(r.results)) {
        console.log(`  ${(SECTIONS[name]?.label ?? name).padEnd(28)} [${s.status}]`);
      }
      console.log(r.live.length ? B(`\nCaptured LIVE: ${r.live.join(', ')}`) : '\nNothing came back live - nothing useful to publish.');
      if (r.pushed) {
        console.log(`Pushed ${r.path} to ${r.branch}. The phone dashboard picks it up on its next build (~1-2 min).`);
        console.log(dim('Tip: press Sync on the dashboard, or just wait for the push-triggered deploy.'));
      } else {
        console.log(dim(`Not pushed${r.reason ? ` (${r.reason})` : ''}. Wrote ${r.path}.`));
      }
      break;
    }

    case 'dashboard': {
      const { startServer } = await import('./server.js');
      startServer(+(process.env.PORT || 8787));
      break;
    }

    // The no-hosting, no-computer path to live seats. Your phone is already on a
    // connection Frontier answers, and Shortcuts is not a browser, so the CORS
    // wall that stops the web dashboard does not apply to it.
    case 'phone': {
      const { searchURL } = await import('./gowild-parse.js');
      const home = config.traveler.homeAirports;
      const pairs = [
        [home.preferred, 'LAS'], [home.backup, 'LAS'], ['LAS', 'SFO'],
        ['SFO', home.preferred], ['LAS', home.preferred],
      ];
      const d = defaultDate();
      console.log(B('iPhone Shortcut: "GoWild seats" - one tap, works on cellular, nothing hosted'));
      console.log(dim('Shortcuts makes plain HTTP requests, so Frontier answers it the same way it answers your browser.\n'));
      console.log('Open Shortcuts -> + -> add these actions in order:\n');
      console.log(`  1. ${B('Date')}                  (leave as Current Date)`);
      console.log(`  2. ${B('Adjust Date')}           Add 1 Days        <- GoWild opens the day before`);
      console.log(`  3. ${B('Format Date')}           Custom: ${B('MMM d, yyyy')}   <- exactly what Frontier's URL wants`);
      console.log(`  4. ${B('Text')}                  paste these lines:`);
      for (const [o, dst] of pairs) console.log(`         o1=${o}&d1=${dst}`);
      console.log(`  5. ${B('Split Text')}            by New Lines`);
      console.log(`  6. ${B('Repeat with Each')}      (Split Text)  - inside the repeat:`);
      console.log(`       a. ${B('Text')}             https://booking.flyfrontier.com/Flight/InternalSelect?[Repeat Item]&dd1=[Formatted Date]&ADT=1&mon=true`);
      console.log(dim('                            (tap the variable chips for Repeat Item and Formatted Date)'));
      console.log(`       b. ${B('Get Contents of URL')}  the Text above, Method GET`);
      console.log(`       c. ${B('Match Text')}       ${B('"goWildFareSeatsRemaining":[1-9][0-9]*')}`);
      console.log(dim('                            matches only flights that still have seats'));
      console.log(`       d. ${B('Count')}            Items in Matches`);
      console.log(`       e. ${B('Text')}             [Repeat Item] - [Count] flight(s) with GoWild seats`);
      console.log(`  7. ${B('Combine Text')}          Repeat Results, with New Lines`);
      console.log(`  8. ${B('Show Result')}\n`);
      console.log('Add it to your home screen and tap it. Sample output:\n');
      console.log(dim('  o1=LAS&d1=SFO - 3 flight(s) with GoWild seats\n  o1=RIC&d1=LAS - 0 flight(s) with GoWild seats\n'));
      console.log(dim('If Frontier returns 0 for everything, add a Headers row to step 6b:'));
      console.log(dim('  User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1\n'));
      console.log(B('Android:') + ' the "HTTP Shortcuts" app does the same thing - same URLs, same pattern.\n');
      console.log(B(`Today's URLs (${d}), if you would rather just tap one:`));
      for (const [o, dst] of pairs) console.log(`  ${o}->${dst}  ${searchURL(o, dst, d)}`);
      console.log(dim('\nPrefer no phone setup at all? Deploy the relay instead (wrangler deploy) - see docs/RELAY.md.'));
      break;
    }

    case 'rules': {
      const r = gowildRules();
      console.log(B('GoWild! pass rules on file:'));
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    default: {
      console.log(B('GoWild Trip Agent'));
      console.log(`
Usage: node src/cli.js <command> [flags]

  status                     Trip overview, data freshness, booking windows
  sync [--section a,b]       Refresh live data on request (frontier, flights, awards, amtrak, bus)
  outbound [--from RIC]      GoWild options RIC/ORF -> LAS   [--date YYYY-MM-DD]
  hop                        GoWild options LAS -> SFO/OAK/SJC
  return [--from SFO]        All-modes return east, sorted by time then cost
         [--sort cost]       ...sorted by cost then time
         [--to RIC] [--max N]
  backup [--from LAS]        Stuck-out-west plan: cash + miles options
  hotels [--city vegas|sf]   Vegas (MGM Rewards + Caesars Rewards) / SF (Priceline Express)
  rules                      Show GoWild rules data
  publish                    Sync here, then push the live result so your PHONE
                             dashboard shows real GoWild seats (Frontier blocks
                             GitHub's servers, not your home connection)
         [--watch --every 30]  keep publishing on an interval
         [--install]           register it as a background job (launchd/systemd)
  phone                      Build a one-tap iPhone Shortcut that checks live
                             GoWild seats with nothing hosted anywhere
  dashboard                  Web dashboard, reachable from your phone on the
                             same Wi-Fi (prints the LAN address on startup)

Live seats on the phone with no computer running: deploy the relay once -
  npm i -g wrangler && wrangler login && wrangler deploy   (see docs/RELAY.md)
then paste its URL into the dashboard's "Set up one-tap live seats".

Dates default to tomorrow (the first GoWild-bookable day).`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
