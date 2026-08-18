#!/usr/bin/env node
// GoWild Trip Agent CLI.
//   status | sync | outbound | hop | return | backup | dashboard
import { loadJSON, fmtHours, fmtMoney, todayISO, addDaysISO, loadEnv } from './util.js';
import { gowildOptions, bookingWindow, isBlackout, gowildRules } from './providers/frontier.js';
import { backupCashOptions } from './providers/flights.js';
import { awardOptions } from './providers/awards.js';
import { liveStatus } from './providers/amtrak.js';
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

function printGowildBlock(title, opts) {
  console.log(B(`\n${title}  (${opts.date})`));
  console.log(`  ${opts.window.note}`);
  if (opts.blackout) console.log(`  !! ${opts.blackout.label}: ${opts.date} may be a GoWild blackout date.`);
  if (!opts.paths.length) {
    console.log('  No Frontier paths in the current route map. Run `sync` and check the route data.');
    return;
  }
  for (const p of opts.paths) {
    const routeStr = p.via ? `${p.from} -> ${p.via} -> ${p.to}` : `${p.from} -> ${p.to} (nonstop)`;
    const freq = p.daysPerWeek && p.daysPerWeek < 7 ? `  [${p.frequencyNote}]` : '';
    const dayFlag = p.operatesOnDate === false ? `  !! does NOT run on ${p.dayOfWeek}` : '';
    console.log(`  ${routeStr.padEnd(28)} ~${fmtHours(p.totalHours).padEnd(7)} est ${fmtMoney(p.estCostUSD)} in taxes/fees${freq}${dayFlag}`);
    if (p.live) {
      if (!p.live.gowildFlights) {
        console.log(`    LIVE: no GoWild seats showing on ${p.from}-${p.to} right now`);
      }
      for (const f of p.live.flights) {
        const seats = f.goWildSeatsRemaining != null ? `${f.goWildSeatsRemaining} GoWild seat(s) left` : 'GoWild available';
        console.log(`    LIVE: ${f.flightNumber ? `#${f.flightNumber} ` : ''}${f.departure ?? ''}${f.stops ? ` (${f.stops})` : ''} - $${f.goWildFare ?? '?'} - ${seats}`);
      }
    }
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
        console.log(B(`  ${i + 1}. ${fmtHours(it.totalHours)}  ${fmtMoney(it.totalCostUSD)}${miles}  -> ${it.arrival}${badge}`));
        for (const leg of it.legs) {
          console.log(`     [${(MODE_TAG[leg.mode] ?? leg.mode).padEnd(7)}] ${leg.from} -> ${leg.to}  ${fmtHours(leg.hours)}  ${fmtMoney(leg.costUSD)}  ${dim(leg.operator ?? '')}`);
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
      const awards = awardOptions(from);
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

    case 'dashboard': {
      const { startServer } = await import('./server.js');
      startServer(+(process.env.PORT || 8787));
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
  rules                      Show GoWild rules data
  dashboard                  Web dashboard on http://localhost:8787

Dates default to tomorrow (the first GoWild-bookable day).`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
