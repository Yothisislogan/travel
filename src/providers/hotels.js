// Hotels. Live public nightly rates come from SerpAPI google_hotels on sync
// (matched to the named MGM/Caesars properties and the SF market); the actual
// member/express rate is captured by booking through the linked source:
// MGM Rewards / Caesars Rewards (sign-in) or Priceline Express Deals (opaque).
import { loadJSON, fetchJSON, loadEnv, readSnapshot, writeSection, todayISO, addDaysISO } from '../util.js';

const hotels = loadJSON('src/data/hotels.json');
const sources = loadJSON('src/data/sources.json');
const config = loadJSON('trip.config.json');

const DEFAULT_NIGHTS = 2;

export function fillTemplate(t, vars) {
  return t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

// Rough member/express discount applied to a public rate, for a "you'd pay ~X"
// hint. Booking through the source gets the real number.
const MEMBER_DISCOUNT = { 'MGM Rewards': 0.12, 'Caesars Rewards': 0.1, 'Priceline Express Deals': 0.35 };

function applyDiscount(costUSD, brand) {
  const d = MEMBER_DISCOUNT[brand] ?? 0;
  if (!costUSD || !d) return null;
  const lo = (c) => (typeof c === 'number' ? c : c.min);
  const hi = (c) => (typeof c === 'number' ? c : c.max);
  return { min: Math.round(lo(costUSD) * (1 - d)), max: Math.round(hi(costUSD) * (1 - d)) };
}

// Match a live google_hotels property name to one of our seed names.
function liveRateFor(name, liveProps) {
  if (!liveProps) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  for (const p of liveProps) {
    const pn = norm(p.name);
    if (pn === target || pn.includes(target) || target.includes(pn)) {
      return { nightlyUSD: p.rate, source: 'serpapi', link: p.link ?? null };
    }
  }
  return null;
}

export function hotelDates(dateISO) {
  const checkIn = dateISO ?? config.hotels?.vegasCheckIn ?? addDaysISO(todayISO(), 1);
  const nights = config.hotels?.nights ?? DEFAULT_NIGHTS;
  return { checkIn, checkOut: addDaysISO(checkIn, nights), nights };
}

export function hotelOptions(cityKey, dateISO) {
  const city = hotels.cities[cityKey];
  if (!city) return { city: cityKey, error: `Unknown city '${cityKey}'. Try: ${Object.keys(hotels.cities).join(', ')}` };
  const { checkIn, checkOut, nights } = hotelDates(dateISO);
  const snap = readSnapshot().sections.hotels;
  const live = snap?.status === 'live' ? snap.data?.properties?.[cityKey] ?? [] : [];

  const groups = city.groups.map((g) => {
    const dateVars = { checkIn, checkOut, slug: '', city: city.label };
    const booking = g.express
      ? fillTemplate(g.bookBase, dateVars)
      : null;

    if (g.express) {
      // Priceline Express Deals - opaque, presented by star tier.
      const tiers = (g.tiers ?? []).map((t) => ({
        name: t.name,
        star: t.star,
        publicUSD: t.typicalUSD,
        expressUSD: applyDiscount(t.typicalUSD, g.brand),
        dataStatus: 'estimate',
      }));
      return {
        brand: g.brand,
        program: g.program,
        express: true,
        pricingNote: g.pricingNote,
        note: g.note,
        neighborhoods: g.neighborhoods,
        bookLink: booking,
        tiers,
      };
    }

    const properties = g.properties.map((p) => {
      const liveHit = liveRateFor(p.name, live);
      const publicUSD = liveHit ? { min: liveHit.nightlyUSD, max: liveHit.nightlyUSD } : p.typicalUSD;
      return {
        name: p.name,
        tier: p.tier,
        publicUSD,
        memberUSD: applyDiscount(publicUSD, g.brand),
        resortFeeUSD: p.resortFeeUSD,
        dataStatus: liveHit ? 'live' : 'estimate',
        bookLink: fillTemplate(g.bookBase, { slug: p.slug, checkIn, checkOut }),
      };
    });
    // Cheapest public rate first.
    properties.sort((a, b) => (a.publicUSD.min + a.publicUSD.max) - (b.publicUSD.min + b.publicUSD.max));
    return { brand: g.brand, program: g.program, pricingNote: g.pricingNote, properties };
  });

  return { city: city.label, cityKey, checkIn, checkOut, nights, groups };
}

// ---- SerpAPI google_hotels sync ----

async function googleHotels(query, checkIn, checkOut) {
  const url = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(query)}&check_in_date=${checkIn}&check_out_date=${checkOut}&adults=2&currency=USD&gl=us&hl=en&api_key=${process.env.SERPAPI_KEY}`;
  const res = await fetchJSON(url, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`google_hotels HTTP ${res.status}`);
  const out = [];
  for (const p of res.data?.properties ?? []) {
    const rate = p.rate_per_night?.extracted_lowest ?? p.rate_per_night?.extracted_before_taxes_fees ?? null;
    if (p.name) out.push({ name: p.name, rate: rate != null ? Math.round(rate) : null, link: p.link ?? null });
  }
  return out;
}

export async function sync({ date } = {}) {
  loadEnv();
  const { checkIn, checkOut } = hotelDates(date);
  if (!process.env.SERPAPI_KEY) {
    return writeSection('hotels', {
      status: 'seed',
      data: { checkIn, checkOut },
      notes: 'No SERPAPI_KEY configured - showing seed nightly ranges + booking links. Add SERPAPI_KEY for live google_hotels public rates.',
    });
  }
  const queries = sources.hotels?.googleHotelsQueries ?? {
    vegas: ['MGM Resorts Las Vegas', 'Caesars Entertainment Las Vegas hotels'],
    sf: ['San Francisco hotels'],
  };
  try {
    const properties = {};
    const errors = [];
    let calls = 0;
    for (const [cityKey, qs] of Object.entries(queries)) {
      const merged = [];
      for (const q of qs) {
        calls++;
        try {
          merged.push(...(await googleHotels(q, checkIn, checkOut)));
        } catch (err) {
          errors.push(`${cityKey} "${q}": ${err.message}`);
        }
      }
      properties[cityKey] = merged;
    }
    const total = Object.values(properties).reduce((n, a) => n + a.length, 0);
    return writeSection('hotels', {
      status: total ? 'live' : (errors.length ? 'error' : 'seed'),
      data: { checkIn, checkOut, properties, errors },
      notes: total
        ? `SerpAPI google_hotels: ${total} live property rates for ${checkIn} (${calls} searches). Public rates - book via the member/express link for the real member price.`
        : `google_hotels returned no rates${errors.length ? ` (${errors.slice(0, 2).join('; ')})` : ''}. Using seed ranges.`,
    });
  } catch (err) {
    return writeSection('hotels', {
      status: 'error',
      data: { checkIn, checkOut },
      notes: `Hotels sync failed: ${err.message}. Using seed ranges.`,
    });
  }
}
