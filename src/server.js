// Local web dashboard. Sync-on-request only: the page never auto-polls; every
// section has a Refresh button that triggers a targeted sync.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { ROOT, loadJSON, todayISO, addDaysISO } from './util.js';
import { gowildOptions, checkGowildAvailability } from './providers/frontier.js';
import { backupCashOptions } from './providers/flights.js';
import { awardOptions } from './providers/awards.js';
import { hotelOptions } from './providers/hotels.js';
import { liveStatus } from './providers/amtrak.js';
import { planReturn } from './planner.js';
import { syncAll, syncStatus } from './sync.js';

const config = loadJSON('trip.config.json');

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function startServer(port = 8787) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const q = url.searchParams;
    const date = q.get('date') || addDaysISO(todayISO(), 1);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(path.join(ROOT, 'public', 'dashboard.html')));
      } else if (url.pathname === '/theme.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(readFileSync(path.join(ROOT, 'site', 'theme.css')));
      } else if (url.pathname === '/api/status') {
        json(res, 200, { config, sections: syncStatus(), amtrakLive: liveStatus(), today: todayISO() });
      } else if (url.pathname === '/api/sync' && req.method === 'POST') {
        const sections = q.get('section') ? q.get('section').split(',') : undefined;
        json(res, 200, await syncAll({ sections, date: q.get('date') || undefined }));
      } else if (url.pathname === '/api/outbound') {
        const from = q.get('from')
          ? [q.get('from').toUpperCase()]
          : [config.traveler.homeAirports.preferred, config.traveler.homeAirports.backup];
        json(res, 200, gowildOptions(from, ['LAS'], date));
      } else if (url.pathname === '/api/hop') {
        json(res, 200, gowildOptions(['LAS'], ['SFO', 'OAK', 'SJC'], date));
      } else if (url.pathname === '/api/gowild-live') {
        // Server-side fetch of Frontier's own search page (no browser CORS
        // limit here) - parses live GoWild fares + seats for one route/date.
        const from = (q.get('from') || '').toUpperCase();
        const to = (q.get('to') || '').toUpperCase();
        if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
          json(res, 400, { error: 'from and to must be 3-letter airport codes' });
        } else {
          json(res, 200, await checkGowildAvailability(from, to, date));
        }
      } else if (url.pathname === '/api/return') {
        json(res, 200, planReturn({
          from: (q.get('from') || 'SFO').toUpperCase(),
          date,
          sort: q.get('sort') === 'cost' ? 'cost' : 'time',
          to: q.get('to')?.toUpperCase() || null,
          maxResults: q.get('max') ? +q.get('max') : undefined,
        }));
      } else if (url.pathname === '/api/backup') {
        const from = (q.get('from') || 'LAS').toUpperCase();
        json(res, 200, { cash: backupCashOptions(from, date), awards: awardOptions(from) });
      } else if (url.pathname === '/api/hotels') {
        json(res, 200, hotelOptions((q.get('city') || 'vegas').toLowerCase(), q.get('date') || undefined));
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
  // Bind all interfaces so a phone on the same Wi-Fi can use this dashboard -
  // that is the only way the real "live seats" button (which fetches Frontier
  // server-side, from your own IP) is usable from a phone.
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nGoWild Trip Agent dashboard`);
    console.log(`  This computer:  http://localhost:${port}`);
    for (const url of lanURLs(port)) console.log(`  Phone/tablet:   ${url}   <- same Wi-Fi, gives you the live-seats button`);
    console.log('\nData refreshes only when you click Refresh (or run `sync`).');
  });
  return server;
}

// Every non-internal IPv4 address this machine has, as dashboard URLs.
export function lanURLs(port) {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}
