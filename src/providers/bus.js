// Intercity bus provider (Greyhound is owned by Flix; one network). No stable
// public API, so legs are seed estimates with prefilled booking links; the
// sources.json attempts list lets you wire in an endpoint later without code
// changes.
import { loadJSON, fetchJSON, writeSection } from '../util.js';
import { fill } from './frontier.js';

const ground = loadJSON('src/data/ground.json');
const sources = loadJSON('src/data/sources.json');
const airports = loadJSON('src/data/airports.json');

export function busLegs() {
  return ground.busLegs;
}

export function busLink(fromPlace, toPlace, date) {
  const fromCity = airports.places[fromPlace]?.city?.split(',')[0] ?? fromPlace;
  const toCity = airports.places[toPlace]?.city?.split(',')[0] ?? toPlace;
  return fill(sources.flixbus.deepLink, { fromCity, toCity, date });
}

export async function sync() {
  const attempts = sources.flixbus.attempts ?? [];
  const probes = [];
  for (const a of attempts) {
    const res = await fetchJSON(a.url, { timeoutMs: 12000 });
    probes.push({ name: a.name, reachable: res.ok, httpStatus: res.status });
  }
  const live = probes.some((p) => p.reachable);
  return writeSection('bus', {
    status: live ? 'live' : 'seed',
    data: { probes, legs: ground.busLegs.length },
    notes: live
      ? 'Bus endpoint reachable.'
      : 'Using seed bus estimates + FlixBus/Greyhound booking links (no stable public API).',
  });
}
