/**
 * generate-pins.js
 *
 * Reads data/awards.json and produces data/pins.json — one compact entry per
 * unique restaurant/location.  This replaces the 8-chunk progressive load with
 * a single ~2 MB file containing everything needed to render all map markers
 * and power all filters.  Full popup detail (links, address, all award years)
 * is fetched from Supabase on demand when a marker is clicked.
 *
 * Run after any merge or split step:
 *   node generate-pins.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AWARDS_FILE = path.join(__dirname, 'data', 'awards.json');
const PINS_FILE   = path.join(__dirname, 'data', 'pins.json');

// JBF records have no source field — treat any record not in this set as JBF
const NON_JBF = new Set(['michelin','texasmonthly','tabelog','aarosette','repsol','w50best']);
function src(a) { return a.source || 'jbf'; }

const JBF_STATUS_ORDER = { 'Winner': 0, 'Semifinalist': 1, 'Nominee': 2 };

function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Strip embedded state abbreviation from city before normalizing.
// e.g. "New York, NY" → "New York",  "San Antonio, TX" → "San Antonio"
const STATE_ABBR_SET = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DC','DE','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY',
]);
function normCity(city) {
  const m = (city || '').match(/^(.+),\s*([A-Z]{2})$/);
  if (m && STATE_ABBR_SET.has(m[2])) return normName(m[1].trim());
  return normName(city);
}

function bestOf(a, b, order) {
  if (a === null) return b;
  if (b === null) return a;
  return (order[a] ?? 99) <= (order[b] ?? 99) ? a : b;
}

// ── Tier orders for bestStatus computation ────────────────────────────────────

const MICHELIN_ORDER  = { '3 Stars': 0, '2 Stars': 1, '1 Star': 2, 'Bib Gourmand': 3, 'Selected': 4 };
const TABELOG_ORDER   = { 'Gold': 0, 'Silver': 1, 'Bronze': 2, 'Special Award': 3 };
const REPSOL_ORDER    = { '3 Soles': 0, '2 Soles': 1, '1 Sol': 2, 'Recommended': 3 };
const W50BEST_ORDER   = { 'Top 10': 0, 'Top 50': 1, '51-100': 2 };

function computeBestStatus(group) {
  const hasJBF     = group.some(a => !NON_JBF.has(src(a)));
  const hasTM      = group.some(a => a.source === 'texasmonthly');
  const hasTabelog = group.some(a => a.source === 'tabelog');
  const hasRosette = group.some(a => a.source === 'aarosette');
  const hasRepsol  = group.some(a => a.source === 'repsol');
  const hasW50best = group.some(a => a.source === 'w50best');

  if (hasJBF) {
    const status = group.filter(a => !NON_JBF.has(src(a)))
      .reduce((best, a) => bestOf(best, a.status, JBF_STATUS_ORDER), null);
    return { status: status || 'Nominee', tier: null };
  }
  if (hasTM)      return { status: 'texasmonthly', tier: null };
  if (hasTabelog) {
    const tier = group.filter(a => a.source === 'tabelog')
      .reduce((best, a) => bestOf(best, a.tabelogAward, TABELOG_ORDER), null);
    return { status: 'tabelog', tier };
  }
  if (hasRosette) {
    const tier = group.filter(a => a.source === 'aarosette')
      .reduce((best, a) => {
        if (!best || (a.aaRosettes || 0) > best) return a.aaRosettes;
        return best;
      }, null);
    return { status: 'aarosette', tier };
  }
  if (hasRepsol) {
    const tier = group.filter(a => a.source === 'repsol')
      .reduce((best, a) => bestOf(best, a.repsolAward, REPSOL_ORDER), null);
    return { status: 'repsol', tier };
  }
  if (hasW50best) {
    const tier = group.filter(a => a.source === 'w50best')
      .reduce((best, a) => bestOf(best, a.w50bestAward, W50BEST_ORDER), null);
    return { status: 'w50best', tier };
  }
  // Michelin only
  const tier = group.filter(a => a.source === 'michelin')
    .reduce((best, a) => bestOf(best, a.michelinAward, MICHELIN_ORDER), null);
  return { status: 'michelin', tier: tier || 'Selected' };
}

function main() {
  const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  console.log(`  ${awards.length} award records`);

  // ── Group by normalized name|city ─────────────────────────────────────────
  const groups = new Map(); // normalizedKey → award[]
  for (const a of awards) {
    const name = (a.restaurant || a.name || '').trim();
    const city = (a.city || '').trim();
    const gk   = `${normName(name)}|${normCity(city)}`;
    if (!gk || gk === '|') continue;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(a);
  }

  console.log(`  ${groups.size} unique locations`);

  // ── Build pins ────────────────────────────────────────────────────────────
  const pins = [];

  for (const [, group] of groups) {
    // Prefer precise coords (Google-geocoded) then any with coords
    const withCoords  = group.filter(a => a.lat && a.lng);
    const precise     = withCoords.find(a => a.precise) || withCoords[0] || group[0];
    if (!precise.lat || !precise.lng) continue; // skip ungeocoded

    const best = group.find(a => a.googlePhoto) || group[0];

    // All sources present
    const sources = [...new Set(group.map(src))];

    // JBF fields
    const jbfRecords  = group.filter(a => !NON_JBF.has(src(a)));
    const jbfStatus   = jbfRecords.length ? jbfRecords.reduce((b, a) => bestOf(b, a.status, JBF_STATUS_ORDER), null) : undefined;
    const years       = jbfRecords.length ? [...new Set(jbfRecords.map(a => a.year).filter(Boolean))].sort((a,b) => b - a) : undefined;
    const categories  = jbfRecords.length ? [...new Set(jbfRecords.map(a => a.category).filter(Boolean))].sort() : undefined;

    // Texas Monthly
    const tmRecords = group.filter(a => a.source === 'texasmonthly');
    const tmYears   = tmRecords.length ? [...new Set(tmRecords.map(a => a.tmYear).filter(Boolean))].sort((a,b) => b - a) : undefined;

    // Michelin
    const michelinRecords = group.filter(a => a.source === 'michelin');
    const michelinAward   = michelinRecords.reduce((b, a) => bestOf(b, a.michelinAward, MICHELIN_ORDER), null);

    // Tabelog
    const tabelogRec  = group.find(a => a.source === 'tabelog');
    const tabelogAward = tabelogRec?.tabelogAward || null;
    const tabelogScore = tabelogRec?.tabelogScore || null;

    // AA Rosettes
    const aaRec     = group.find(a => a.source === 'aarosette');
    const aaRosettes = aaRec?.aaRosettes || null;

    // Repsol
    const repsolRec   = group.find(a => a.source === 'repsol');
    const repsolAward = repsolRec?.repsolAward || null;

    // W50 Best
    const w50Rec     = group.find(a => a.source === 'w50best');
    const w50bestRank  = w50Rec?.w50bestRank  || null;
    const w50bestAward = w50Rec?.w50bestAward || null;

    // Best status for marker rendering
    const { status, tier } = computeBestStatus(group);

    // Key for Supabase lookup (match seed-restaurants.js makeKey)
    const name    = (precise.restaurant || precise.name || '').trim();
    const city    = (precise.city   || '').trim();
    const state   = (precise.state  || '').trim() || null;
    const country = (precise.country || '').trim() || null;
    // Replicate makeKey: name|city|state_or_country
    const place   = state || country || '';
    const supaKey = [name, city, place].join('|');

    // Build pin — omit fields that are null/undefined so JSON stays slim
    const pin = {
      key:    supaKey,
      name,
      city:   city   || undefined,
      state:  state  || undefined,
      country: country || undefined,
      lat:    precise.lat,
      lng:    precise.lng,
      status,
      tier:   tier   || undefined,
      sources,
      photo:  best.googlePhoto  || undefined,
      cu:     best.cuisineCategory || undefined,  // cuisineCategory
      bs:     best.businessStatus  || undefined,  // businessStatus
      // JBF (only present when location has JBF records)
      jbf:    jbfStatus  || undefined,
      yrs:    (years?.length)      ? years      : undefined,
      cats:   (categories?.length) ? categories : undefined,
      // TM
      tmy:    (tmYears?.length)    ? tmYears    : undefined,
      // Michelin
      ma:     michelinAward  || undefined,
      // Tabelog
      ta:     tabelogAward   || undefined,
      ts:     tabelogScore   || undefined,
      // AA Rosettes
      aa:     aaRosettes     || undefined,
      // Repsol
      ra:     repsolAward    || undefined,
      // W50 Best
      wr:     w50bestRank    || undefined,
      wa:     w50bestAward   || undefined,
    };
    pins.push(pin);
  }

  const json = JSON.stringify(pins);
  fs.writeFileSync(PINS_FILE, json);

  const sizeMB = (fs.statSync(PINS_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`\nSaved → ${PINS_FILE}`);
  console.log(`  ${pins.length} pins, ${sizeMB} MB`);

  // Source breakdown
  const bySource = {};
  for (const p of pins) {
    for (const s of p.sources) bySource[s] = (bySource[s] || 0) + 1;
  }
  console.log('\nPins by source:');
  Object.entries(bySource).sort((a,b) => b[1]-a[1]).forEach(([s, n]) =>
    console.log(`  ${n.toString().padStart(6)}  ${s}`)
  );
}

main();
