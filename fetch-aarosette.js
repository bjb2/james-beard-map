/**
 * fetch-aarosette.js
 *
 * Scrapes the 2025 AA Rosette list from the Luxury Restaurant Guide blog post
 * and geocodes each entry via Nominatim (free, no API key).
 *
 * Source: https://www.luxuryrestaurantguide.com/blog/complete-list-of-2025-aa-rosette-awarded-restaurants-three-four-and-five-rosettes/
 *
 * The page is a hierarchical blog post:
 *   Rosette count (5/4/3) → UK region → County → Restaurant name + postcode
 *
 * Phase 1: Parse DOM → extract (name, rosettes, region, county, postcode)
 * Phase 2: Nominatim geocode each entry (1 req/sec, cached)
 *
 * Outputs:
 *   data/aarosette-raw.json      parsed listing before geocoding
 *   data/aarosette-geo-cache.json geocoding cache
 *   data/aarosette.json          final enriched records
 *
 * Usage:
 *   node fetch-aarosette.js
 *   node fetch-aarosette.js --listing-only   skip geocoding
 *   node fetch-aarosette.js --skip-cache     re-geocode all
 */

'use strict';

const { chromium } = require('playwright-chromium');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const SOURCE_URL   = 'https://www.luxuryrestaurantguide.com/blog/complete-list-of-2025-aa-rosette-awarded-restaurants-three-four-and-five-rosettes/';
const RAW_FILE     = path.join(__dirname, 'data', 'aarosette-raw.json');
const GEO_CACHE    = path.join(__dirname, 'data', 'aarosette-geo-cache.json');
const OUT_FILE     = path.join(__dirname, 'data', 'aarosette.json');

const LISTING_ONLY = process.argv.includes('--listing-only');
const SKIP_CACHE   = process.argv.includes('--skip-cache');
const NOMINATIM    = 'https://nominatim.openstreetmap.org/search';
const HEADERS      = { 'User-Agent': 'DelectableMap/1.0 (educational/non-commercial)' };
const RATE_MS      = 1100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache(file) {
  if (!SKIP_CACHE && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  return {};
}

// ── Phase 1: Parse the blog post DOM ─────────────────────────────────────────

async function parseListing(page) {
  console.log(`Navigating to source page…`);
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(500);

  const raw = await page.evaluate(() => {
    const results = [];

    // Walk all heading + content elements inside the article body
    // Looking for pattern: h2 = rosette tier, h3 = region, h4 = county, then text items
    const body = document.querySelector('article, .entry-content, .post-content, main, body');
    if (!body) return results;

    const nodes = [...body.querySelectorAll('h2, h3, h4, h5, p, li, ul, ol')];

    let rosettes = null;
    let region   = null;
    let county   = null;

    // Rosette count patterns in headings
    const roseRe  = /(\d)\s*(aa\s*)?rosette/i;
    // County/location separator — "Restaurant Name, W1" or "Restaurant Name (NEW), SW3"
    const entryRe = /^(.+?),\s*([A-Z]{1,2}\d[\d\w]?\s*\d?[A-Z]{0,2}|[A-Z]{2,3}\d{0,2})$/;

    for (const el of nodes) {
      const tag  = el.tagName.toLowerCase();
      const text = el.textContent.replace(/\u00a0/g, ' ').trim();
      if (!text) continue;

      // Detect rosette tier from h2/h3
      if (tag === 'h2' || tag === 'h3') {
        const m = text.match(roseRe);
        if (m) {
          rosettes = parseInt(m[1]);
          region   = null;
          county   = null;
          continue;
        }
      }

      // Detect geographic region (England, Scotland, Wales, etc.)
      if ((tag === 'h2' || tag === 'h3') && rosettes) {
        if (/england|scotland|wales|northern ireland|ireland|channel islands/i.test(text)) {
          region = text.replace(/\(.*?\)/g, '').trim();
          county = null;
          continue;
        }
      }

      // Detect county from h4/h5
      if ((tag === 'h4' || tag === 'h5') && rosettes) {
        county = text.replace(/\(.*?\)/g, '').trim();
        continue;
      }

      // Restaurant entry — appears in <p> or <li> when rosettes is set
      if (rosettes && (tag === 'p' || tag === 'li')) {
        // Skip headings-in-p, navigation text, obvious non-restaurant lines
        if (text.length > 120 || text.split(' ').length > 12) continue;
        if (/^(the complete|all rights|©|updated|published|share|tweet|follow)/i.test(text)) continue;

        // Clean up the entry: strip "(NEW)", "(PROMOTED)", etc.
        const clean = text.replace(/\(new\)/i, '').replace(/\([^)]*\)/g, '').trim();
        if (!clean) continue;

        // Split on last comma to separate name from postcode/location
        const lastComma = clean.lastIndexOf(',');
        let name     = lastComma > 0 ? clean.slice(0, lastComma).trim() : clean;
        let postcode = lastComma > 0 ? clean.slice(lastComma + 1).trim() : '';

        // Postcode must look like a real UK postcode fragment (letters+digits)
        if (!/^[A-Z]{1,2}\d/.test(postcode.toUpperCase())) {
          // No clean postcode — treat whole text as name
          name     = clean;
          postcode = '';
        }

        if (name.length < 2) continue;

        results.push({
          name,
          postcode:  postcode.toUpperCase() || null,
          county:    county || null,
          region:    region || 'England',
          rosettes,
          isNew:     /\(new\)/i.test(text),
        });
      }
    }

    return results;
  });

  return raw;
}

// ── Phase 2: Nominatim geocoding ──────────────────────────────────────────────

async function geocode(name, postcode, county, country) {
  // Try most specific query first, fall back to broader
  const queries = [
    postcode ? `${name}, ${postcode}, ${country}` : null,
    county   ? `${name}, ${county}, ${country}`  : null,
    `${name}, ${country}`,
  ].filter(Boolean);

  for (const q of queries) {
    try {
      await sleep(RATE_MS);
      const res = await axios.get(NOMINATIM, {
        params: { q, format: 'json', limit: 1, addressdetails: 1 },
        headers: HEADERS,
        timeout: 10000,
      });
      if (res.data?.length > 0) {
        const r = res.data[0];
        return {
          lat:     parseFloat(r.lat),
          lng:     parseFloat(r.lon),
          address: r.display_name,
          precise: true,
        };
      }
    } catch {}
  }
  return null;
}

// ── Build final record ────────────────────────────────────────────────────────

function buildRecord(raw, geo) {
  // City: prefer county, fall back to region
  const city = raw.county || raw.region || 'United Kingdom';

  return {
    source:          'aarosette',
    restaurant:      raw.name,
    city,
    country:         'United Kingdom',
    address:         geo?.address || (raw.postcode ? `${raw.county || ''} ${raw.postcode}`.trim() : null),
    lat:             geo?.lat ?? null,
    lng:             geo?.lng ?? null,
    precise:         geo?.precise || false,
    aaRosettes:      raw.rosettes,           // 3, 4, or 5
    aaRosetteUrl:    SOURCE_URL,
    cuisine:         null,
    cuisineTags:     [],
    price:           null,
    website:         null,
    phone:           null,
    photo_url:       null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-GB',
  });
  const page = await context.newPage();

  try {
    // Phase 1
    console.log('\n── Phase 1: Parsing AA Rosette listing ──');
    const raw = await parseListing(page);
    fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));

    const byRosette = {};
    raw.forEach(r => { byRosette[r.rosettes] = (byRosette[r.rosettes] || 0) + 1; });
    console.log(`Parsed ${raw.length} entries:`);
    Object.entries(byRosette).sort((a,b)=>b[0]-a[0]).forEach(([k,v]) =>
      console.log(`  ${v.toString().padStart(4)}  ${k}-rosette`)
    );

    if (raw.length === 0) {
      console.error('\nNo entries found — the page structure may have changed.');
      console.error('Check data/aarosette-raw.json and inspect the page manually.');
      await browser.close();
      return;
    }

    if (LISTING_ONLY) {
      console.log('\n--listing-only: stopping after phase 1.');
      await browser.close();
      return;
    }

    // Phase 2: Geocoding
    console.log('\n── Phase 2: Nominatim geocoding ──');
    const geoCache = loadCache(GEO_CACHE);
    const records  = [];
    let hits = 0, misses = 0;

    for (let i = 0; i < raw.length; i++) {
      const r   = raw[i];
      const key = `${r.name}|${r.postcode || r.county}`;
      process.stdout.write(`  [${(i+1).toString().padStart(3)}/${raw.length}] ${r.name.slice(0,45).padEnd(45)} `);

      let geo = geoCache[key];
      if (geo === undefined) {
        geo = await geocode(r.name, r.postcode, r.county, 'United Kingdom');
        geoCache[key] = geo;
        if (i % 30 === 0) fs.writeFileSync(GEO_CACHE, JSON.stringify(geoCache, null, 2));
      }

      if (geo) { hits++; process.stdout.write('ok\n'); }
      else      { misses++; process.stdout.write('no coords\n'); }

      records.push(buildRecord(r, geo));
    }

    fs.writeFileSync(GEO_CACHE, JSON.stringify(geoCache, null, 2));

    console.log(`\nGeocoded: ${hits} / ${raw.length} (${misses} no coords)`);
    fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
    console.log(`Saved → ${OUT_FILE}`);
    console.log('\nNext step: node merge-aarosette.js');

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
