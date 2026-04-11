/**
 * merge-repsol.js
 *
 * Merges data/repsol.json into data/awards.json.
 * Existing records (Michelin in Spain/Portugal) that match get
 * repsolAward + repsolUrl added.
 * Unmatched entries are appended as source: 'repsol'.
 *
 * Usage: node merge-repsol.js
 * Safe to re-run — strips previous repsol-only records first.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AWARDS_FILE  = path.join(__dirname, 'data', 'awards.json');
const REPSOL_FILE  = path.join(__dirname, 'data', 'repsol.json');

function nameWords(s) {
  return (s || '').toLowerCase().split(/[\s\-&,'/()]+/).filter(w => w.length >= 3);
}
function namesMatch(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  return wa.some(w => wb.some(v => v.includes(w) || w.includes(v)));
}
function countriesMatch(a, b) {
  // Spain and Portugal — treat both as matching against null country (international)
  if (!a && !b) return true;
  return (a||'').toLowerCase() === (b||'').toLowerCase();
}

function main() {
  const allAwards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const repsol    = JSON.parse(fs.readFileSync(REPSOL_FILE, 'utf8'));

  const base = allAwards.filter(a => a.source !== 'repsol');
  console.log(`Existing records (non-repsol): ${base.length} | Repsol records: ${repsol.length}`);

  // Index by city for fast lookup
  const byCity = new Map();
  for (const r of repsol) {
    const key = (r.city || '').toLowerCase().trim();
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(r);
  }

  const matched = new Set();
  let enriched  = 0;

  const updated = base.map(a => {
    const cityKey    = (a.city || '').toLowerCase().trim();
    const candidates = byCity.get(cityKey) || [];
    const name       = a.restaurant || a.name || '';
    const match      = candidates.find(r =>
      namesMatch(name, r.restaurant) && countriesMatch(a.country, r.country)
    );
    if (!match) return a;
    matched.add(match);
    enriched++;
    return {
      ...a,
      repsolAward: match.repsolAward,
      repsolUrl:   match.repsolUrl || undefined,
    };
  });

  const repsolOnly = repsol
    .filter(r => !matched.has(r))
    .map(r => ({ ...r }));  // already in final shape from fetch script

  const merged = [...updated, ...repsolOnly];
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(merged));

  console.log(`\nResults:`);
  console.log(`  Existing records enriched: ${enriched}`);
  console.log(`  Repsol-only added:         ${repsolOnly.length}`);
  console.log(`  Total:                     ${merged.length}`);

  const byTier = {};
  repsolOnly.forEach(r => { byTier[r.repsolAward||'Unknown'] = (byTier[r.repsolAward||'Unknown']||0)+1; });
  console.log('\nAdded by tier:');
  Object.entries(byTier).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) =>
    console.log(`  ${v.toString().padStart(5)}  ${k}`)
  );
}

main();
