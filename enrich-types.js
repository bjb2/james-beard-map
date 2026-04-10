/**
 * enrich-types.js
 *
 * Fetches Google Places types for JBF organizations and Michelin star
 * restaurants, then maps them to cuisineCategory + fills missing photos.
 *
 * Two passes:
 *  1. For restaurants already cached (have placeId) → Place Details
 *     with field mask "types,primaryType" (Basic tier, ~$0.003/call)
 *  2. For uncached restaurants + Michelin stars without photo → Text
 *     Search with full mask including types and photos (~$0.032/call)
 *
 * Results are stored in data/google-types-cache.json (placeId → data).
 * At the end, awards.json is updated with cuisineCategory + googlePhoto
 * and split-data.js is re-run.
 *
 * Usage:
 *   node enrich-types.js --dry-run    # show what would be fetched, no API calls
 *   node enrich-types.js --test       # fetch 3 restaurants only
 *   node enrich-types.js              # full run
 */

'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const DRY_RUN  = process.argv.includes('--dry-run');
const TEST_MODE = process.argv.includes('--test');
const TEST_LIMIT = 3;

const AWARDS_PATH     = path.join(__dirname, 'data', 'awards.json');
const JBF_CACHE_PATH  = path.join(__dirname, 'data', 'google-jbf-cache.json');
const MICH_CACHE_PATH = path.join(__dirname, 'data', 'google-cache.json');
const TYPES_CACHE_PATH = path.join(__dirname, 'data', 'google-types-cache.json');
const KEY_PATH        = path.join(__dirname, '.key.txt');

const API_KEY = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))['google-key'];
if (!API_KEY) { console.error('No google-key in .key.txt'); process.exit(1); }

// ── Google Places type → canonical cuisineCategory ────────────────────────────
// Ordered by priority (more specific wins over generic)
const GOOGLE_TYPE_MAP = {
  // BBQ
  'barbecue_restaurant':        'BBQ & Smokehouse',
  // Steakhouse
  'steak_house':                'Steakhouse',
  // Japanese
  'japanese_restaurant':        'Japanese',
  'sushi_restaurant':           'Japanese',
  'ramen_restaurant':           'Japanese',
  // Chinese
  'chinese_restaurant':         'Chinese',
  // Italian
  'italian_restaurant':         'Italian',
  'pizza_restaurant':           'Italian',
  // French
  'french_restaurant':          'French',
  // Korean
  'korean_restaurant':          'Korean',
  // Thai
  'thai_restaurant':            'Thai',
  // Indian
  'indian_restaurant':          'Indian',
  // Southeast Asian
  'vietnamese_restaurant':      'Southeast Asian',
  'indonesian_restaurant':      'Southeast Asian',
  'filipino_restaurant':        'Southeast Asian',
  // Mexican
  'mexican_restaurant':         'Mexican',
  // Mediterranean
  'mediterranean_restaurant':   'Mediterranean',
  'greek_restaurant':           'Mediterranean',
  'spanish_restaurant':         'Mediterranean',
  // Middle Eastern
  'middle_eastern_restaurant':  'Middle Eastern',
  'lebanese_restaurant':        'Middle Eastern',
  'turkish_restaurant':         'Middle Eastern',
  // Latin American
  'brazilian_restaurant':       'Latin American',
  'latin_american_restaurant':  'Latin American',
  // Seafood
  'seafood_restaurant':         'Seafood',
  // Southern & Soul
  'soul_food_restaurant':       'Southern & Soul',
  // African
  'african_restaurant':         'African',
  // American
  'american_restaurant':        'American',
  'hamburger_restaurant':       'American',
  // Vegetarian / Vegan
  'vegan_restaurant':           'Vegetarian / Vegan',
  'vegetarian_restaurant':      'Vegetarian / Vegan',
  // Bakery & Café
  'cafe':                       'Bakery & Café',
  'coffee_shop':                'Bakery & Café',
  'bakery':                     'Bakery & Café',
  'sandwich_shop':              'Bakery & Café',
  'breakfast_restaurant':       'Bakery & Café',
  'brunch_restaurant':          'Bakery & Café',
  'ice_cream_shop':             'Bakery & Café',
  // Wine & Spirits
  'wine_bar':                   'Wine & Spirits',
  'bar_and_grill':              'Bars & Cocktails',
  'bar':                        'Bars & Cocktails',
  // Junk — skip
  'restaurant':                 null,
  'food':                       null,
  'meal_delivery':              null,
  'meal_takeaway':              null,
  'fast_food_restaurant':       null,
};

// Priority order for resolving multiple types
const CATEGORY_PRIORITY = [
  'BBQ & Smokehouse', 'Steakhouse', 'Japanese', 'Chinese', 'Italian',
  'French', 'Korean', 'Thai', 'Indian', 'Southeast Asian', 'Mexican',
  'Mediterranean', 'Middle Eastern', 'Latin American', 'Seafood',
  'Southern & Soul', 'African', 'American', 'Vegetarian / Vegan',
  'Bakery & Café', 'Wine & Spirits', 'Bars & Cocktails',
];

function categoryFromTypes(types) {
  if (!types || types.length === 0) return null;
  const mapped = types
    .map(t => GOOGLE_TYPE_MAP[t])
    .filter(c => c !== undefined && c !== null);
  if (mapped.length === 0) return null;
  // Return highest-priority category
  for (const cat of CATEGORY_PRIORITY) {
    if (mapped.includes(cat)) return cat;
  }
  return mapped[0];
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function post(hostname, path, body, fieldMask) {
  const bodyStr = JSON.stringify(body);
  const options = {
    hostname,
    path: `${path}?key=${API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-FieldMask': fieldMask,
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function getPlaceDetails(placeId) {
  // Basic tier — types + primaryType only (~$0.003)
  const url = `https://places.googleapis.com/v1/places/${placeId}?key=${API_KEY}`;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'places.googleapis.com',
      path: `/v1/places/${encodeURIComponent(placeId)}?key=${API_KEY}`,
      method: 'GET',
      headers: { 'X-Goog-FieldMask': 'types,primaryType' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function searchPlace(name, city, stateOrCountry) {
  const query = [name, city, stateOrCountry].filter(Boolean).join(', ');
  const result = await post(
    'places.googleapis.com',
    '/v1/places:searchText',
    { textQuery: query },
    'places.id,places.displayName,places.businessStatus,places.websiteUri,places.photos,places.types,places.primaryType,places.formattedAddress',
  );
  return result.places?.[0] || null;
}

async function getPhotoUrl(photoName) {
  const result = await get(
    `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&key=${API_KEY}&skipHttpRedirect=true`
  );
  return result.photoUri || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const awards    = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));
  const jbfCache  = fs.existsSync(JBF_CACHE_PATH)  ? JSON.parse(fs.readFileSync(JBF_CACHE_PATH, 'utf8'))  : {};
  const michCache = fs.existsSync(MICH_CACHE_PATH)  ? JSON.parse(fs.readFileSync(MICH_CACHE_PATH, 'utf8')) : {};
  const typesCache = fs.existsSync(TYPES_CACHE_PATH) ? JSON.parse(fs.readFileSync(TYPES_CACHE_PATH, 'utf8')) : {};

  function saveTypesCache() {
    fs.writeFileSync(TYPES_CACHE_PATH, JSON.stringify(typesCache, null, 2));
  }

  // ── Build target list ───────────────────────────────────────────────────────
  // JBF organizations (all, not just precise — we want cuisine for every org)
  const jbfSeen = new Map();
  for (const r of awards) {
    if (r.source === 'michelin' || r.source === 'texasmonthly') continue;
    if (r.type !== 'organization') continue;
    const key = (r.restaurant || r.name || '') + '|' + (r.city || '') + '|' + (r.state || '');
    if (!jbfSeen.has(key)) jbfSeen.set(key, r);
  }

  // Michelin star restaurants only
  const michSeen = new Map();
  for (const r of awards) {
    if (r.source !== 'michelin') continue;
    if (!['1 Star', '2 Stars', '3 Stars'].includes(r.michelinAward)) continue;
    const key = (r.restaurant || r.name || '') + '|' + (r.city || '') + '|' + (r.country || '');
    if (!michSeen.has(key)) michSeen.set(key, r);
  }

  // Build unified list: { record, cacheEntry, kind }
  const targets = [];

  for (const [key, r] of jbfSeen) {
    const cacheKey  = (r.restaurant || r.name) + '|' + r.city + '|' + r.state;
    const cached    = jbfCache[cacheKey] || null;
    const placeId   = cached?.placeId || null;
    const needsType = !r.cuisineCategory;
    const needsPhoto = !r.googlePhoto && !(r.yelpDetail?.image) && !(cached?.photoUrl);
    if (needsType || needsPhoto) {
      targets.push({ record: r, cacheKey, cached, placeId, kind: 'jbf', needsType, needsPhoto });
    }
  }

  for (const [key, r] of michSeen) {
    const cacheKey  = `${r.source === 'michelin' ? 'ES' : r.source}:${r.restaurant || r.name}|${r.city}|${r.country}`;
    const cached    = michCache[cacheKey] || null;
    const placeId   = cached?.placeId || null;
    const needsType = !r.cuisineCategory;
    const needsPhoto = !r.googlePhoto;
    if (needsType || needsPhoto) {
      targets.push({ record: r, cacheKey, cached, placeId, kind: 'michelin', needsType, needsPhoto });
    }
  }

  const withPlaceId    = targets.filter(t => t.placeId);
  const withoutPlaceId = targets.filter(t => !t.placeId);

  console.log(`Targets:`);
  console.log(`  JBF orgs needing enrichment: ${targets.filter(t => t.kind === 'jbf').length}`);
  console.log(`  Michelin stars needing enrichment: ${targets.filter(t => t.kind === 'michelin').length}`);
  console.log(`  Have placeId (Place Details): ${withPlaceId.length}`);
  console.log(`  No placeId (Text Search):     ${withoutPlaceId.length}`);
  console.log(`  Est. cost: $${((withPlaceId.length * 0.003) + (withoutPlaceId.length * 0.032)).toFixed(2)}`);

  if (DRY_RUN) {
    console.log('\nDry run — no API calls.');
    // Show a sample of what would be fetched
    console.log('\nSample targets (first 5):');
    targets.slice(0, 5).forEach(t =>
      console.log(`  [${t.kind}] ${t.record.restaurant || t.record.name} (${t.record.city}) placeId=${t.placeId || 'none'} needsType=${t.needsType} needsPhoto=${t.needsPhoto}`)
    );
    return;
  }

  let toProcess = targets;
  if (TEST_MODE) {
    toProcess = targets.slice(0, TEST_LIMIT);
    console.log(`\nTEST MODE: processing ${TEST_LIMIT} restaurants`);
  }

  // ── Phase 1: Place Details for restaurants with placeId ────────────────────
  const phase1 = toProcess.filter(t => t.placeId);
  console.log(`\nPhase 1: Place Details for ${phase1.length} restaurants…`);

  let done1 = 0;
  for (const t of phase1) {
    if (typesCache[t.placeId]) {
      done1++;
      continue; // already fetched
    }
    try {
      const details = await getPlaceDetails(t.placeId);
      typesCache[t.placeId] = {
        types:       details.types       || [],
        primaryType: details.primaryType || null,
      };
      if (++done1 % 200 === 0) {
        saveTypesCache();
        process.stdout.write(`  ${done1} / ${phase1.length}\r`);
      }
      await sleep(50); // ~20 req/s — well under quota
    } catch (err) {
      console.error(`\n  ERROR ${t.record.restaurant}: ${err.message}`);
      await sleep(500);
    }
  }
  saveTypesCache();
  console.log(`  Phase 1 done. ${done1} processed.`);

  // ── Phase 2: Text Search for restaurants without placeId ───────────────────
  const phase2 = toProcess.filter(t => !t.placeId);
  console.log(`\nPhase 2: Text Search for ${phase2.length} restaurants…`);

  let done2 = 0, notFound2 = 0;
  for (const t of phase2) {
    const r = t.record;
    const stateOrCountry = r.state || r.country || '';
    try {
      const place = await searchPlace(r.restaurant || r.name, r.city, stateOrCountry);
      if (!place) {
        console.log(`  NOT FOUND: ${r.restaurant || r.name} (${r.city})`);
        notFound2++;
        await sleep(300);
        continue;
      }

      // Store types
      if (place.id && !typesCache[place.id]) {
        typesCache[place.id] = {
          types:       place.types       || [],
          primaryType: place.primaryType || null,
        };
      }

      // Fetch photo if needed and available
      let photoUrl = null;
      if (t.needsPhoto && place.photos && place.photos.length > 0) {
        try {
          photoUrl = await getPhotoUrl(place.photos[0].name);
          await sleep(100);
        } catch (e) {
          console.warn(`  Photo error for ${r.restaurant}: ${e.message}`);
        }
      }

      // Update the source cache so it has placeId + photo for future runs
      if (t.kind === 'jbf') {
        jbfCache[t.cacheKey] = {
          ...(jbfCache[t.cacheKey] || {}),
          found:           true,
          placeId:         place.id,
          businessStatus:  place.businessStatus  || null,
          website:         place.websiteUri       || null,
          formattedAddress: place.formattedAddress || null,
          photoUrl,
        };
        fs.writeFileSync(JBF_CACHE_PATH, JSON.stringify(jbfCache, null, 2));
      }

      if (++done2 % 50 === 0) saveTypesCache();
      process.stdout.write(`  ${done2} / ${phase2.length}\r`);
      await sleep(300);
    } catch (err) {
      console.error(`\n  ERROR ${r.restaurant}: ${err.message}`);
      await sleep(1000);
    }
  }
  saveTypesCache();
  console.log(`  Phase 2 done. found=${done2}, notFound=${notFound2}`);

  // ── Apply results back to awards.json ──────────────────────────────────────
  console.log('\nApplying enrichment to awards.json…');

  // Build placeId lookup from caches
  const keyToPlaceId = new Map();
  for (const [k, v] of Object.entries(jbfCache)) {
    if (v.placeId) keyToPlaceId.set('jbf:' + k, { placeId: v.placeId, photoUrl: v.photoUrl });
  }
  for (const [k, v] of Object.entries(michCache)) {
    if (v.placeId) keyToPlaceId.set('mich:' + k, { placeId: v.placeId, photoUrl: v.photoUrl });
  }

  let cuisineApplied = 0, photoApplied = 0;

  const updated = awards.map(a => {
    const isMichelin = a.source === 'michelin';
    const isTM       = a.source === 'texasmonthly';
    if (isTM) return a;

    // Already has both — skip
    if (a.cuisineCategory && a.googlePhoto) return a;

    let placeId   = null;
    let photoUrl  = null;

    if (!isMichelin) {
      // JBF
      if (a.type !== 'organization') return a;
      const cacheKey = (a.restaurant || a.name) + '|' + (a.city || '') + '|' + (a.state || '');
      const entry    = jbfCache[cacheKey];
      if (entry?.placeId) { placeId = entry.placeId; photoUrl = entry.photoUrl; }
    } else {
      // Michelin
      if (!['1 Star', '2 Stars', '3 Stars'].includes(a.michelinAward)) return a;
      const cacheKey = `ES:${a.restaurant || a.name}|${a.city}|${a.country}`;
      const entry    = michCache[cacheKey];
      if (entry?.placeId) { placeId = entry.placeId; photoUrl = entry.photoUrl; }
    }

    if (!placeId) return a;

    const typeData   = typesCache[placeId];
    const newCategory = (!a.cuisineCategory && typeData)
      ? categoryFromTypes(typeData.types)
      : null;
    const newPhoto   = (!a.googlePhoto && photoUrl) ? photoUrl : null;

    if (!newCategory && !newPhoto) return a;

    const updated = { ...a };
    if (newCategory) { updated.cuisineCategory = newCategory; cuisineApplied++; }
    if (newPhoto)    { updated.googlePhoto = newPhoto;         photoApplied++;  }
    return updated;
  });

  console.log(`  cuisineCategory applied: ${cuisineApplied}`);
  console.log(`  googlePhoto applied:     ${photoApplied}`);

  fs.writeFileSync(AWARDS_PATH, JSON.stringify(updated));
  console.log('  Wrote awards.json');

  const { execSync } = require('child_process');
  execSync('node split-data.js', { stdio: 'inherit' });

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
