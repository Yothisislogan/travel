// Pure GoWild parsing - NO imports, no fs, no Node APIs.
//
// This module is deliberately dependency-free because it runs in two very
// different places: the Node sync engine (src/providers/frontier.js) and the
// edge relay (src/worker.js), which has no filesystem. Keep it that way.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Frontier's booking URL wants 'Aug 18, 2026'-style dates, not ISO.
export function frontierDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// The one URL that carries GoWild fares and seat counts, visible without login.
// Built with encodeURIComponent, not URLSearchParams: the date must encode as
// 'Aug%2019%2C%202026', and URLSearchParams would write spaces as '+'.
export function searchURL(origin, dest, dateISO) {
  const dd = encodeURIComponent(frontierDate(dateISO));
  return `https://booking.flyfrontier.com/Flight/InternalSelect?o1=${origin}&d1=${dest}&dd1=${dd}&ADT=1&mon=true`;
}

const HTML_ENTITIES = { '&quot;': '"', '&#34;': '"', '&amp;': '&', '&#38;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" };
export function unescapeHTML(s) {
  return s.replace(/&quot;|&#34;|&amp;|&#38;|&lt;|&gt;|&#39;/g, (m) => HTML_ENTITIES[m]);
}

// Extract the first balanced JSON array starting at text[start] === '['.
export function balancedArray(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Parse GoWild flight data out of an InternalSelect response (HTML or JSON).
// Returns [] when the payload isn't found (blocked page, layout change).
export function parseGowildFlights(body) {
  if (typeof body !== 'string') body = JSON.stringify(body);
  const text = body.includes('&quot;') ? unescapeHTML(body) : body;
  const key = text.indexOf('"journeys"');
  if (key === -1) return [];
  const arrStart = text.indexOf('[', key);
  if (arrStart === -1) return [];
  const arr = balancedArray(text, arrStart);
  if (!arr) return [];
  let journeys;
  try {
    journeys = JSON.parse(arr);
  } catch {
    return [];
  }
  const flights = [];
  for (const j of Array.isArray(journeys) ? journeys : []) {
    for (const f of j?.flights ?? []) {
      flights.push({
        flightNumber: f.flightNumber ?? f.flightCode ?? null,
        departure: f.departureDate ?? f.std ?? null,
        arrival: f.arrivalDate ?? f.sta ?? null,
        stops: f.stopsText ?? (Array.isArray(f.legs) ? `${f.legs.length - 1} stop(s)` : null),
        duration: f.duration ?? null,
        gowildEnabled: !!f.isGoWildFareEnabled,
        goWildFare: f.goWildFare ?? null,
        goWildSeatsRemaining: f.goWildFareSeatsRemaining ?? null,
      });
    }
  }
  return flights;
}

// Shape the dashboard consumes: only GoWild-eligible flights, cheapest first.
export function summarizeGowild(flights) {
  const eligible = flights.filter((f) => f.gowildEnabled);
  const sorted = [...eligible].sort((a, b) => (a.goWildFare ?? 1e9) - (b.goWildFare ?? 1e9));
  return {
    gowildFlights: eligible.length,
    seatsTotal: eligible.reduce((n, f) => n + (Number(f.goWildSeatsRemaining) || 0), 0),
    cheapestFare: sorted.length ? sorted[0].goWildFare ?? null : null,
    flights: sorted.slice(0, 6),
  };
}
