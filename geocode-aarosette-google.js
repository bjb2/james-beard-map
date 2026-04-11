'use strict';
/**
 * geocode-aarosette-google.js
 *
 * 1. Cleans AA Rosette restaurant names (strips " – City" / " - City" suffixes)
 * 2. Geocodes records missing lat/lng via Google Places Text Search API
 *
 * Usage:
 *   GOOGLE_KEY=<key> node geocode-aarosette-google.js
 *   node geocode-aarosette-google.js <key>
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const GOOGLE_KEY = process.env.GOOGLE_KEY || process.argv[2];
if (!GOOGLE_KEY) {
  console.error('ERROR: Google API key required.\n  node geocode-aarosette-google.js <key>');
  process.exit(1);
}

const RAW_FILE   = path.join(__dirname, 'data', 'aarosette-raw.json');
const OUT_FILE   = path.join(__dirname, 'data', 'aarosette.json');
const CACHE_FILE = path.join(__dirname, 'data', 'aarosette-google-cache.json');
const RATE_MS    = 300;

// UK county/region/city names that should never be restaurant names
const UK_REGIONS = new Set([
  // Countries / macro regions
  'england','scotland','wales','northern ireland','ireland','channel islands',
  'greater london','greater manchester',
  // English counties
  'bedfordshire','berkshire','buckinghamshire','cambridgeshire','cheshire',
  'cornwall','county durham','cumbria','derbyshire','devon','dorset',
  'east sussex','essex','gloucestershire','hampshire','herefordshire',
  'hertfordshire','kent','lancashire','leicestershire','lincolnshire',
  'manchester','merseyside','norfolk','northampton','northamptonshire',
  'northumberland','nottinghamshire','oxfordshire','rutland','shropshire',
  'somerset','staffordshire','suffolk','surrey','tyne & wear','tyne and wear',
  'warwickshire','west midlands','west sussex','wiltshire','worcestershire',
  'yorkshire','isles of scilly',
  // English cities used as section headers
  'london','birmingham',
  // Scottish councils / cities
  'aberdeen','angus','argyll & bute','argyll and bute','dumfries & galloway',
  'dumfries and galloway','edinburgh','fife','glasgow','highland','inverclyde',
  'midlothian','moray','perth & kinross','perth and kinross','perthshire',
  'south ayrshire','south lanarkshire','stirling','east lothian','west lothian',
  'east ayrshire','north ayrshire','east dunbartonshire','west dunbartonshire',
  'east renfrewshire','renfrewshire','falkirk','clackmannanshire','dundee',
  // Welsh counties / cities
  'cardiff','ceredigion','conwy','gwynedd','isle of anglesey','monmouthshire',
  'newport','pembrokeshire','powys','swansea','vale of glamorgan','wrexham',
  'bridgend','caerphilly','carmarthenshire','denbighshire','flintshire',
  'merthyr tydfil','neath port talbot','rhondda cynon taf','torfaen',
  // Northern Ireland
  'belfast','county fermanagh','county antrim','county down','county armagh',
  'county londonderry','county tyrone',
  // Channel Islands / Crown Dependencies
  'jersey','guernsey',
]);

// London postcode prefixes
const LONDON_POSTCODE = /^(E|EC|N|NW|SE|SW|W|WC)\d/i;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  }
  return {};
}

/**
 * Clean a raw name from the blog post:
 * "Helene Darroze at The Connaught – W1"  → { name: "Helene Darroze at The Connaught", cityHint: "London" }
 * "The Fat Duck – Bray"                    → { name: "The Fat Duck", cityHint: "Bray" }
 * "Lympstone Manor Hotel, Exmouth"         → { name: "Lympstone Manor Hotel", cityHint: "Exmouth" }
 */
function cleanName(raw, county) {
  // Normalise em-dash and en-dash to " - "
  let s = raw.replace(/\s*[–—]\s*/g, ' - ').trim();

  let cityHint = null;

  // Split on " - " — last segment is often a city/area
  const dashIdx = s.lastIndexOf(' - ');
  if (dashIdx > 0) {
    const suffix = s.slice(dashIdx + 3).trim();
    s = s.slice(0, dashIdx).trim();
    // London postcode area → city = London
    if (LONDON_POSTCODE.test(suffix)) {
      cityHint = 'London';
    } else if (suffix.length <= 30 && !/\s{2,}/.test(suffix)) {
      cityHint = suffix;
    }
  }

  // Also handle "Name, City" comma pattern (only if city part is short and looks like a place)
  const commaIdx = s.lastIndexOf(', ');
  if (commaIdx > 0 && !cityHint) {
    const suffix = s.slice(commaIdx + 2).trim();
    if (suffix.length <= 25 && /^[A-Z]/.test(suffix) && !suffix.includes(' at ')) {
      cityHint = suffix;
      s = s.slice(0, commaIdx).trim();
    }
  }

  return { name: s, cityHint: cityHint || county || null };
}

async function googleGeocode(name, postcode, cityHint, county, cache) {
  const query = [name, postcode || cityHint || county, 'United Kingdom'].filter(Boolean).join(', ');
  if (cache[query] !== undefined) return cache[query];

  try {
    await sleep(RATE_MS);
    const res = await axios.get('https://places.googleapis.com/v1/places:searchText', {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        'X-Goog-FieldMask': 'places.location,places.displayName,places.formattedAddress',
      },
      method: 'POST',
      data: { textQuery: query, languageCode: 'en', regionCode: 'GB' },
    });
    // axios GET doesn't work for POST — use post:
    throw new Error('use post');
  } catch {}

  // Use POST correctly
  try {
    await sleep(RATE_MS);
    const res = await axios.post('https://places.googleapis.com/v1/places:searchText', {
      textQuery: query,
      languageCode: 'en',
      regionCode: 'GB',
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        'X-Goog-FieldMask': 'places.location,places.displayName,places.formattedAddress',
      },
    });
    const place = res.data?.places?.[0];
    if (place?.location) {
      const result = {
        lat:     place.location.latitude,
        lng:     place.location.longitude,
        address: place.formattedAddress || null,
      };
      cache[query] = result;
      return result;
    }
  } catch (e) {
    console.warn(`\n  ! Google geocode failed for "${query}": ${e.response?.data?.error?.message || e.message}`);
  }

  cache[query] = null;
  return null;
}

async function main() {
  const raw    = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const cache  = loadCache();
  const records = [];

  console.log(`Processing ${raw.length} AA Rosette entries…\n`);

  let cleaned = 0, geocoded = 0, skipped = 0;

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    process.stdout.write(`  [${(i+1).toString().padStart(3)}/${raw.length}] `);

    // Skip entries that are clearly county/region names
    if (UK_REGIONS.has(r.name.toLowerCase())) {
      process.stdout.write(`SKIP (region: ${r.name})\n`);
      skipped++;
      continue;
    }

    // Skip website navigation / footer text that the parser picked up
    if (/^(signup|download|menu|restaurateur|meet the|hotel partner|faq|newsletter|michelin awards|aa awards|contact|trending|stay connected|facebook|twitter|instagram|pinterest|proudly|mobile app|already a member|club login|membership|why join|join club|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i.test(r.name)) {
      process.stdout.write(`SKIP (nav text: ${r.name})\n`);
      skipped++;
      continue;
    }

    const { name, cityHint } = cleanName(r.name, r.county);
    if (name !== r.name) cleaned++;

    const city = cityHint || r.county || r.region || 'United Kingdom';

    // Try to geocode
    const geo = await googleGeocode(name, r.postcode, cityHint, r.county, cache);
    if (geo) geocoded++;

    process.stdout.write(`${name.slice(0,45).padEnd(45)} ${geo ? 'ok' : 'no coords'}\n`);

    records.push({
      source:       'aarosette',
      restaurant:   name,
      city,
      country:      'United Kingdom',
      address:      geo?.address || (r.postcode ? `${r.county || ''} ${r.postcode}`.trim() : null),
      lat:          geo?.lat ?? null,
      lng:          geo?.lng ?? null,
      precise:      !!geo,
      aaRosettes:   r.rosettes,
      aaRosetteUrl: 'https://www.luxuryrestaurantguide.com/blog/complete-list-of-2025-aa-rosette-awarded-restaurants-three-four-and-five-rosettes/',
      cuisine:      null,
      cuisineTags:  [],
      price:        null,
      website:      null,
      phone:        null,
      photo_url:    null,
    });

    if ((i + 1) % 20 === 0) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));

  console.log(`\nDone.`);
  console.log(`  Skipped (region names): ${skipped}`);
  console.log(`  Names cleaned:          ${cleaned}`);
  console.log(`  Geocoded:               ${geocoded} / ${records.length}`);
  console.log(`\nSaved → ${OUT_FILE}`);
  console.log('Next: node merge-aarosette.js && node split-data.js');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
