/**
 * merge-w50best.js
 *
 * Merges data/w50best.json into data/awards.json.
 * Unmatched entries are appended as source: 'w50best'.
 * (W50Best bars rarely overlap with JBF/Michelin restaurant records,
 *  so we simply strip + re-append rather than cross-enriching.)
 *
 * Usage: node merge-w50best.js
 * Safe to re-run — strips previous w50best-only records first.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AWARDS_FILE  = path.join(__dirname, 'data', 'awards.json');
const W50BEST_FILE = path.join(__dirname, 'data', 'w50best.json');

function main() {
  const allAwards = JSON.parse(fs.readFileSync(AWARDS_FILE,  'utf8'));
  const w50best   = JSON.parse(fs.readFileSync(W50BEST_FILE, 'utf8'));

  const base = allAwards.filter(a => a.source !== 'w50best');
  console.log(`Existing records (non-w50best): ${base.length} | W50Best records: ${w50best.length}`);

  const merged = [...base, ...w50best];
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(merged));

  console.log(`\nResults:`);
  console.log(`  W50Best bars added: ${w50best.length}`);
  console.log(`  Total:              ${merged.length}`);

  const byTier = {};
  w50best.forEach(r => { byTier[r.w50bestAward || 'Unknown'] = (byTier[r.w50bestAward || 'Unknown'] || 0) + 1; });
  console.log('\nAdded by tier:');
  Object.entries(byTier).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`  ${v.toString().padStart(5)}  ${k}`)
  );
}

main();
