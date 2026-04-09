/**
 * fetch-michelin.js
 *
 * Downloads and parses the ngshiheng/michelin-my-maps CSV into
 * data/michelin.json — a clean array of restaurant objects.
 *
 * Usage: node fetch-michelin.js
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CSV_URL   = 'https://raw.githubusercontent.com/ngshiheng/michelin-my-maps/main/data/michelin_my_maps.csv';
const OUT_FILE  = path.join(__dirname, 'data', 'michelin.json');

// Normalize award label to a consistent short form
function normalizeAward(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s === '3 Stars')               return '3 Stars';
  if (s === '2 Stars')               return '2 Stars';
  if (s === '1 Star')                return '1 Star';
  if (s === 'Bib Gourmand')          return 'Bib Gourmand';
  if (s === 'Selected Restaurants')  return 'Selected';
  return s;
}

// Minimal RFC-4180 CSV parser (handles quoted fields with embedded commas/newlines)
function parseCSV(text) {
  const rows = [];
  let i = 0, n = text.length;

  while (i < n) {
    const row = [];
    while (i < n) {
      if (text[i] === '"') {
        // Quoted field
        let field = '';
        i++; // skip opening quote
        while (i < n) {
          if (text[i] === '"' && text[i+1] === '"') { field += '"'; i += 2; }
          else if (text[i] === '"') { i++; break; }
          else { field += text[i++]; }
        }
        row.push(field);
        if (text[i] === ',') i++;
      } else {
        // Unquoted field
        let start = i;
        while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') i++;
        row.push(text.slice(start, i));
        if (text[i] === ',') i++;
      }
      if (i >= n || text[i] === '\n' || text[i] === '\r') break;
    }
    // Skip line endings
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;

    if (row.length > 1) rows.push(row);
  }
  return rows;
}

async function main() {
  console.log('Downloading Michelin CSV…');
  const res = await axios.get(CSV_URL, { responseType: 'text', timeout: 30000 });
  const rows = parseCSV(res.data);

  const header = rows[0].map(h => h.trim());
  const C = {};
  header.forEach((h, i) => C[h] = i);

  console.log(`Parsed ${rows.length - 1} rows`);
  console.log('Columns:', header.join(', '));

  const records = [];
  for (const row of rows.slice(1)) {
    if (row.length < header.length - 2) continue; // skip malformed rows

    const lat = parseFloat(row[C['Latitude']]);
    const lng = parseFloat(row[C['Longitude']]);
    const location = (row[C['Location']] || '').trim(); // "City, Country"
    const parts = location.split(',').map(p => p.trim());
    const country = parts.pop() || '';
    const city    = parts.join(', ') || '';

    records.push({
      restaurant:   (row[C['Name']]       || '').trim(),
      city,
      country,
      address:      (row[C['Address']]    || '').trim(),
      lat:          isNaN(lat) ? null : lat,
      lng:          isNaN(lng) ? null : lng,
      michelinAward: normalizeAward(row[C['Award']]),
      greenStar:    row[C['GreenStar']] === '1',
      cuisine:      (row[C['Cuisine']]    || '').trim(),
      price:        (row[C['Price']]      || '').trim() || null,
      website:      (row[C['WebsiteUrl']] || '').trim() || null,
      michelinUrl:  (row[C['Url']]        || '').trim() || null,
      phone:        (row[C['PhoneNumber']]|| '').trim() || null,
      // Description intentionally omitted — too large
    });
  }

  // Summary
  const byAward = {};
  records.forEach(r => byAward[r.michelinAward] = (byAward[r.michelinAward]||0)+1);
  console.log('\nBy award:');
  Object.entries(byAward).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${v.toString().padStart(5)}  ${k}`));

  const withCoords = records.filter(r => r.lat && r.lng).length;
  console.log(`\nWith coordinates: ${withCoords} / ${records.length}`);

  fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
  console.log(`\nSaved → ${OUT_FILE}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
