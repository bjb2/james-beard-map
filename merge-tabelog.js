/**
 * merge-tabelog.js
 *
 * Merges data/tabelog.json into data/awards.json:
 *   - Existing records (JBF / Michelin) whose name+city match a Tabelog entry
 *     get tabelogAward, tabelogUrl, tabelogScore added
 *   - Tabelog-only restaurants are appended with source: 'tabelog'
 *
 * Matching: word-overlap on restaurant name + same city (case-insensitive).
 * Japanese name words are split on spaces AND common punctuation.
 *
 * Usage: node merge-tabelog.js
 * Safe to re-run — strips old tabelog-only records before re-merging.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AWARDS_FILE  = path.join(__dirname, 'data', 'awards.json');
const TABELOG_FILE = path.join(__dirname, 'data', 'tabelog.json');

// ── Matching helpers ──────────────────────────────────────────────────────────

function nameWords(s) {
  // Split on spaces, hyphens, punctuation, Japanese separators (、・)
  return (s || '').toLowerCase()
    .split(/[\s\-&,'/()。、・「」『』【】]+/)
    .filter(w => w.length >= 2);
}

function namesMatch(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  return wa.some(w => wb.some(v => v.includes(w) || w.includes(v)));
}

function citiesMatch(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const allAwards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const tabelog   = JSON.parse(fs.readFileSync(TABELOG_FILE, 'utf8'));

  // Strip any previously merged Tabelog-only records (idempotent re-runs)
  const prevBase = allAwards.filter(a => a.source !== 'tabelog');
  console.log(`Existing records (non-tabelog): ${prevBase.length} | Tabelog records: ${tabelog.length}`);

  // Build city → tabelog records lookup
  const byCity = new Map();
  for (const t of tabelog) {
    const key = (t.city || '').toLowerCase().trim();
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(t);
  }

  // Track which Tabelog records were matched
  const matched = new Set();

  // Annotate existing records with Tabelog data when matched
  let enriched = 0;
  const updated = prevBase.map(a => {
    const cityKey  = (a.city || '').toLowerCase().trim();
    const candidates = byCity.get(cityKey) || [];
    const restName   = a.restaurant || a.name || '';
    const match      = candidates.find(t => namesMatch(restName, t.restaurant));
    if (!match) return a;

    matched.add(match);
    enriched++;
    return {
      ...a,
      tabelogAward: match.tabelogAward || undefined,
      tabelogUrl:   match.tabelogUrl   || undefined,
      tabelogScore: match.tabelogScore || undefined,
    };
  });

  // Tabelog-only records (no match with existing JBF/Michelin entries)
  const tabelogOnly = tabelog
    .filter(t => !matched.has(t))
    .map(t => ({
      source:       'tabelog',
      restaurant:   t.restaurant,
      city:         t.city,
      country:      'Japan',
      address:      t.address   || null,
      lat:          t.lat       ?? null,
      lng:          t.lng       ?? null,
      precise:      t.precise   || false,
      tabelogAward: t.tabelogAward || null,
      tabelogScore: t.tabelogScore || null,
      tabelogUrl:   t.tabelogUrl   || null,
      cuisine:      t.cuisine      || null,
      price:        t.price        || null,
      website:      t.website      || null,
      phone:        t.phone        || null,
      photo_url:    t.photo_url    || null,
      cuisineTags:  t.cuisineTags  || [],
    }));

  const merged = [...updated, ...tabelogOnly];
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(merged));

  console.log(`\nResults:`);
  console.log(`  Existing records enriched with Tabelog data: ${enriched}`);
  console.log(`  Tabelog-only records added:                  ${tabelogOnly.length}`);
  console.log(`  Total records in awards.json:                ${merged.length}`);

  // Breakdown of appended records by tier
  const byTier = {};
  tabelogOnly.forEach(t => {
    const k = t.tabelogAward || 'Unknown';
    byTier[k] = (byTier[k] || 0) + 1;
  });
  console.log('\nTabelog-only by tier:');
  Object.entries(byTier).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`  ${v.toString().padStart(5)}  ${k}`)
  );

  console.log('\nNext step: node normalize-cuisine.js');
}

main();
