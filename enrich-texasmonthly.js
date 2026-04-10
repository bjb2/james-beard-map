/**
 * enrich-texasmonthly.js
 *
 * Enriches Texas Monthly Top 50 BBQ restaurants with Google Places data:
 *   - lat / lng
 *   - business_status
 *   - photo (Google photo URL)
 *   - website
 *   - formatted_address
 *
 * Reads:  data/texasmonthly_raw.csv
 * Cache:  data/google-tm-cache.json  (safe to re-run — skips cached entries)
 * Key:    .key.txt  { "google-key": "AIza..." }
 *
 * Usage:
 *   node enrich-texasmonthly.js          # enrich all unique restaurants
 *   node enrich-texasmonthly.js --test   # run 1 restaurant only
 */

'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const TEST_MODE  = process.argv.includes('--test');
const CSV_PATH   = path.join(__dirname, 'data', 'texasmonthly_raw.csv');
const CACHE_PATH = path.join(__dirname, 'data', 'google-tm-cache.json');
const KEY_PATH   = path.join(__dirname, '.key.txt');

// ── API key ───────────────────────────────────────────────────────────────────
const keyData = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const API_KEY = keyData['google-key'];
if (!API_KEY) { console.error('No google-key in .key.txt'); process.exit(1); }

// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = {};
if (fs.existsSync(CACHE_PATH)) {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  console.log(`Loaded cache: ${Object.keys(cache).length} entries`);
}
function saveCache() { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); }

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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Google Places (New) ───────────────────────────────────────────────────────
function searchPlace(name, address, city) {
  const query = `${name} ${address} ${city} Texas`;
  const body  = JSON.stringify({ textQuery: query });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'places.googleapis.com',
      path: `/v1/places:searchText?key=${API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.businessStatus,places.websiteUri,places.photos,places.formattedAddress',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getPhotoUrl(photoName) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&key=${API_KEY}&skipHttpRedirect=true`;
  const result = await get(url);
  return result.photoUri || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));

  // Deduplicate by name+city — each restaurant only needs one Google lookup
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = `${row.name}|${row.city}`;
    if (!seen.has(key)) { seen.add(key); unique.push(row); }
  }

  let targets = unique;
  if (TEST_MODE) {
    targets = unique.slice(0, 1);
    console.log(`TEST MODE: 1 restaurant — ${targets[0].name} (${targets[0].city})`);
  } else {
    console.log(`${unique.length} unique restaurants to enrich…`);
  }

  let enriched = 0, skipped = 0, errors = 0;

  for (const row of targets) {
    const cacheKey = `${row.name}|${row.city}|Texas`;

    if (cache[cacheKey]) { skipped++; continue; }

    try {
      const result = await searchPlace(row.name, row.address, row.city);

      if (!result.places || result.places.length === 0) {
        console.log(`  NOT FOUND: ${row.name} (${row.city})`);
        cache[cacheKey] = { found: false };
        saveCache();
        await sleep(200);
        continue;
      }

      const place = result.places[0];
      const entry = {
        found:            true,
        placeId:          place.id,
        lat:              place.location?.latitude  ?? null,
        lng:              place.location?.longitude ?? null,
        businessStatus:   place.businessStatus   || null,
        website:          place.websiteUri        || null,
        formattedAddress: place.formattedAddress  || null,
        photoUrl:         null,
      };

      if (place.photos?.length) {
        try {
          entry.photoUrl = await getPhotoUrl(place.photos[0].name);
          await sleep(100);
        } catch (photoErr) {
          console.warn(`  Photo error for ${row.name}: ${photoErr.message}`);
        }
      }

      cache[cacheKey] = entry;
      saveCache();
      enriched++;

      const status   = entry.businessStatus || 'unknown';
      const hasPhoto = entry.photoUrl ? 'photo' : 'no photo';
      const coords   = entry.lat ? `${entry.lat.toFixed(4)},${entry.lng.toFixed(4)}` : 'no coords';
      console.log(`  [${enriched}] ${row.name} (${row.city}) → ${status}, ${hasPhoto}, ${coords}`);

      await sleep(200);

    } catch (err) {
      console.error(`  ERROR: ${row.name}: ${err.message}`);
      errors++;
      await sleep(500);
    }
  }

  console.log(`\nDone. enriched=${enriched}, skipped=${skipped}, errors=${errors}`);
  console.log(`Cache: ${CACHE_PATH}`);

  if (TEST_MODE) {
    const cacheKey = `${targets[0].name}|${targets[0].city}|Texas`;
    console.log('\nTest result:');
    console.log(JSON.stringify(cache[cacheKey], null, 2));
  }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
