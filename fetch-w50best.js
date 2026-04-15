/**
 * fetch-w50best.js
 *
 * Scrapes North America's 50 Best Bars (top 100) from theworlds50best.com
 *
 * Phase 1 — Playwright (listing pages, JS-rendered)
 *   Scrapes /lists/1-50 and /lists/51-100 for rank, name, city, detail URL,
 *   and listing thumbnail image.
 *   Output: data/w50best-raw.json
 *
 * Phase 2 — Axios (detail pages, static HTML, 1–50 only)
 *   Parses JSON-LD BarOrPub schema: address, phone, website, hero image, awards.
 *   Cache: data/w50best-cache.json
 *
 * Phase 3 — Google Places API (all 100 bars)
 *   1–50:  geocode using detail-page address (precise)
 *   51–100: text search by name + city → coords + address + phone + website
 *   Cache: data/w50best-geo-cache.json
 *
 * Output: data/w50best.json
 *
 * Usage:
 *   GOOGLE_KEY=<key> node fetch-w50best.js
 *   GOOGLE_KEY=<key> node fetch-w50best.js --listing-only   (phase 1 only)
 *   GOOGLE_KEY=<key> node fetch-w50best.js --skip-geocode   (phases 1+2 only)
 *   GOOGLE_KEY=<key> node fetch-w50best.js --skip-cache     (ignore caches)
 */

'use strict';

const { chromium } = require('playwright-chromium');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const GOOGLE_KEY  = process.env.GOOGLE_KEY || process.argv.find(a => a.startsWith('AIza'));
const BASE_URL    = 'https://www.theworlds50best.com/bars/northamerica';
const LIST_PAGES  = [
  { url: `${BASE_URL}/lists/1-50`,   range: [1,  50]  },
  { url: `${BASE_URL}/lists/51-100`, range: [51, 100] },
];

const RAW_FILE    = path.join(__dirname, 'data', 'w50best-raw.json');
const CACHE_FILE  = path.join(__dirname, 'data', 'w50best-cache.json');
const GEO_CACHE   = path.join(__dirname, 'data', 'w50best-geo-cache.json');
const OUT_FILE    = path.join(__dirname, 'data', 'w50best.json');

const LISTING_ONLY  = process.argv.includes('--listing-only');
const SKIP_GEOCODE  = process.argv.includes('--skip-geocode');
const SKIP_CACHE    = process.argv.includes('--skip-cache');
const RATE_MS       = 350;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache(file) {
  if (!SKIP_CACHE && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  return {};
}

function saveCache(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Tier helper ───────────────────────────────────────────────────────────────

function tier(rank) {
  if (rank <= 10)  return 'Top 10';
  if (rank <= 50)  return 'Top 50';
  return '51-100';
}

// ── Phase 1: Playwright listing scrape ───────────────────────────────────────
// Confirmed DOM structure (from debug-w50best.js inspection):
//
// <div class="list-item">
//   <a class="item-img-container" href="/bars/northamerica/the-list/[slug].html">  ← 1-50 only; div for 51-100
//     <img src="//...filestore/jpg/[Name]-hero_NA50BB25-website.jpg" />
//   </a>
//   <div class="list-item-contents">
//     <div class="item-top">
//       <p class="rank ">1</p>
//     </div>
//     <div class="item-bottom">
//       <a href="/bars/northamerica/the-list/[slug].html"><h2>Name</h2></a>  ← 1-50 only; plain h2 for 51-100
//       <p>City</p>
//     </div>
//   </div>
// </div>

async function scrapeListingPage(page, url, rankRange) {
  console.log(`  → ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(3000);

  const [minRank, maxRank] = rankRange;

  const entries = await page.evaluate(({ minRank, maxRank }) => {
    const results = [];

    document.querySelectorAll('div.list-item').forEach(item => {
      // Rank
      const rankEl = item.querySelector('p.rank');
      if (!rankEl) return;
      const rank = parseInt(rankEl.textContent.trim());
      if (!rank || rank < minRank || rank > maxRank) return;

      // Name — inside h2 (wrapped in <a> for 1-50, bare for 51-100)
      const name = item.querySelector('div.item-bottom h2')?.textContent?.trim();
      if (!name) return;

      // City — <p> immediately after h2 in item-bottom
      const city = item.querySelector('div.item-bottom p')?.textContent?.trim() || null;

      // Detail page href — <a class="item-img-container"> for 1-50, absent for 51-100
      const imgContainerLink = item.querySelector('a.item-img-container');
      const nameLinkHref     = item.querySelector('div.item-bottom a')?.getAttribute('href');
      const rawHref          = imgContainerLink?.getAttribute('href') || nameLinkHref || null;
      const href    = rawHref ? `https://www.theworlds50best.com${rawHref}` : null;
      const slug    = rawHref ? rawHref.replace(/.*\/the-list\//, '').replace(/\.html$/i, '') : null;

      // Image — src is set by Playwright after lazy-load
      const img    = item.querySelector('.item-img-container img');
      const rawSrc = img?.getAttribute('src') || img?.getAttribute('data-src') || null;
      const imgSrc = rawSrc ? (rawSrc.startsWith('//') ? 'https:' + rawSrc : rawSrc) : null;

      results.push({ rank, name, city, href, slug, imgSrc });
    });

    return results;
  }, { minRank, maxRank });

  return entries;
}

// ── Phase 2: Axios detail page scrape ────────────────────────────────────────

function parseJsonLd(html) {
  const results = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch {}
  }
  return results;
}

async function scrapeDetailPage(bar, cache) {
  if (!bar.href) return null;

  const cacheKey = bar.slug;
  if (!SKIP_CACHE && cache[cacheKey]) {
    process.stdout.write('(cached) ');
    return cache[cacheKey];
  }

  try {
    await sleep(RATE_MS);
    const res = await axios.get(bar.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DelectableMap/1.0)' },
      timeout: 15000,
    });

    const schemas = parseJsonLd(res.data);
    const barSchema = schemas.find(s => s['@type'] === 'BarOrPub' || s['@type'] === 'FoodEstablishment');
    if (!barSchema) return null;

    // Extract image: JSON-LD image field is most reliable
    let image = null;
    if (barSchema.image) {
      image = Array.isArray(barSchema.image) ? barSchema.image[0] : barSchema.image;
    }
    // Also search for filestore JPG in raw HTML as fallback
    if (!image) {
      const imgMatch = res.data.match(/https?:[^"']*filestore\/jpg\/[^"']+\.jpg/);
      if (imgMatch) image = imgMatch[0];
    }

    const addr = barSchema.address || {};
    const street = addr.streetAddress || null;
    const locality = addr.addressLocality || null;

    // Social media: scan for instagram/facebook hrefs
    const instaMatch = res.data.match(/https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.]+\/?/);
    const fbMatch    = res.data.match(/https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9_.]+\/?/);

    const result = {
      name:        barSchema.name || bar.name,
      address:     street || null,
      city:        locality || bar.city,
      phone:       barSchema.telephone || null,
      website:     barSchema.url || null,
      image:       image || bar.imgSrc || null,
      awards:      Array.isArray(barSchema.award) ? barSchema.award : (barSchema.award ? [barSchema.award] : []),
      description: barSchema.description || null,
      instagram:   instaMatch?.[0] || null,
      facebook:    fbMatch?.[0] || null,
    };

    cache[cacheKey] = result;
    return result;
  } catch (e) {
    console.warn(`\n  ! Detail fetch failed for ${bar.name}: ${e.message}`);
    return null;
  }
}

// ── Phase 3: Google Places geocoding ─────────────────────────────────────────

async function googlePlaces(query, geoCache, wantEnrich) {
  if (geoCache[query] !== undefined) return geoCache[query];

  const fieldMask = wantEnrich
    ? 'places.location,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri'
    : 'places.location,places.formattedAddress';

  try {
    await sleep(RATE_MS);
    const res = await axios.post('https://places.googleapis.com/v1/places:searchText',
      { textQuery: query, languageCode: 'en' },
      { headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': fieldMask,
        },
        timeout: 10000,
      }
    );

    const place = res.data?.places?.[0];
    if (!place?.location) { geoCache[query] = null; return null; }

    const result = {
      lat:     place.location.latitude,
      lng:     place.location.longitude,
      address: place.formattedAddress || null,
      phone:   wantEnrich ? (place.internationalPhoneNumber || null) : null,
      website: wantEnrich ? (place.websiteUri || null) : null,
    };

    geoCache[query] = result;
    return result;
  } catch (e) {
    console.warn(`\n  ! Google Places failed for "${query}": ${e.response?.data?.error?.message || e.message}`);
    geoCache[query] = null;
    return null;
  }
}

// ── Build final record ────────────────────────────────────────────────────────

function buildRecord(raw, detail, geo) {
  const name    = detail?.name    || raw.name;
  const city    = detail?.city    || raw.city    || null;
  const address = detail?.address || geo?.address || null;
  const phone   = detail?.phone   || geo?.phone   || null;
  const website = detail?.website || geo?.website || null;
  const image   = detail?.image   || raw.imgSrc   || null;

  // Country: derive from city/address heuristic for common locations
  const country = deriveCountry(city, address);

  return {
    source:          'w50best',
    restaurant:      name,
    city,
    country,
    address,
    lat:             geo?.lat  ?? null,
    lng:             geo?.lng  ?? null,
    precise:         !!(geo?.lat),
    w50bestRank:     raw.rank,
    w50bestAward:    tier(raw.rank),
    w50bestUrl:      raw.href || `${BASE_URL}/lists/${raw.rank <= 50 ? '1-50' : '51-100'}`,
    website,
    phone,
    googlePhoto:     image,
    instagram:       detail?.instagram || null,
    facebook:        detail?.facebook  || null,
    description:     detail?.description || null,
    cuisineCategory: 'Bars & Cocktails',
    cuisineTags:     ['Bar', 'Cocktails'],
    price:           null,
  };
}

// Simple country derivation from common World's 50 Best Bars cities
const CITY_COUNTRY = {
  'Mexico City': 'Mexico', 'Guadalajara': 'Mexico', 'Tijuana': 'Mexico',
  'Oaxaca': 'Mexico', 'Tulum': 'Mexico', 'San Miguel de Allende': 'Mexico',
  'Toronto': 'Canada', 'Vancouver': 'Canada', 'Montreal': 'Canada',
  'New York': 'US', 'Chicago': 'US', 'Los Angeles': 'US',
  'San Francisco': 'US', 'Washington DC': 'US', 'Miami': 'US',
  'New Orleans': 'US', 'Denver': 'US',
  'Grand Cayman': 'Cayman Islands',
  'San Juan': 'Puerto Rico',
};

function deriveCountry(city, address) {
  if (!city) return null;
  if (CITY_COUNTRY[city]) return CITY_COUNTRY[city];
  // Address-based: US states
  if (address && /, [A-Z]{2} \d{5}/.test(address)) return 'US';
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Phase 1: Listing pages ──
  console.log('\n── Phase 1: Playwright listing scrape ──');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  let allRaw = [];
  try {
    for (const { url, range } of LIST_PAGES) {
      const entries = await scrapeListingPage(page, url, range);
      console.log(`  ${url}: ${entries.length} entries`);
      allRaw.push(...entries);
    }
  } finally {
    await browser.close();
  }

  // Deduplicate by rank (1-50 may appear on both listing pages)
  const byRank = new Map();
  for (const e of allRaw) byRank.set(e.rank, e);
  allRaw = [...byRank.values()].sort((a, b) => a.rank - b.rank);

  if (allRaw.length === 0) {
    console.error('\nNo entries found. The page structure may have changed — inspect manually.');
    process.exit(1);
  }

  console.log(`\n  Total: ${allRaw.length} bars (${allRaw.filter(e => e.href).length} with detail pages)`);
  saveCache(RAW_FILE, allRaw);
  console.log(`  Saved → ${RAW_FILE}`);

  if (LISTING_ONLY) {
    console.log('\n--listing-only: done after phase 1.');
    return;
  }

  // ── Phase 2: Detail pages (1–50 only) ──
  console.log('\n── Phase 2: Detail page scrape (1–50) ──');
  const detailCache = loadCache(CACHE_FILE);
  const detailMap   = new Map(); // rank → detail data

  const withDetail = allRaw.filter(e => e.href);
  for (let i = 0; i < withDetail.length; i++) {
    const bar = withDetail[i];
    process.stdout.write(`  [${(i+1).toString().padStart(2)}/${withDetail.length}] ${bar.name.slice(0, 40).padEnd(40)} `);
    const detail = await scrapeDetailPage(bar, detailCache);
    if (detail) {
      detailMap.set(bar.rank, detail);
      process.stdout.write('ok\n');
    } else {
      process.stdout.write('no detail\n');
    }
    if ((i + 1) % 10 === 0) saveCache(CACHE_FILE, detailCache);
  }
  saveCache(CACHE_FILE, detailCache);
  console.log(`  Detail data: ${detailMap.size} / ${withDetail.length}`);

  if (SKIP_GEOCODE) {
    console.log('\n--skip-geocode: building output without coordinates.');
    const records = allRaw.map(raw => buildRecord(raw, detailMap.get(raw.rank) || null, null));
    fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
    console.log(`Saved → ${OUT_FILE}`);
    return;
  }

  // ── Phase 3: Google Places geocoding ──
  if (!GOOGLE_KEY) {
    console.error('\nERROR: Google API key required for geocoding.');
    console.error('  GOOGLE_KEY=<key> node fetch-w50best.js');
    console.error('  Or use --skip-geocode to build output without coords.');
    process.exit(1);
  }

  console.log('\n── Phase 3: Google Places geocoding ──');
  const geoCache = loadCache(GEO_CACHE);
  const records  = [];
  let geocoded = 0, failed = 0;

  for (let i = 0; i < allRaw.length; i++) {
    const raw    = allRaw[i];
    const detail = detailMap.get(raw.rank) || null;

    process.stdout.write(`  [${(i+1).toString().padStart(3)}/100] #${String(raw.rank).padEnd(3)} ${raw.name.slice(0, 38).padEnd(38)} `);

    let geo = null;

    if (detail?.address) {
      // 1–50: geocode from precise address
      const query = `${detail.address}, ${detail.city || raw.city}`;
      geo = await googlePlaces(query, geoCache, false);
    } else {
      // 51–100 (or 1–50 missing address): enrich from Google Places by name + city
      const query = `${raw.name} bar, ${raw.city}`;
      geo = await googlePlaces(query, geoCache, true);
    }

    if (geo?.lat) { geocoded++; process.stdout.write('ok\n'); }
    else          { failed++;   process.stdout.write('no coords\n'); }

    records.push(buildRecord(raw, detail, geo));

    if ((i + 1) % 20 === 0) saveCache(GEO_CACHE, geoCache);
  }

  saveCache(GEO_CACHE, geoCache);
  fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));

  console.log(`\n  Geocoded: ${geocoded} / ${allRaw.length} (${failed} failed)`);
  console.log(`\nSaved → ${OUT_FILE}`);
  console.log('\nNext step:');
  console.log('  node merge-w50best.js && node normalize-cuisine.js && node split-data.js');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
