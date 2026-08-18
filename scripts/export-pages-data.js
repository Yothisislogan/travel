// Exports precomputed views into site/data.json for the static GitHub Pages
// dashboard. Run AFTER `node src/cli.js sync` (typically in the sync GitHub
// Action) so live data is baked in; works fine on seed data too.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, todayISO, addDaysISO, loadJSON } from '../src/util.js';
import { gowildOptions, gowildRules } from '../src/providers/frontier.js';
import { backupCashOptions } from '../src/providers/flights.js';
import { awardOptions } from '../src/providers/awards.js';
import { liveStatus } from '../src/providers/amtrak.js';
import { hotelOptions } from '../src/providers/hotels.js';
import { planReturn } from '../src/planner.js';
import { syncStatus } from '../src/sync.js';

const config = loadJSON('trip.config.json');
const today = todayISO();
const tomorrow = addDaysISO(today, 1);
const home = config.traveler.homeAirports;

// Offer a rolling window of dates so you can check any near day's booking
// window and day-of-week service, not just today/tomorrow.
const DAYS = 10;
const dates = Array.from({ length: DAYS }, (_, i) => addDaysISO(today, i));

// On a seed build no sync ran, so raw statuses would read "never synced" and the
// providers' "no API key configured" notes would wrongly imply keys are missing.
// Say plainly what happened instead.
function sectionStatus() {
  const s = syncStatus();
  if (process.env.BUILD_MODE !== 'seed') return s;
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [
      k,
      { ...v, status: 'seed', notes: 'Seed build from a code push - no API calls made. Press Sync for live data.' },
    ]),
  );
}

const data = {
  generatedAt: new Date().toISOString(),
  // "live" = built by a manual Sync with API keys; "seed" = a code-push rebuild
  // with no API calls. Surfaced so the page never implies keys are missing.
  buildMode: process.env.BUILD_MODE ?? 'local',
  dates,
  defaultDate: tomorrow,
  trip: `${home.preferred}/${home.backup} -> LAS -> SFO -> back east`,
  sections: sectionStatus(),
  rules: {
    bookingWindow: gowildRules().bookingWindow,
    blackoutDates: gowildRules().blackoutDates,
    fareFeesUSD: gowildRules().fareFeesUSD,
  },
  outbound: Object.fromEntries(dates.map((d) => [d, gowildOptions([home.preferred, home.backup], ['LAS'], d)])),
  hop: Object.fromEntries(dates.map((d) => [d, gowildOptions(['LAS'], ['SFO', 'OAK', 'SJC'], d)])),
  returns: Object.fromEntries(
    dates.flatMap((d) =>
      ['SFO', 'LAS'].flatMap((from) =>
        ['time', 'cost'].map((sort) => [`${from}:${sort}:${d}`, planReturn({ from, date: d, sort })]),
      ),
    ),
  ),
  // Backup award/cash data is date-independent (only deep-link dates differ),
  // so key by origin only; the page rebuilds the dated Google Flights link.
  backup: Object.fromEntries(
    ['LAS', 'SFO'].map((from) => [from, { cash: backupCashOptions(from, tomorrow), awards: awardOptions(from) }]),
  ),
  hotels: Object.fromEntries(['vegas', 'sf'].map((c) => [c, hotelOptions(c, tomorrow)])),
  amtrakLive: liveStatus(),
};

const out = path.join(ROOT, 'site', 'data.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${out} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB), generated ${data.generatedAt}`);
