/**
 * yelp-details.js
 *
 * Targeted Yelp enrichment for Winners + 2023-present awards.
 * Stores rating, price, image, menu URL, phone, closed status, and Yelp URL
 * in data/yelp-details.json (keyed by restaurant|city|state).
 *
 * Usage:
 *   node yelp-details.js          — process next 100 un-enriched targets
 *   node yelp-details.js --limit 250  — process up to 250
 *
 * Safe to re-run — already-cached keys are skipped.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const KEYS        = JSON.parse(fs.readFileSync(path.join(__dirname, '.key.txt'), 'utf8'));
const YELP_KEY    = KEYS['yelp-key'];
const AWARDS_FILE = path.join(__dirname, 'data', 'awards.json');
const DETAILS_FILE = path.join(__dirname, 'data', 'yelp-details.json');

const YELP_SEARCH = 'https://api.yelp.com/v3/businesses/search';

const limit = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? parseInt(process.argv[i + 1]) : 100;
})();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

async function yelpSearch(restaurant, city, state) {
  try {
    const res = await axios.get(YELP_SEARCH, {
      headers: { Authorization: `Bearer ${YELP_KEY}` },
      params: { term: restaurant, location: `${city}, ${state}`, limit: 5, categories: 'restaurants,food' },
      timeout: 10000
    });

    const words = restaurant.toLowerCase().split(/[\s\-&,'/]+/).filter(w => w.length >= 3);
    for (const b of (res.data?.businesses || [])) {
      const name = (b.name || '').toLowerCase();
      if (!words.some(w => name.includes(w))) continue;

      const loc = b.location || {};
      return {
        name:       b.name,
        rating:     b.rating ?? null,
        price:      b.price ?? null,
        image:      b.image_url || null,
        phone:      b.display_phone || null,
        isClosed:   b.is_closed ?? null,
        url:        b.url || null,
        menuUrl:    b.attributes?.menu_url || null,
        address:    [loc.address1, loc.city, loc.state, loc.zip_code].filter(Boolean).join(', '),
        categories: (b.categories || []).map(c => c.title),
        lat:        b.coordinates?.latitude ?? null,
        lng:        b.coordinates?.longitude ?? null,
      };
    }
  } catch (e) {
    if (e.response?.status === 429) {
      console.log('\n  Rate limited — waiting 60s…');
      await sleep(60000);
    }
  }
  return null;
}

async function main() {
  const awards  = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const details = load(DETAILS_FILE);

  // Collect unique target restaurants: Winners OR 2023+, not yet in details cache
  const seen = new Set();
  const targets = [];
  for (const a of awards) {
    if (a.status !== 'Winner' && parseInt(a.year) < 2023) continue;
    const key = `${a.restaurant || a.name}|${a.city}|${a.state}`;
    if (seen.has(key) || key in details) continue;
    seen.add(key);
    targets.push({ key, restaurant: a.restaurant || a.name, city: a.city, state: a.state });
  }

  // Sort by award frequency so the most-nominated come first
  const freq = {};
  awards.forEach(a => {
    const k = `${a.restaurant || a.name}|${a.city}|${a.state}`;
    freq[k] = (freq[k] || 0) + 1;
  });
  targets.sort((a, b) => (freq[b.key] || 0) - (freq[a.key] || 0));

  const batch = targets.slice(0, limit);
  console.log(`Targets available: ${targets.length} | Processing: ${batch.length} | Already cached: ${Object.keys(details).length}`);
  console.log(`Estimated Yelp calls: ${batch.length}\n`);

  let found = 0;
  for (let i = 0; i < batch.length; i++) {
    const { key, restaurant, city, state } = batch[i];
    process.stdout.write(`[${i + 1}/${batch.length}] ${restaurant.substring(0, 45).padEnd(45)}`);

    const result = await yelpSearch(restaurant, city, state);
    details[key] = result; // store null explicitly so we don't retry misses

    if (result) {
      found++;
      process.stdout.write(` ✓  ${result.rating}★ ${result.price || ''}  ${result.menuUrl ? '📋' : ''}\n`);
    } else {
      process.stdout.write(' —\n');
    }

    if ((i + 1) % 25 === 0) fs.writeFileSync(DETAILS_FILE, JSON.stringify(details, null, 2));
    await sleep(250);
  }

  fs.writeFileSync(DETAILS_FILE, JSON.stringify(details, null, 2));

  const withRating  = Object.values(details).filter(d => d?.rating).length;
  const withMenu    = Object.values(details).filter(d => d?.menuUrl).length;
  const withImage   = Object.values(details).filter(d => d?.image).length;
  const closed      = Object.values(details).filter(d => d?.isClosed).length;

  console.log(`\n✅ Done — ${found}/${batch.length} matched`);
  console.log(`   Total cached: ${Object.keys(details).length}`);
  console.log(`   With rating:  ${withRating}`);
  console.log(`   With menu URL:${withMenu}`);
  console.log(`   With image:   ${withImage}`);
  console.log(`   Marked closed:${closed}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
