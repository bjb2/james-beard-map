/**
 * James Beard Awards — Multi-phase geocoder
 *
 * Phase 1: Geocode all unique city+state combos (Nominatim, 1 req/sec)
 *          → Gives city-level pins for all 10,828 located awards
 *
 * Phase 2: Try precise restaurant geocoding via Photon (OSM)
 *          → Upgrades pins to exact restaurant locations where found
 *          Query: "<restaurant name>, <city>, <state>"
 *
 * Phase 3: Resolve 111 awards with no city/state by searching by name only
 *          → Fills in missing locations for no-location records
 *
 * Cache structure:
 *   data/city-cache.json          — city|state → {lat, lng}
 *   data/restaurant-cache.json    — restaurant|city|state → {lat, lng, precise}
 *   data/name-cache.json          — name → {lat, lng, city, state}
 *
 * Output: data/awards.json — all geocoded awards merged
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CITY_CACHE_FILE = path.join(DATA_DIR, 'city-cache.json');
const REST_CACHE_FILE = path.join(DATA_DIR, 'restaurant-cache.json');
const NAME_CACHE_FILE = path.join(DATA_DIR, 'name-cache.json');
const RAW_FILE = path.join(DATA_DIR, 'raw-awards.json');
const OUT_FILE = path.join(DATA_DIR, 'awards.json');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api';
const HEADERS = { 'User-Agent': 'JamesBeardAwardsMap/1.0 (educational/non-commercial)' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache(file) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {}
  }
  return {};
}

function saveCache(file, cache) {
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

// ── Common city name corrections (typos in source data) ─────────────────────
const CITY_CORRECTIONS = {
  'Calistgoa': 'Calistoga',
  'Washintong': 'Washington',
  'WASHINGTON': 'Washington',
  'San Fransisco': 'San Francisco',
  'Philadelpia': 'Philadelphia',
  'New york': 'New York',
  'New York City': 'New York',
  'asheville': 'Asheville',
  'richmond': 'Richmond',
  'denver': 'Denver',
  'chicago': 'Chicago',
  'portland': 'Portland',
  'san francisco': 'San Francisco',
  'las vegas': 'Las Vegas',
  'salt lake city': 'Salt Lake City',
  'Salt Lake CIty': 'Salt Lake City',
  'SAN ANTONIO': 'San Antonio',
  'GENEVA': 'Geneva',
  'WASHINGTON': 'Washington',
  'rockport': 'Rockport',
  'MID CITY WEST': 'Philadelphia', // approximate fix
};

function normalizeCity(city) {
  return CITY_CORRECTIONS[city] || city;
}

// ── Nominatim city-level geocoding ──────────────────────────────────────────
async function geocodeCity(city, state) {
  const normalized = normalizeCity(city);
  const queries = [
    `${normalized}, ${state}, USA`,
    `${normalized}, ${state}`
  ];
  for (const q of queries) {
    try {
      const res = await axios.get(NOMINATIM_URL, {
        params: { q, format: 'json', limit: 1, countrycodes: 'us' },
        headers: HEADERS,
        timeout: 10000
      });
      if (res.data?.length > 0) {
        return { lat: parseFloat(res.data[0].lat), lng: parseFloat(res.data[0].lon) };
      }
    } catch (e) {}
  }
  return null;
}

// ── Name overlap check: shared significant words between two names ────────────
function nameMatches(resultName, targetName) {
  if (!resultName || !targetName) return false;
  const rWords = resultName.toLowerCase().split(/[\s\-&,'/]+/).filter(w => w.length >= 3);
  const tWords = targetName.toLowerCase().split(/[\s\-&,'/]+/).filter(w => w.length >= 3);
  return rWords.some(rw => tWords.some(tw => tw.includes(rw) || rw.includes(tw)));
}

// ── Photon restaurant geocoding ──────────────────────────────────────────────
async function geocodeRestaurant(restaurant, city, state) {
  // Try two query forms: with state, then without (some OSM entries lack state tagging)
  const queries = [
    `${restaurant}, ${city}, ${state}`,
    `${restaurant}, ${city}`
  ];
  for (const query of queries) {
    try {
      const res = await axios.get(PHOTON_URL, {
        params: { q: query, limit: 5, lang: 'en' },
        headers: HEADERS,
        timeout: 8000
      });
      const features = res.data?.features || [];
      for (const f of features) {
        const p = f.properties;
        // Must be in the US
        if (p.countrycode !== 'US') continue;
        // Must be in the right state
        const resultState = (p.state || '').toLowerCase();
        const targetState = state.toLowerCase();
        if (resultState && !resultState.includes(targetState) && !targetState.includes(resultState)) continue;
        const name = (p.name || '').toLowerCase();
        // Accept if the result shares at least one significant word with the restaurant name
        if (name && nameMatches(name, restaurant)) {
          const [lng, lat] = f.geometry.coordinates;
          return { lat, lng, precise: true };
        }
      }
    } catch (e) {}
  }
  return null;
}

// ── Photon name-only geocoding (for records with no city/state) ───────────────
async function geocodeByName(name) {
  try {
    const res = await axios.get(PHOTON_URL, {
      params: { q: name, limit: 3, lang: 'en' },
      headers: HEADERS,
      timeout: 8000
    });
    const features = res.data?.features || [];
    for (const f of features) {
      const p = f.properties;
      // Only accept US results
      if (p.countrycode !== 'US') continue;
      const fName = (p.name || '').toLowerCase();
      const nameLower = name.toLowerCase();
      // Rough name match
      if (fName && (nameLower.includes(fName.substring(0, 6)) || fName.includes(nameLower.substring(0, 6)))) {
        const [lng, lat] = f.geometry.coordinates;
        const city = p.city || p.town || p.village || p.county || '';
        const state = p.state || '';
        return { lat, lng, city, state, precise: true };
      }
    }
  } catch (e) {}
  return null;
}

// ── Progress reporter ────────────────────────────────────────────────────────
function progress(done, total, msg) {
  process.stdout.write(`\r[${done}/${total}] ${msg}`.padEnd(80));
}

// ── Phase 1: City geocoding ──────────────────────────────────────────────────
async function phase1(awards) {
  console.log('\n━━━ Phase 1: City-level geocoding ━━━');
  const cityCache = loadCache(CITY_CACHE_FILE);

  // Also check for old-format geocache.json from previous runs
  const oldCache = loadCache(path.join(DATA_DIR, 'geocache.json'));
  let migrated = 0;
  for (const [k, v] of Object.entries(oldCache)) {
    const parts = k.split('|');
    if (parts.length === 2 && v) {
      const [city, state] = parts;
      const cityKey = `${city}|${state}`;
      if (!cityCache[cityKey]) { cityCache[cityKey] = v; migrated++; }
    }
    // New format city-fallback: "|city|state"
    if (parts.length === 3 && parts[0] === '' && v) {
      const cityKey = `${parts[1]}|${parts[2]}`;
      if (!cityCache[cityKey]) { cityCache[cityKey] = v; migrated++; }
    }
  }
  if (migrated > 0) {
    console.log(`Migrated ${migrated} entries from old geocache.json`);
    saveCache(CITY_CACHE_FILE, cityCache);
  }

  // Find cities to geocode
  const cities = new Map();
  for (const a of awards) {
    if (a.city && a.state) {
      const key = `${a.city}|${a.state}`;
      if (!cityCache[key]) cities.set(key, { city: a.city, state: a.state });
    }
  }

  const total = cities.size;
  const cached = Object.keys(cityCache).length;
  console.log(`Already cached: ${cached} | Need to geocode: ${total}`);
  if (total === 0) { console.log('All cities cached!'); return cityCache; }

  let done = 0, ok = 0, fail = 0;
  for (const [key, { city, state }] of cities) {
    const result = await geocodeCity(city, state);
    cityCache[key] = result;
    done++;
    if (result) ok++;
    else { fail++; console.log(`\n  FAILED: ${city}, ${state}`); }
    progress(done, total, result ? `✓ ${city}, ${state}` : `✗ FAILED: ${city}, ${state}`);
    if (done % 25 === 0) {
      saveCache(CITY_CACHE_FILE, cityCache);
      // Progressive save: update awards.json every 25 cities so the map can show new data
      buildAndSaveOutput(awards, cityCache, loadCache(REST_CACHE_FILE), loadCache(NAME_CACHE_FILE), true);
    }
    await sleep(1100);
  }

  saveCache(CITY_CACHE_FILE, cityCache);
  console.log(`\nPhase 1 done: ${ok} geocoded, ${fail} failed\n`);
  buildAndSaveOutput(awards, cityCache, loadCache(REST_CACHE_FILE), loadCache(NAME_CACHE_FILE));
  return cityCache;
}

// ── Phase 2: Restaurant-level refinement (concurrent) ────────────────────────
async function phase2(awards, cityCache) {
  console.log('\n━━━ Phase 2: Restaurant-level precision geocoding (concurrent) ━━━');
  const restCache = loadCache(REST_CACHE_FILE);

  const toGeocode = new Map();
  for (const a of awards) {
    if (!a.city || !a.state || !a.restaurant) continue;
    const key = `${a.restaurant}|${a.city}|${a.state}`;
    if (!restCache.hasOwnProperty(key)) {
      toGeocode.set(key, { restaurant: a.restaurant, city: a.city, state: a.state });
    }
  }

  const total = toGeocode.size;
  console.log(`Already cached: ${Object.keys(restCache).length} | Need to geocode: ${total}`);
  if (total === 0) { console.log('All restaurants cached!'); return restCache; }

  const CONCURRENCY = 10; // 10 parallel Photon requests
  const SAVE_EVERY = 50;
  let done = 0, precise = 0;
  const entries = [...toGeocode.entries()];

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(([key, { restaurant, city, state }]) =>
        geocodeRestaurant(restaurant, city, state).then(r => ({ key, r }))
      )
    );

    for (const { key, r } of results) {
      restCache[key] = r;
      done++;
      if (r) precise++;
    }

    progress(done, total,
      `📍 ${precise} precise | ${done - precise} city-fallback | ${total - done} left`
    );

    // Save & rebuild output every SAVE_EVERY entries
    if (done % SAVE_EVERY === 0 || done === total) {
      saveCache(REST_CACHE_FILE, restCache);
      buildAndSaveOutput(awards, cityCache, restCache, loadCache(NAME_CACHE_FILE), true);
    }

    // Small delay between chunks to be polite to Photon
    if (i + CONCURRENCY < entries.length) await sleep(200);
  }

  saveCache(REST_CACHE_FILE, restCache);
  console.log(`\nPhase 2 done: ${precise} precise pins, ${done - precise} city-level\n`);
  return restCache;
}

// ── Phase 3: Name-only geocoding for missing-location records ─────────────────
async function phase3(awards) {
  console.log('\n━━━ Phase 3: Geocoding by name for records with no city/state ━━━');
  const nameCache = loadCache(NAME_CACHE_FILE);

  const noLocation = awards.filter(a => !a.city || !a.state);
  console.log(`Records without city/state: ${noLocation.length}`);

  const toGeocode = new Map();
  for (const a of noLocation) {
    const name = a.restaurant || a.name;
    if (name && !nameCache.hasOwnProperty(name)) {
      toGeocode.set(name, name);
    }
  }

  const total = toGeocode.size;
  const cached = Object.keys(nameCache).length;
  console.log(`Already cached: ${cached} | Need to geocode: ${total}`);
  if (total === 0) { console.log('All name-only records cached!'); return nameCache; }

  let done = 0, found = 0;
  for (const [name] of toGeocode) {
    const result = await geocodeByName(name);
    nameCache[name] = result;
    done++;
    if (result) found++;
    progress(done, total, result ? `📍 ${name}` : `   skipping ${name}`);
    if (done % 50 === 0) saveCache(NAME_CACHE_FILE, nameCache);
    await sleep(300);
  }

  saveCache(NAME_CACHE_FILE, nameCache);
  console.log(`\nPhase 3 done: ${found} of ${total} resolved\n`);
  return nameCache;
}

// ── Build final output ────────────────────────────────────────────────────────
function buildAndSaveOutput(awards, cityCache, restCache, nameCache, quiet = false) {
  const geocoded = [];
  let precise = 0, cityLevel = 0, nameLevel = 0, skipped = 0;

  for (const a of awards) {
    let lat, lng, coordPrecise = false;
    let city = a.city, state = a.state;

    if (a.city && a.state) {
      // Try restaurant-level first
      const restKey = `${a.restaurant}|${a.city}|${a.state}`;
      const restResult = restCache[restKey];
      if (restResult?.precise) {
        ({ lat, lng, coordPrecise: coordPrecise = true } = restResult);
        precise++;
      } else {
        // Fall back to city-level
        const cityResult = cityCache[`${a.city}|${a.state}`];
        if (cityResult) {
          ({ lat, lng } = cityResult);
          cityLevel++;
        } else {
          skipped++;
          continue;
        }
      }
    } else {
      // Try name-only geocoding
      const name = a.restaurant || a.name;
      const nameResult = nameCache[name];
      if (nameResult) {
        ({ lat, lng } = nameResult);
        city = nameResult.city || city;
        state = nameResult.state || state;
        nameLevel++;
      } else {
        skipped++;
        continue;
      }
    }

    geocoded.push({
      ...a,
      city: city || a.city,
      state: state || a.state,
      lat,
      lng,
      precise: coordPrecise
    });
  }

  const total = geocoded.length;
  if (!quiet) {
    console.log(`\nOutput: ${total} awards with coordinates`);
    console.log(`  Precise (restaurant-level): ${precise}`);
    console.log(`  City-level:                 ${cityLevel}`);
    console.log(`  Name-only:                  ${nameLevel}`);
    console.log(`  Skipped (no coords):        ${skipped}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(geocoded));
  if (!quiet) console.log(`Saved → data/awards.json`);
  else process.stdout.write(` [${total} awards saved]`);
}

// ── Main: run Phase 1 and Phase 2 concurrently ───────────────────────────────
async function main() {
  const awards = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  console.log(`Loaded ${awards.length} Restaurant & Chef awards`);

  // Load city cache (may be partial — that's OK, Phase 2 uses what's available)
  const cityCache = loadCache(CITY_CACHE_FILE);
  console.log(`City cache: ${Object.keys(cityCache).length}/973 entries loaded`);

  // Run Phase 1 (city geocoding) and Phase 2 (restaurant geocoding) in parallel.
  // Phase 2 uses city cache as fallback — any restaurant where Photon fails
  // will use whatever city coord is available (or be skipped until Phase 1 fills it in).
  const [, restCache] = await Promise.all([
    phase1(awards),   // completes city cache, saves intermediate awards.json
    phase2(awards, cityCache)  // concurrent restaurant geocoding, saves frequently
  ]);

  const nameCache = await phase3(awards);

  // Final rebuild with complete city cache
  buildAndSaveOutput(awards, loadCache(CITY_CACHE_FILE), restCache, nameCache);
  console.log('\n✅ All done!');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
