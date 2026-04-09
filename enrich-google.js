// enrich-google.js
// Enriches Michelin 1★, 2★ and 3★ restaurants with Google Places data:
//   - business_status (OPERATIONAL / CLOSED_PERMANENTLY / CLOSED_TEMPORARILY)
//   - photo (1 photo reference → fetch actual image URL)
//   - website (if not already present)
//   - formatted_address (for verification)
//
// Usage:
//   node enrich-google.js --test     # run 1 restaurant only
//   node enrich-google.js            # run all 688

const fs = require('fs');
const https = require('https');

const TEST_MODE = process.argv.includes('--test');
const AWARDS_PATH = './data/awards.json';
const CACHE_PATH = './data/google-cache.json';
const KEY_PATH = './.key.txt';

// --- Load API key ---
const keyData = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const API_KEY = keyData['google-key'];
if (!API_KEY) { console.error('No google-key found in .key.txt'); process.exit(1); }

// --- Load / init cache ---
let cache = {};
if (fs.existsSync(CACHE_PATH)) {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  console.log(`Loaded cache: ${Object.keys(cache).length} entries`);
}

function saveCache() {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// --- HTTP helper ---
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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

// --- Places API (New) ---
async function searchPlace(restaurant, city, country) {
  const query = encodeURIComponent(`${restaurant} ${city} ${country}`);
  const url = `https://places.googleapis.com/v1/places:searchText?key=${API_KEY}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ textQuery: `${restaurant} ${city} ${country}` });
    const options = {
      hostname: 'places.googleapis.com',
      path: `/v1/places:searchText?key=${API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'places.id,places.displayName,places.businessStatus,places.websiteUri,places.photos,places.formattedAddress',
        'Content-Length': Buffer.byteLength(body),
      },
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
    req.write(body);
    req.end();
  });
}

async function getPhotoUrl(photoName) {
  // photoName is like "places/ChIJ.../photos/Aaw..."
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&key=${API_KEY}&skipHttpRedirect=true`;
  const result = await get(url);
  return result.photoUri || null;
}

// --- Main ---
async function run() {
  const awards = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));

  let targets = awards.filter(r =>
    r.source === 'michelin' &&
    (r.michelinAward === '3 Stars' || r.michelinAward === '2 Stars' || r.michelinAward === '1 Star')
  );

  if (TEST_MODE) {
    targets = targets.slice(0, 1);
    console.log(`TEST MODE: processing 1 restaurant: ${targets[0].restaurant} (${targets[0].city})`);
  } else {
    console.log(`Processing ${targets.length} restaurants...`);
  }

  let enriched = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of targets) {
    const cacheKey = `${record.restaurant}|${record.city}|${record.country}`;

    if (cache[cacheKey]) {
      skipped++;
      continue;
    }

    try {
      const result = await searchPlace(record.restaurant, record.city, record.country);

      if (!result.places || result.places.length === 0) {
        console.log(`  NOT FOUND: ${record.restaurant} (${record.city})`);
        cache[cacheKey] = { found: false };
        saveCache();
        await sleep(200);
        continue;
      }

      const place = result.places[0];
      const entry = {
        found: true,
        placeId: place.id,
        businessStatus: place.businessStatus || null,
        website: place.websiteUri || null,
        formattedAddress: place.formattedAddress || null,
        photoUrl: null,
      };

      // Fetch one photo
      if (place.photos && place.photos.length > 0) {
        try {
          entry.photoUrl = await getPhotoUrl(place.photos[0].name);
          await sleep(100);
        } catch (photoErr) {
          console.warn(`  Photo error for ${record.restaurant}: ${photoErr.message}`);
        }
      }

      cache[cacheKey] = entry;
      saveCache();
      enriched++;

      const status = entry.businessStatus || 'unknown';
      const hasPhoto = entry.photoUrl ? 'photo' : 'no photo';
      console.log(`  [${enriched}] ${record.restaurant} (${record.city}) → ${status}, ${hasPhoto}`);

      await sleep(200); // ~5 req/sec, well within quota

    } catch (err) {
      console.error(`  ERROR: ${record.restaurant}: ${err.message}`);
      errors++;
      await sleep(500);
    }
  }

  console.log(`\nDone. enriched=${enriched}, skipped=${skipped}, errors=${errors}`);
  console.log(`Cache saved to ${CACHE_PATH}`);

  if (TEST_MODE) {
    const cacheKey = `${targets[0].restaurant}|${targets[0].city}|${targets[0].country}`;
    console.log('\nTest result:');
    console.log(JSON.stringify(cache[cacheKey], null, 2));
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
