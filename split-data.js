// split-data.js
// Splits data/awards.json into priority-ordered chunks for progressive loading:
//   data/awards-p1.json  — Michelin 3★ + 2★  (small, loads first)
//   data/awards-p2.json  — JBF records        (core feature)
//   data/awards-p3.json  — Michelin 1★        (large, loads last)
//
// Run after any enrichment that modifies awards.json:
//   node split-data.js

const fs = require('fs');
const path = require('path');

const awards = JSON.parse(fs.readFileSync('./data/awards.json', 'utf8'));

const p1 = awards.filter(r => r.source === 'michelin' && (r.michelinAward === '3 Stars' || r.michelinAward === '2 Stars'));
const p2 = awards.filter(r => r.source !== 'michelin');
const p3 = awards.filter(r => r.source === 'michelin' && (r.michelinAward === '1 Star' || r.michelinAward === 'Bib Gourmand'));
const p4 = awards.filter(r => r.source === 'michelin' && r.michelinAward === 'Selected');

const files = [
  ['data/awards-p1.json', p1, 'Michelin 3★ + 2★'],
  ['data/awards-p2.json', p2, 'JBF'],
  ['data/awards-p3.json', p3, 'Michelin 1★ + Bib Gourmand'],
  ['data/awards-p4.json', p4, 'Michelin Selected'],
];

for (const [file, data, label] of files) {
  fs.writeFileSync(file, JSON.stringify(data));
  const size = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`${file}  ${label}: ${data.length} records, ${size} MB`);
}

console.log(`\nTotal: ${awards.length} records across 3 files`);
