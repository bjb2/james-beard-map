/**
 * yelp-enrich.js
 *
 * Uses the Yelp Places API to resolve restaurants still stuck at city-level
 * coordinates, and collect cuisine categories for all restaurants.
 *
 * Each Yelp /businesses/search call returns: address, precise coordinates,
 * and cuisine categories in a single request.
 *
 * Strategy (to stay well within the 5000/month free tier):
 *   Pass 1 — 635 restaurants with no address/coords  → ~635 calls
 *   Pass 2 — top restaurants by award count that lack cuisine data → remainder
 *
 * Outputs:
 *   data/city-level-fixes.csv   — correct_lat/lng + Address filled in
 *   data/cuisine-cache.json     — restaurant|city|state → [categories]
 *   data/yelp-cache.json        — raw Yelp results cache (resumable)
 *
 * Run:  node yelp-enrich.js
 * Safe to re-run — cached entries and already-resolved rows are skipped.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const KEYS         = JSON.parse(fs.readFileSync(path.join(__dirname, '.key.txt'), 'utf8'));
const YELP_KEY     = KEYS['yelp-key'];
const CSV_FILE     = path.join(__dirname, 'data', 'city-level-fixes.csv');
const CUISINE_FILE = path.join(__dirname, 'data', 'cuisine-cache.json');
const YELP_CACHE   = path.join(__dirname, 'data', 'yelp-cache.json');

const YELP_SEARCH  = 'https://api.yelp.com/v3/businesses/search';

// Column indices: restaurant,city,state,count,cur_lat,cur_lng,correct_lat,correct_lng,Address
const C = { name:0, city:1, state:2, count:3, cur_lat:4, cur_lng:5, ok_lat:6, ok_lng:7, addr:8 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CSV helpers ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  return {
    header: lines[0],
    rows: lines.slice(1).map(line => {
      const f = []; let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) { f.push(cur); cur = ''; }
        else cur += ch;
      }
      f.push(cur);
      return f;
    })
  };
}

function toCSVLine(f) {
  return f.map(v => {
    const s = String(v == null ? '' : v);
    return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

function saveCSV(header, rows) {
  fs.writeFileSync(CSV_FILE, [header, ...rows.map(toCSVLine)].join('\n'));
}

// ── Yelp search ───────────────────────────────────────────────────────────────
async function yelpSearch(restaurant, city, state) {
  try {
    const res = await axios.get(YELP_SEARCH, {
      headers: { Authorization: `Bearer ${YELP_KEY}` },
      params: {
        term: restaurant,
        location: `${city}, ${state}`,
        limit: 5,
        categories: 'restaurants,food'
      },
      timeout: 10000
    });

    const businesses = res.data?.businesses || [];
    const words = restaurant.toLowerCase().split(/[\s\-&,'/]+/).filter(w => w.length >= 3);

    for (const biz of businesses) {
      const name = (biz.name || '').toLowerCase();
      if (!words.some(w => name.includes(w))) continue;

      const loc = biz.location || {};
      const parts = [loc.address1, loc.city, loc.state, loc.zip_code].filter(Boolean);
      const categories = (biz.categories || []).map(c => c.title);

      return {
        address:    parts.join(', '),
        lat:        biz.coordinates?.latitude,
        lng:        biz.coordinates?.longitude,
        categories,
        name:       biz.name,
        url:        biz.url,
        rating:     biz.rating,
        image:      biz.image_url
      };
    }
  } catch (e) {
    if (e.response?.status === 429) {
      console.log('\n  Rate limited — waiting 60s...');
      await sleep(60000);
    }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { header, rows } = parseCSV(fs.readFileSync(CSV_FILE, 'utf8'));
  const cuisineCache = fs.existsSync(CUISINE_FILE)
    ? JSON.parse(fs.readFileSync(CUISINE_FILE, 'utf8')) : {};
  const yelpCache = fs.existsSync(YELP_CACHE)
    ? JSON.parse(fs.readFileSync(YELP_CACHE, 'utf8')) : {};

  // ── Pass 1: restaurants with no coords yet ──────────────────────────────────
  const needCoords = rows.filter(r => !String(r[C.ok_lat] || '').trim());
  console.log(`\n━━━ Pass 1: ${needCoords.length} restaurants still missing coordinates ━━━`);

  let done = 0, found = 0;
  for (const row of needCoords) {
    const restaurant = row[C.name].trim();
    const city       = row[C.city].trim();
    const state      = row[C.state].trim();
    const cacheKey   = `${restaurant}|${city}|${state}`;
    done++;

    process.stdout.write(`\r[${done}/${needCoords.length}] ${restaurant.substring(0,40).padEnd(40)}`);

    let result = yelpCache[cacheKey];
    if (result === undefined) {
      result = await yelpSearch(restaurant, city, state);
      yelpCache[cacheKey] = result;
      await sleep(250); // ~4 req/sec, well under Yelp limits
    }

    if (result) {
      if (!row[C.addr])   row[C.addr]   = result.address;
      if (!row[C.ok_lat]) row[C.ok_lat] = result.lat;
      if (!row[C.ok_lng]) row[C.ok_lng] = result.lng;
      if (result.categories?.length) cuisineCache[cacheKey] = result.categories;
      found++;
    }

    if (done % 25 === 0) {
      saveCSV(header, rows);
      fs.writeFileSync(CUISINE_FILE, JSON.stringify(cuisineCache, null, 2));
      fs.writeFileSync(YELP_CACHE,   JSON.stringify(yelpCache,    null, 2));
    }
  }

  saveCSV(header, rows);
  fs.writeFileSync(YELP_CACHE, JSON.stringify(yelpCache, null, 2));
  console.log(`\nPass 1 done: ${found}/${done} resolved`);

  // ── Pass 2: fill cuisine data for restaurants that don't have it yet ─────────
  const needCuisine = rows
    .filter(r => {
      const key = `${r[C.name]}|${r[C.city]}|${r[C.state]}`;
      return !cuisineCache[key] && String(r[C.ok_lat] || '').trim();
    })
    .sort((a, b) => parseInt(b[C.count]) - parseInt(a[C.count])) // highest award count first
    .slice(0, 4000); // stay within monthly limit

  console.log(`\n━━━ Pass 2: cuisine enrichment for ${needCuisine.length} restaurants ━━━`);

  done = 0; found = 0;
  for (const row of needCuisine) {
    const restaurant = row[C.name].trim();
    const city       = row[C.city].trim();
    const state      = row[C.state].trim();
    const cacheKey   = `${restaurant}|${city}|${state}`;
    done++;

    process.stdout.write(`\r[${done}/${needCuisine.length}] ${restaurant.substring(0,40).padEnd(40)}`);

    let result = yelpCache[cacheKey];
    if (result === undefined) {
      result = await yelpSearch(restaurant, city, state);
      yelpCache[cacheKey] = result;
      await sleep(250);
    }

    if (result?.categories?.length) {
      cuisineCache[cacheKey] = result.categories;
      found++;
    }

    if (done % 25 === 0) {
      fs.writeFileSync(CUISINE_FILE, JSON.stringify(cuisineCache, null, 2));
      fs.writeFileSync(YELP_CACHE,   JSON.stringify(yelpCache,    null, 2));
    }
  }

  fs.writeFileSync(CUISINE_FILE, JSON.stringify(cuisineCache, null, 2));
  fs.writeFileSync(YELP_CACHE,   JSON.stringify(yelpCache,    null, 2));
  console.log(`\nPass 2 done: ${found}/${done} cuisine entries added`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const { rows: finalRows } = parseCSV(fs.readFileSync(CSV_FILE, 'utf8'));
  const withCoords  = finalRows.filter(r => String(r[C.ok_lat] || '').trim()).length;
  const withCuisine = Object.keys(cuisineCache).length;
  const yelpCalls   = Object.keys(yelpCache).length;

  console.log(`\n✅ Done`);
  console.log(`   Precise coordinates: ${withCoords}/${finalRows.length}`);
  console.log(`   Cuisine categories:  ${withCuisine}`);
  console.log(`   Yelp calls used:     ${yelpCalls} (of 5000/month)`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
