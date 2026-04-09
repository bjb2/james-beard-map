// enrich-google-jbf.js
// Enriches precise JBF restaurant locations with Google Places data:
//   - business_status (OPERATIONAL / CLOSED_PERMANENTLY / CLOSED_TEMPORARILY)
//   - photo (for restaurants without a Yelp image)
//   - website (where missing)
//
// Usage:
//   node enrich-google-jbf.js --test     # run 1 restaurant only
//   node enrich-google-jbf.js            # run all precise JBF restaurants

const fs = require('fs');
const https = require('https');

const TEST_MODE = process.argv.includes('--test');
const AWARDS_PATH = './data/awards.json';
const CACHE_PATH = './data/google-jbf-cache.json';
const KEY_PATH = './.key.txt';

const keyData = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const API_KEY = keyData['google-key'];
if (!API_KEY) { console.error('No google-key in .key.txt'); process.exit(1); }

let cache = {};
if (fs.existsSync(CACHE_PATH)) {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  console.log(`Loaded cache: ${Object.keys(cache).length} entries`);
}

function saveCache() {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function searchPlace(name, city, state) {
  const query = [name, city, state].filter(Boolean).join(', ');
  const body = JSON.stringify({ textQuery: query });
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
    req.write(body);
    req.end();
  });
}

async function getPhotoUrl(photoName) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&key=${API_KEY}&skipHttpRedirect=true`;
  const result = await get(url);
  return result.photoUri || null;
}

async function run() {
  const awards = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));

  // Deduplicate by restaurant+city — one lookup per unique location
  const seen = new Map();
  for (const r of awards) {
    if (r.source === 'michelin' || !r.precise || !r.lat || !r.lng) continue;
    const key = (r.restaurant || r.name || '') + '|' + (r.city || '');
    if (!seen.has(key)) seen.set(key, r);
  }

  let targets = [...seen.values()];

  if (TEST_MODE) {
    targets = targets.slice(0, 1);
    console.log(`TEST MODE: ${targets[0].restaurant} (${targets[0].city})`);
  } else {
    console.log(`Processing ${targets.length} unique JBF restaurants...`);
  }

  let enriched = 0, skipped = 0, notFound = 0, errors = 0;

  for (const record of targets) {
    const cacheKey = `${record.restaurant || record.name}|${record.city}|${record.state}`;

    if (cache[cacheKey]) {
      skipped++;
      continue;
    }

    try {
      const result = await searchPlace(record.restaurant || record.name, record.city, record.state);

      if (!result.places || result.places.length === 0) {
        cache[cacheKey] = { found: false };
        saveCache();
        notFound++;
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

      // Only fetch photo if no Yelp image exists
      const hasYelpImage = !!(record.yelpDetail?.image || record.image);
      if (!hasYelpImage && place.photos && place.photos.length > 0) {
        try {
          entry.photoUrl = await getPhotoUrl(place.photos[0].name);
          await sleep(100);
        } catch (e) {
          console.warn(`  Photo error for ${record.restaurant}: ${e.message}`);
        }
      }

      cache[cacheKey] = entry;
      saveCache();
      enriched++;

      const status = entry.businessStatus || 'unknown';
      const photo = entry.photoUrl ? ' +photo' : '';
      const web = entry.website ? ' +web' : '';
      if (enriched % 100 === 0 || status !== 'OPERATIONAL') {
        console.log(`  [${enriched}] ${record.restaurant} (${record.city}) → ${status}${photo}${web}`);
      }

      await sleep(200);

    } catch (err) {
      console.error(`  ERROR ${record.restaurant}: ${err.message}`);
      errors++;
      await sleep(500);
    }
  }

  console.log(`\nDone. enriched=${enriched}, skipped=${skipped}, notFound=${notFound}, errors=${errors}`);

  if (TEST_MODE) {
    const key = `${targets[0].restaurant || targets[0].name}|${targets[0].city}|${targets[0].state}`;
    console.log('\nTest result:', JSON.stringify(cache[key], null, 2));
  }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
