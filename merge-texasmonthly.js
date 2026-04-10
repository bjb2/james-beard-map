/**
 * merge-texasmonthly.js
 *
 * Merges Texas Monthly Top 50 BBQ data into awards.json.
 *   - Restaurants already in awards.json (JBF/Michelin) get tmAward + tmYears annotated
 *   - TM-only restaurants are appended as new records (source: 'texasmonthly')
 *   - One record per year per restaurant (consistent with JBF pattern)
 *
 * Reads:  data/texasmonthly_raw.csv
 *         data/google-tm-cache.json   (from enrich-texasmonthly.js)
 *         data/awards.json
 * Writes: data/awards.json  (idempotent — strips prior TM records first)
 *
 * Usage: node merge-texasmonthly.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CSV_PATH    = path.join(__dirname, 'data', 'texasmonthly_raw.csv');
const CACHE_PATH  = path.join(__dirname, 'data', 'google-tm-cache.json');
const AWARDS_PATH = path.join(__dirname, 'data', 'awards.json');

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const parts = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (parts[i] || '').trim(); });
    return obj;
  });
}

// ── Name matching (same approach as merge-michelin.js) ────────────────────────
function nameWords(s) {
  return (s || '').toLowerCase().split(/[\s\-&,'/()]+/).filter(w => w.length >= 3);
}
function namesMatch(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  return wa.some(w => wb.some(v => v.includes(w) || w.includes(v)));
}
function citiesMatch(a, b) {
  return (a || '').toLowerCase().trim() === (b || '').toLowerCase().trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const rows   = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const cache  = fs.existsSync(CACHE_PATH)
    ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    : {};

  // Strip previously merged TM records so the script is idempotent
  const baseAwards = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'))
    .filter(a => a.source !== 'texasmonthly');

  console.log(`Base awards (non-TM): ${baseAwards.length}`);
  console.log(`TM rows: ${rows.length} | Cache entries: ${Object.keys(cache).length}`);

  // Group TM rows by name+city to collect all years for each restaurant
  const restaurantYears = new Map();
  for (const row of rows) {
    const key  = `${row.name}|${row.city}`;
    const year = parseInt((row.award || '').split('_')[0], 10) || null;
    if (!restaurantYears.has(key)) restaurantYears.set(key, { row, years: [] });
    if (year && !restaurantYears.get(key).years.includes(year)) {
      restaurantYears.get(key).years.push(year);
    }
  }

  // Build city lookup of base awards for cross-source annotation
  const baseByCity = new Map();
  for (const a of baseAwards) {
    const cityKey = (a.city || '').toLowerCase().trim();
    if (!baseByCity.has(cityKey)) baseByCity.set(cityKey, []);
    baseByCity.get(cityKey).push(a);
  }

  const matched = new Set();
  let annotated = 0;

  // Annotate existing awards records that match a TM restaurant
  const enrichedBase = baseAwards.map(a => {
    const cityKey    = (a.city || '').toLowerCase().trim();
    const candidates = [...(restaurantYears.values())].filter(({ row }) =>
      citiesMatch(row.city, a.city)
    );
    const restName = a.restaurant || a.name || '';
    const match    = candidates.find(({ row }) => namesMatch(restName, row.name));
    if (!match) return a;
    matched.add(`${match.row.name}|${match.row.city}`);
    annotated++;
    return {
      ...a,
      tmAward: 'Top 50 BBQ',
      tmYears: match.years.sort(),
    };
  });

  // Build TM-only records for unmatched entries (one record per year)
  const tmRecords = [];
  for (const [key, { row, years }] of restaurantYears.entries()) {
    if (matched.has(key)) continue;   // already annotated an existing record

    const cacheKey = `${row.name}|${row.city}|Texas`;
    const cached   = cache[cacheKey] || {};

    for (const year of years.sort()) {
      tmRecords.push({
        source:         'texasmonthly',
        restaurant:     row.name,
        city:           row.city,
        state:          'Texas',
        address:        cached.formattedAddress || `${row.address}, ${row.city}, TX`,
        lat:            cached.lat  ?? null,
        lng:            cached.lng  ?? null,
        precise:        !!(cached.lat && cached.lng),
        tmAward:        'Top 50 BBQ',
        tmYear:         year,
        businessStatus: cached.businessStatus || null,
        googlePhoto:    cached.photoUrl       || null,
        website:        cached.website        || null,
        cuisineTags:    ['BBQ', 'Texas BBQ'],
      });
    }
  }

  const merged = [...enrichedBase, ...tmRecords];
  fs.writeFileSync(AWARDS_PATH, JSON.stringify(merged));

  console.log(`\nResults:`);
  console.log(`  Existing records annotated with TM data: ${annotated}`);
  console.log(`  TM-only records added:                   ${tmRecords.length}`);
  console.log(`  Total records in awards.json:            ${merged.length}`);

  // Breakdown of TM-only by year
  const byYear = {};
  tmRecords.forEach(r => byYear[r.tmYear] = (byYear[r.tmYear] || 0) + 1);
  console.log('\nTM-only by year:');
  Object.entries(byYear).sort().forEach(([y, n]) => console.log(`  ${y}: ${n} restaurants`));

  const uncached = [...restaurantYears.keys()]
    .filter(k => !matched.has(k))
    .filter(k => {
      const row = restaurantYears.get(k).row;
      return !cache[`${row.name}|${row.city}|Texas`]?.found;
    });
  if (uncached.length) {
    console.log(`\n⚠ ${uncached.length} restaurants not yet in cache — run enrich-texasmonthly.js first`);
  }
}

main();
