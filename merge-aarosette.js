/**
 * merge-aarosette.js
 *
 * Merges data/aarosette.json into data/awards.json.
 * Existing records that match by name+city get aaRosettes + aaRosetteUrl added.
 * Unmatched entries are appended as source: 'aarosette'.
 *
 * Usage: node merge-aarosette.js
 * Safe to re-run — strips previous aarosette-only records first.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AWARDS_FILE   = path.join(__dirname, 'data', 'awards.json');
const ROSETTE_FILE  = path.join(__dirname, 'data', 'aarosette.json');

function nameWords(s) {
  return (s || '').toLowerCase().split(/[\s\-&,'/()]+/).filter(w => w.length >= 3);
}
function namesMatch(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  return wa.some(w => wb.some(v => v.includes(w) || w.includes(v)));
}
function citiesMatch(a, b) {
  return (a||'').toLowerCase().trim() === (b||'').toLowerCase().trim();
}

function main() {
  const allAwards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const rosettes  = JSON.parse(fs.readFileSync(ROSETTE_FILE, 'utf8'));

  const base = allAwards.filter(a => a.source !== 'aarosette');
  console.log(`Existing records (non-aarosette): ${base.length} | AA Rosette records: ${rosettes.length}`);

  const byCity = new Map();
  for (const r of rosettes) {
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
    const match      = candidates.find(r => namesMatch(name, r.restaurant));
    if (!match) return a;
    matched.add(match);
    enriched++;
    return { ...a, aaRosettes: match.aaRosettes, aaRosetteUrl: match.aaRosetteUrl };
  });

  const rosetteOnly = rosettes
    .filter(r => !matched.has(r))
    .map(r => ({ ...r }));   // already in final shape from fetch script

  const merged = [...updated, ...rosetteOnly];
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(merged));

  console.log(`\nResults:`);
  console.log(`  Existing records enriched: ${enriched}`);
  console.log(`  AA Rosette-only added:     ${rosetteOnly.length}`);
  console.log(`  Total:                     ${merged.length}`);

  const byRosette = {};
  rosetteOnly.forEach(r => { byRosette[r.aaRosettes] = (byRosette[r.aaRosettes]||0)+1; });
  console.log('\nAdded by rosette count:');
  Object.entries(byRosette).sort((a,b)=>b[0]-a[0]).forEach(([k,v]) =>
    console.log(`  ${v.toString().padStart(5)}  ${k} rosettes`)
  );
}

main();
