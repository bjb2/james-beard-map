/**
 * fetch-tabelog.js
 *
 * Phase 1: Scrape https://award.tabelog.com/en/2025/restaurants
 *          → All restaurant cards (name, award tier, area, genre, score, URL)
 *
 * Phase 2: Visit each restaurant's Tabelog detail page
 *          → address, lat/lng (from JSON-LD), phone, website, price, photo
 *          No Google API needed — coordinates come from schema.org JSON-LD.
 *
 * Outputs:
 *   data/tabelog-raw.json    raw listing entries (for inspection/debug)
 *   data/tabelog-cache.json  per-URL detail cache (re-run safe)
 *   data/tabelog.json        final enriched records → input for merge-tabelog.js
 *
 * Usage:
 *   node fetch-tabelog.js                # full run
 *   node fetch-tabelog.js --listing-only # phase 1 only (inspect raw output first)
 *   node fetch-tabelog.js --skip-cache   # ignore detail cache (re-fetch all pages)
 */

'use strict';

const { chromium } = require('playwright-chromium');
const fs   = require('fs');
const path = require('path');

const YEAR      = '2025';
const BASE_URL  = `https://award.tabelog.com/en/${YEAR}/restaurants`;
const CACHE_FILE = path.join(__dirname, 'data', 'tabelog-cache.json');
const RAW_FILE   = path.join(__dirname, 'data', 'tabelog-raw.json');
const OUT_FILE   = path.join(__dirname, 'data', 'tabelog.json');

const LISTING_ONLY = process.argv.includes('--listing-only');
const SKIP_CACHE   = process.argv.includes('--skip-cache');
const RATE_MS      = 1500; // 1.5 s between detail page requests

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache() {
  if (!SKIP_CACHE && fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
    catch { return {}; }
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Ensure Tabelog detail URL uses the English sub-domain/path
function toEnglishUrl(url) {
  if (!url) return url;
  // https://tabelog.com/tokyo/... → https://tabelog.com/en/tokyo/...
  // https://tabelog.com/en/... → unchanged
  return url.replace(/^(https?:\/\/tabelog\.com\/)(?!en\/)/, '$1en/');
}

// ── Phase 1: Scrape awards listing (paginated via ?page=N) ───────────────────

// Max pages to try — set higher than expected so we always reach the last page
const MAX_PAGES = 30;

async function scrapeListing(page) {
  console.log(`\n── Phase 1: Paginating through ${BASE_URL}?page=N ──`);

  const seen    = new Set();   // deduplicate by Tabelog URL
  const entries = [];

  let acceptedCookies = false;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = pageNum === 1 ? BASE_URL : `${BASE_URL}?page=${pageNum}`;
    console.log(`  Page ${pageNum}: ${url}`);

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    // Accept cookies once on the first page
    if (!acceptedCookies) {
      try {
        const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("Agree"), [class*="accept"]');
        if (await cookieBtn.count() > 0) {
          await cookieBtn.first().click({ timeout: 3000 });
          await sleep(500);
        }
        acceptedCookies = true;
      } catch {}
    }

    // Wait for restaurant cards to appear
    await sleep(800);

    // Extract cards from this page
    const cards = await extractDomCards(page);

    if (cards.length === 0) {
      // No results on this page — we've gone past the last page
      console.log(`  No cards found on page ${pageNum} — stopping pagination`);
      break;
    }

    // Check if all URLs on this page are already seen (also means we're done)
    const withUrl = cards.filter(c => c.url && c.url.includes('tabelog.com'));
    const newCards = withUrl.filter(c => !seen.has(c.url));

    if (newCards.length === 0 && pageNum > 1) {
      console.log(`  All ${withUrl.length} entries already seen — stopping`);
      break;
    }

    for (const card of newCards) {
      seen.add(card.url);
      entries.push(card);
    }
    console.log(`  +${newCards.length} new entries (${entries.length} total)`);

    await sleep(600); // be polite between pages
  }

  return entries;
}

async function extractDomCards(page) {
  return page.evaluate(() => {
    // Try a battery of selectors for restaurant card containers
    const selectors = [
      '[class*="RestaurantCard"]',
      '[class*="restaurant-card"]',
      '[class*="award-restaurant"]',
      '[class*="shop-list"] li',
      '[class*="restaurant-list"] li',
      '[class*="award-list"] li',
      'ul[class*="list"] > li',
      '[data-restaurant-id]',
      '[data-shop-id]',
    ];

    let cards = [];
    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)];
      // Only use if we get a meaningful number of results
      if (els.length >= 3) { cards = els; break; }
    }

    // If nothing found, try any <li> that contains a tabelog link
    if (cards.length === 0) {
      cards = [...document.querySelectorAll('li')].filter(li =>
        li.querySelector('a[href*="tabelog.com"]')
      );
    }

    const seen = new Set();
    const results = [];

    for (const card of cards) {
      const linkEl = card.querySelector('a[href*="tabelog.com"]');
      if (!linkEl) continue;
      const url = linkEl.href;
      if (seen.has(url)) continue;
      seen.add(url);

      // Award tier: look for badge/label text containing Gold/Silver/Bronze
      let awardTier = '';
      for (const el of card.querySelectorAll('[class*="badge"], [class*="award"], [class*="rank"], [class*="label"], [class*="tier"], span, div')) {
        const t = el.textContent.trim();
        if (/gold|silver|bronze|special/i.test(t) && t.length < 30) {
          awardTier = t;
          break;
        }
      }

      // Restaurant name (prefer heading elements)
      const nameEl = card.querySelector('h3, h2, h4, [class*="name"], [class*="title"]');
      const name = nameEl?.textContent?.trim() || linkEl.textContent.trim() || '';

      // Area / prefecture
      const areaEl = card.querySelector('[class*="area"], [class*="location"], [class*="address"], [class*="prefecture"], [class*="region"]');
      const area = areaEl?.textContent?.trim() || '';

      // Cuisine / genre
      const genreEl = card.querySelector('[class*="genre"], [class*="cuisine"], [class*="category"]');
      const genre = genreEl?.textContent?.trim() || '';

      // Score
      const scoreEl = card.querySelector('[class*="score"], [class*="rating"], [class*="point"]');
      const score = parseFloat(scoreEl?.textContent?.trim()) || null;

      results.push({ name, url, awardTier, area, genre, score });
    }

    return results;
  });
}

// ── Phase 2: Scrape individual restaurant detail pages ────────────────────────

async function scrapeDetail(page, url, cache) {
  if (!SKIP_CACHE && cache[url] !== undefined) return cache[url];

  const englishUrl = toEnglishUrl(url);

  try {
    await page.goto(englishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(400);

    const result = await page.evaluate(() => {
      // ── JSON-LD structured data (most reliable source) ──────────────────
      let jsonLd = null;
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(el.textContent);
          const type = Array.isArray(d) ? null : d['@type'];
          if (type === 'Restaurant' || type === 'FoodEstablishment' || type === 'LocalBusiness') {
            jsonLd = d;
            break;
          }
          // Sometimes wrapped in @graph
          if (d['@graph']) {
            const item = d['@graph'].find(x => ['Restaurant', 'FoodEstablishment', 'LocalBusiness'].includes(x['@type']));
            if (item) { jsonLd = item; break; }
          }
        } catch {}
      }

      // ── DOM fallback selectors ────────────────────────────────────────────
      // Tabelog uses Japanese-style address: 都 > 区 > 番地
      const getText = sel => document.querySelector(sel)?.textContent?.trim() || null;
      const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

      const domName    = getText('h1, [class*="rst-name"], [class*="rdname"]');
      const domAddress = getText('[class*="rstinfo-table"] .rstinfo-table__prop-area, address, [class*="address"]');
      const domPhone   = getText('[class*="rstinfo-table__tel"], [class*="tel"], [class*="phone"]');
      const domWebsite = getAttr('[class*="rst-url"] a, [class*="rdpro-link"] a', 'href');
      const domPrice   = getText('[class*="rdprice"], [class*="price"]');
      const domGenre   = getText('[class*="rst-category"], [class*="genre"]');

      // Photo: primary restaurant image
      const domPhoto = getAttr(
        '.rdb-hd__photos-main img, [class*="main-photo"] img, [class*="hero"] img, [class*="rst-thumbnail"] img',
        'src'
      ) || getAttr(
        '.rdb-hd__photos-main img, [class*="main-photo"] img',
        'data-src'
      );

      return { jsonLd, domName, domAddress, domPhone, domWebsite, domPrice, domGenre, domPhoto };
    });

    cache[url] = result;
    return result;

  } catch (e) {
    console.warn(`\n  ! Failed ${englishUrl}: ${e.message.split('\n')[0]}`);
    cache[url] = null;
    return null;
  }
}

// ── Record normalization ───────────────────────────────────────────────────────

function normalizeTier(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('gold'))    return 'Gold';
  if (s.includes('silver'))  return 'Silver';
  if (s.includes('bronze'))  return 'Bronze';
  if (s.includes('special')) return 'Special Award';
  return null;
}

function extractAddress(jsonLd) {
  if (!jsonLd?.address) return null;
  const a = jsonLd.address;
  if (typeof a === 'string') return a;
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry]
    .filter(Boolean)
    .join(', ');
}

// Extract the most specific city available:
// addressLocality (ward/city) preferred over addressRegion (prefecture)
function extractCity(jsonLd, fallbackArea) {
  if (jsonLd?.address) {
    const a = jsonLd.address;
    if (typeof a === 'object') {
      return a.addressLocality || a.addressRegion || null;
    }
  }
  return fallbackArea || null;
}

function extractPhoto(detail) {
  if (!detail) return null;
  const img = detail.jsonLd?.image;
  if (img) {
    if (typeof img === 'string') return img;
    if (Array.isArray(img) && img[0]) return typeof img[0] === 'string' ? img[0] : img[0]?.url;
    if (img.url) return img.url;
  }
  return detail.domPhoto || null;
}

// Convert Tabelog price range string to tier symbol
// Tabelog shows e.g. "¥20,000～¥29,999" or "¥3,000～¥5,999"
function normalizePriceTier(raw) {
  if (!raw) return null;
  const num = parseInt((raw + '').replace(/[^0-9]/g, ''));
  if (isNaN(num)) return null;
  if (num >= 20000) return '¥¥¥¥';
  if (num >= 8000)  return '¥¥¥';
  if (num >= 3000)  return '¥¥';
  return '¥';
}

function buildRecord(entry, detail) {
  const jl = detail?.jsonLd || null;

  const lat = jl?.geo?.latitude  != null ? parseFloat(jl.geo.latitude)  : null;
  const lng = jl?.geo?.longitude != null ? parseFloat(jl.geo.longitude) : null;

  const address  = extractAddress(jl) || detail?.domAddress || null;
  const city     = extractCity(jl, entry.area) || entry.area || null;
  const rawPrice = jl?.priceRange || detail?.domPrice || null;
  const price    = normalizePriceTier(rawPrice) || rawPrice;

  const cuisineRaw  = jl?.servesCuisine || entry.genre || detail?.domGenre || '';
  const cuisineTags = cuisineRaw
    ? cuisineRaw.split(/[,、\/・]+/).map(s => s.trim()).filter(Boolean)
    : [];

  const phone   = (jl?.telephone   || detail?.domPhone   || '').replace(/\s+/g, '') || null;
  const website = detail?.domWebsite || (jl?.url && jl.url !== entry.url ? jl.url : null) || null;

  return {
    source:       'tabelog',
    restaurant:   jl?.name || detail?.domName || entry.name || null,
    city,
    country:      'Japan',
    address,
    lat:          (lat && !isNaN(lat)) ? lat : null,
    lng:          (lng && !isNaN(lng)) ? lng : null,
    precise:      !!(lat && lng && !isNaN(lat) && !isNaN(lng)),
    tabelogAward: normalizeTier(entry.awardTier) || entry.awardTier || null,
    tabelogScore: entry.score || null,
    tabelogUrl:   entry.url   || null,
    cuisine:      cuisineRaw  || null,
    cuisineTags,
    price,
    website,
    phone,
    photo_url:    extractPhoto(detail),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const cache = loadCache();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:      'en-US',
    timezoneId:  'Asia/Tokyo',
    viewport:    { width: 1280, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();

  try {
    // ── Phase 1 ──────────────────────────────────────────────────────────────
    const rawEntries = await scrapeListing(page);

    fs.writeFileSync(RAW_FILE, JSON.stringify(rawEntries, null, 2));
    console.log(`\nSaved ${rawEntries.length} raw entries → ${RAW_FILE}`);

    if (rawEntries.length === 0) {
      console.error(`\nNo entries found. Open ${RAW_FILE} and check for issues.`);
      console.error(`Tip: run with --listing-only first to inspect raw output.`);
      await browser.close();
      return;
    }

    if (LISTING_ONLY) {
      console.log(`\n--listing-only: stopping after phase 1.`);
      await browser.close();
      return;
    }

    // ── Phase 2 ──────────────────────────────────────────────────────────────
    const withUrl = rawEntries.filter(e => e.url && e.url.includes('tabelog.com'));
    const needScrape = withUrl.filter(e => !cache[e.url]);
    const cached     = withUrl.length - needScrape.length;

    console.log(`\n── Phase 2: detail pages ──`);
    console.log(`  ${withUrl.length} restaurants total, ${cached} already cached, ${needScrape.length} to fetch`);

    let done = 0;
    const total = withUrl.length;

    for (const entry of withUrl) {
      const isCached = !SKIP_CACHE && cache[entry.url] !== undefined;
      if (!isCached) await sleep(RATE_MS);

      const label = (entry.name || entry.url).slice(0, 45);
      process.stdout.write(`  [${(++done).toString().padStart(3)}/${total}] ${label.padEnd(45)} `);

      const detail = await scrapeDetail(page, entry.url, cache);
      const jl = detail?.jsonLd;
      const hasCoords = jl?.geo?.latitude != null;
      process.stdout.write(isCached ? '(cached)\n' : hasCoords ? 'ok+coords\n' : detail ? 'ok\n' : 'FAILED\n');

      if (done % 25 === 0) saveCache(cache);
    }

    saveCache(cache);

    // ── Build final records ───────────────────────────────────────────────────
    const records = withUrl.map(entry => buildRecord(entry, cache[entry.url] || {}));

    // ── Summary ───────────────────────────────────────────────────────────────
    const byTier = {};
    records.forEach(r => { byTier[r.tabelogAward || 'Unknown'] = (byTier[r.tabelogAward || 'Unknown'] || 0) + 1; });
    console.log('\nBy award tier:');
    Object.entries(byTier).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
      console.log(`  ${v.toString().padStart(5)}  ${k}`)
    );

    const withCoords = records.filter(r => r.lat && r.lng).length;
    console.log(`\nWith coordinates: ${withCoords} / ${records.length}`);

    const withPhoto  = records.filter(r => r.photo_url).length;
    console.log(`With photo:       ${withPhoto} / ${records.length}`);

    fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
    console.log(`\nSaved → ${OUT_FILE}`);
    console.log(`\nNext step: node merge-tabelog.js`);

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
