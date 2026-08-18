// On-demand sync orchestrator. Nothing polls in the background - data
// refreshes only when you ask (CLI `sync` or a dashboard Refresh button).
import * as frontier from './providers/frontier.js';
import * as flights from './providers/flights.js';
import * as awards from './providers/awards.js';
import * as amtrak from './providers/amtrak.js';
import * as bus from './providers/bus.js';
import * as hotels from './providers/hotels.js';
import { readSnapshot, freshnessLabel, loadJSON } from './util.js';

const config = loadJSON('trip.config.json');

export const SECTIONS = {
  frontier: { label: 'Frontier GoWild', sync: frontier.sync },
  flights: { label: 'Backup cash fares', sync: flights.sync },
  awards: { label: 'Award (miles) availability', sync: awards.sync },
  amtrak: { label: 'Amtrak', sync: amtrak.sync },
  bus: { label: 'Intercity bus', sync: bus.sync },
  hotels: { label: 'Hotels', sync: hotels.sync },
};

export async function syncAll({ sections, date } = {}) {
  const names = sections?.length ? sections : Object.keys(SECTIONS);
  const out = {};
  for (const name of names) {
    const s = SECTIONS[name];
    if (!s) {
      out[name] = { status: 'error', notes: `Unknown section '${name}'. Valid: ${Object.keys(SECTIONS).join(', ')}` };
      continue;
    }
    try {
      out[name] = await s.sync({ date });
    } catch (err) {
      out[name] = { status: 'error', notes: `Sync crashed: ${err.message}` };
    }
  }
  return out;
}

export function syncStatus() {
  const snap = readSnapshot();
  const staleAfter = config.sync.staleAfterHours;
  return Object.fromEntries(
    Object.entries(SECTIONS).map(([name, s]) => {
      const section = snap.sections[name];
      return [name, { label: s.label, freshness: freshnessLabel(section, staleAfter), status: section?.status ?? 'never', notes: section?.notes ?? 'Run `sync` to refresh.', fetchedAt: section?.fetchedAt ?? null }];
    }),
  );
}
