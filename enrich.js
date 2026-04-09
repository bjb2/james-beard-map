/**
 * Phase 4: Enrich award entries with website, image, and Google Maps link.
 *
 * Sources (all free, no API keys required):
 *   1. Google Maps URL   — constructed from name + location (instant)
 *   2. DuckDuckGo IA     — official website, description, image for known places
 *   3. Wikipedia API     — thumbnail + description fallback
 *
 * Output: data/enriched.json  — map of restaurant|city|state → { mapsUrl, website, image, description }
 * The awards.json is then rebuilt with enrichment merged in.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const AWARDS_FILE = path.join(DATA, 'awards.json');
const ENRICHED_FILE = path.join(DATA, 'enriched.json');
const HEADERS = { 'User-Agent': 'JamesBeardAwardsMap/1.0 (educational/non-commercial)' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// ── Google Maps URL (free, instant) ─────────────────────────────────────────
function buildMapsUrl(restaurant, city, state, lat, lng) {
  if (lat && lng) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant || city)}&query_place_id=&center=${lat},${lng}`;
  }
  const q = encodeURIComponent(`${restaurant || ''} ${city} ${state}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// ── DuckDuckGo Instant Answer ────────────────────────────────────────────────
async function duckduckgoSearch(query) {
  try {
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
      headers: HEADERS,
      timeout: 8000
    });
    const d = res.data;
    // Only use if DDG found a specific entity (AbstractURL means it found a real result)
    if (d.AbstractURL || d.AbstractText) {
      return {
        website: d.AbstractURL || null,
        description: d.AbstractText?.substring(0, 300) || null,
        image: d.Image ? `https://duckduckgo.com${d.Image}` : null,
        source: 'duckduckgo'
      };
    }
    // Check related topics for a website
    if (d.Results?.length > 0 && d.Results[0].FirstURL) {
      return { website: d.Results[0].FirstURL, source: 'duckduckgo' };
    }
  } catch (e) {}
  return null;
}

// ── Wikipedia API ────────────────────────────────────────────────────────────
async function wikipediaSearch(query) {
  try {
    // Search for the article
    const searchRes = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: { action: 'query', list: 'search', srsearch: query, srlimit: 1, format: 'json' },
      headers: HEADERS,
      timeout: 8000
    });
    const hits = searchRes.data?.query?.search;
    if (!hits?.length) return null;

    const title = hits[0].title;
    // Check title looks relevant (contains part of restaurant name or city)
    const queryWords = query.toLowerCase().split(' ').filter(w => w.length > 3);
    const titleLower = title.toLowerCase();
    if (!queryWords.some(w => titleLower.includes(w))) return null;

    // Get page summary with thumbnail
    const summaryRes = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: HEADERS, timeout: 8000 }
    );
    const s = summaryRes.data;
    return {
      website: s.content_urls?.desktop?.page || null,
      description: s.extract?.substring(0, 300) || null,
      image: s.thumbnail?.source || s.originalimage?.source || null,
      source: 'wikipedia'
    };
  } catch (e) {}
  return null;
}

// ── Enrich one restaurant ────────────────────────────────────────────────────
async function enrichRestaurant(restaurant, city, state, lat, lng) {
  const result = {
    mapsUrl: buildMapsUrl(restaurant, city, state, lat, lng),
    website: null,
    image: null,
    description: null,
    source: null
  };

  const name = restaurant || '';
  if (!name) return result;

  // 1. Try DuckDuckGo with "Restaurant Name City" query
  const ddg = await duckduckgoSearch(`${name} restaurant ${city} ${state}`);
  if (ddg?.website || ddg?.image) {
    result.website = ddg.website || null;
    result.image = ddg.image || null;
    result.description = ddg.description || null;
    result.source = 'duckduckgo';
  }

  // 2. Wikipedia fallback for image/description
  if (!result.image || !result.description) {
    const wiki = await wikipediaSearch(`${name} restaurant ${city}`);
    if (wiki) {
      if (!result.image && wiki.image) result.image = wiki.image;
      if (!result.description && wiki.description) result.description = wiki.description;
      if (!result.website && wiki.website) result.website = wiki.website;
      if (!result.source) result.source = 'wikipedia';
    }
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const enriched = loadCache(ENRICHED_FILE);

  console.log(`Loaded ${awards.length} awards`);
  console.log(`Already enriched: ${Object.keys(enriched).length}`);

  // Build unique restaurant+location keys, prioritizing winners and precise pins
  const toEnrich = new Map();
  const sorted = [...awards].sort((a, b) => {
    const s = { Winner: 0, Semifinalist: 1, Nominee: 2 };
    return (s[a.status] || 2) - (s[b.status] || 2);
  });

  for (const a of sorted) {
    const key = `${a.restaurant || a.name}|${a.city}|${a.state}`;
    if (!enriched[key] && !toEnrich.has(key)) {
      toEnrich.set(key, { restaurant: a.restaurant || a.name, city: a.city, state: a.state, lat: a.lat, lng: a.lng });
    }
  }

  const total = toEnrich.size;
  console.log(`Need to enrich: ${total} unique restaurants\n`);
  console.log('Processing with 5 concurrent requests...\n');

  const CONCURRENCY = 5;
  const SAVE_EVERY = 25;
  let done = 0, withWebsite = 0, withImage = 0;
  const entries = [...toEnrich.entries()];

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(([key, { restaurant, city, state, lat, lng }]) =>
        enrichRestaurant(restaurant, city, state, lat, lng).then(r => ({ key, r }))
      )
    );

    for (const { key, r } of results) {
      enriched[key] = r;
      done++;
      if (r.website) withWebsite++;
      if (r.image) withImage++;
    }

    process.stdout.write(
      `\r[${done}/${total}] 🌐 ${withWebsite} websites | 🖼 ${withImage} images`.padEnd(70)
    );

    if (done % SAVE_EVERY === 0 || done === total) {
      fs.writeFileSync(ENRICHED_FILE, JSON.stringify(enriched));
      // Rebuild awards.json with enrichment
      rebuildAwards(awards, enriched);
    }

    if (i + CONCURRENCY < entries.length) await sleep(300);
  }

  console.log(`\n\nDone! ${withWebsite} websites, ${withImage} images found`);
  rebuildAwards(awards, enriched);
  console.log('Saved → data/awards.json');
}

function rebuildAwards(awards, enriched) {
  const merged = awards.map(a => {
    const key = `${a.restaurant || a.name}|${a.city}|${a.state}`;
    const e = enriched[key];
    if (!e) return a;
    return {
      ...a,
      mapsUrl: e.mapsUrl || null,
      website: e.website || null,
      image: e.image || null,
      description: e.description || null
    };
  });
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(merged));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
