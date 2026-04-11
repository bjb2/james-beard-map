// split-data.js
// Splits data/awards.json into priority-ordered chunks for progressive loading:
//   data/awards-p1.json  — Michelin 3★ + 2★          (small, loads first)
//   data/awards-p2.json  — JBF + Texas Monthly records (core feature)
//   data/awards-p3.json  — Michelin 1★ + Bib Gourmand
//   data/awards-p4.json  — Michelin Selected
//   data/awards-p5.json  — Tabelog Award (Japan)
//   data/awards-p6.json  — AA Rosettes (UK)
//   data/awards-p7.json  — Guía Repsol Soles (Spain + Portugal)
//
// Run after any enrichment that modifies awards.json:
//   node split-data.js

const fs = require('fs');
const path = require('path');

const awards = JSON.parse(fs.readFileSync('./data/awards.json', 'utf8'));

const OTHER = ['michelin','tabelog','aarosette','repsol'];
const p1 = awards.filter(r => r.source === 'michelin' && (r.michelinAward === '3 Stars' || r.michelinAward === '2 Stars'));
const p2 = awards.filter(r => !OTHER.includes(r.source));
const p3 = awards.filter(r => r.source === 'michelin' && (r.michelinAward === '1 Star' || r.michelinAward === 'Bib Gourmand'));
const p4 = awards.filter(r => r.source === 'michelin' && r.michelinAward === 'Selected');
const p5 = awards.filter(r => r.source === 'tabelog');
const p6 = awards.filter(r => r.source === 'aarosette');
const p7 = awards.filter(r => r.source === 'repsol');

const files = [
  ['data/awards-p1.json', p1, 'Michelin 3★ + 2★'],
  ['data/awards-p2.json', p2, 'JBF + Texas Monthly'],
  ['data/awards-p3.json', p3, 'Michelin 1★ + Bib Gourmand'],
  ['data/awards-p4.json', p4, 'Michelin Selected'],
  ['data/awards-p5.json', p5, 'Tabelog Award (Japan)'],
  ['data/awards-p6.json', p6, 'AA Rosettes (UK)'],
  ['data/awards-p7.json', p7, 'Guía Repsol Soles'],
];

for (const [file, data, label] of files) {
  fs.writeFileSync(file, JSON.stringify(data));
  const size = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`${file}  ${label}: ${data.length} records, ${size} MB`);
}

console.log(`\nTotal: ${awards.length} records across ${files.length} files`);
