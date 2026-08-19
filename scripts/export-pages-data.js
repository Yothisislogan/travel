// Exports precomputed views into site/data.json for the static GitHub Pages
// dashboard. Run AFTER `node src/cli.js sync` (typically in the sync GitHub
// Action) so live data is baked in; works fine on seed data too.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, todayISO, addDaysISO, loadJSON, readSnapshot, writeSection } from '../src/util.js';
import { readPublished } from '../src/publish.js';
import { gowildOptions, gowildRules } from '../src/providers/frontier.js';
import { backupCashOptions } from '../src/providers/flights.js';
import { awardOptions } from '../src/providers/awards.js';
import { liveStatus } from '../src/providers/amtrak.js';
import { hotelOptions } from '../src/providers/hotels.js';
import { planReturn } from '../src/planner.js';
import { syncStatus } from '../src/sync.js';

// Frontier blocks GitHub's datacenter IPs, so a build here can never see live
// GoWild seats. If `node src/cli.js publish` captured them from a residential
// connection, fold that in first.
//
// Gate on STATUS, not recency. pages.yml runs `sync` before this script, and a
// bot-blocked Frontier sync writes a seed section stamped now - so a recency
// test always loses and the residentially-captured seats get thrown away. Live
// beats non-live regardless of age; live only loses to fresher live.
const published = readPublished();
if (published?.sections) {
  for (const [name, sec] of Object.entries(published.sections)) {
    if (sec?.status !== 'live') continue;
    const current = readSnapshot().sections[name];
    const beats = current?.status !== 'live'
      || Date.parse(sec.fetchedAt ?? 0) > Date.parse(current.fetchedAt ?? 0);
    if (!beats) continue;
    writeSection(name, {
      ...sec,
      // fetchedAt rides along in ...sec, so writeSection preserves the real
      // capture time instead of re-stamping it to this build's clock.
      publishedFrom: published.publishedFrom ?? 'your own connection',
      notes: `${sec.notes} (captured from your own connection ${sec.fetchedAt})`,
    });
  }
}

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
      // Data published from the user's own connection is genuinely live - don't
      // relabel it as a seed build just because this build made no API calls.
      v.status === 'live' || v.status === 'stale'
        ? v
        : { ...v, status: 'seed', notes: 'Seed build from a code push - no API calls made. Press Sync for live data.' },
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
  // The backup card has its own date picker, so it needs a plan per date -
  // building it once for tomorrow and keying by origin meant every date in the
  // dropdown rendered tomorrow's prices.
  backup: Object.fromEntries(
    dates.flatMap((d) =>
      ['LAS', 'SFO'].map((from) => [`${from}:${d}`, { cash: backupCashOptions(from, d), awards: awardOptions(from, d) }]),
    ),
  ),
  hotels: Object.fromEntries(dates.flatMap((d) => ['vegas', 'sf'].map((c) => [`${c}:${d}`, hotelOptions(c, d)]))),
  amtrakLive: liveStatus(),
};

const out = path.join(ROOT, 'site', 'data.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${out} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB), generated ${data.generatedAt}`);
