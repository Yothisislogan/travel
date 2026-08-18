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
import { planReturn } from '../src/planner.js';
import { syncStatus } from '../src/sync.js';

const config = loadJSON('trip.config.json');
const today = todayISO();
const tomorrow = addDaysISO(today, 1);
const home = config.traveler.homeAirports;

const data = {
  generatedAt: new Date().toISOString(),
  dates: { today, tomorrow },
  trip: `${home.preferred}/${home.backup} -> LAS -> SFO -> back east`,
  sections: syncStatus(),
  rules: {
    bookingWindow: gowildRules().bookingWindow,
    blackoutDates: gowildRules().blackoutDates,
    fareFeesUSD: gowildRules().fareFeesUSD,
  },
  outbound: Object.fromEntries([today, tomorrow].map((d) => [d, gowildOptions([home.preferred, home.backup], ['LAS'], d)])),
  hop: Object.fromEntries([today, tomorrow].map((d) => [d, gowildOptions(['LAS'], ['SFO', 'OAK', 'SJC'], d)])),
  returns: Object.fromEntries(
    ['SFO', 'LAS'].flatMap((from) =>
      ['time', 'cost'].map((sort) => [`${from}:${sort}`, planReturn({ from, date: tomorrow, sort })]),
    ),
  ),
  backup: Object.fromEntries(
    ['LAS', 'SFO'].map((from) => [from, { cash: backupCashOptions(from, tomorrow), awards: awardOptions(from) }]),
  ),
  amtrakLive: liveStatus(),
};

const out = path.join(ROOT, 'site', 'data.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${out} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB), generated ${data.generatedAt}`);
