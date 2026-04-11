/**
 * fetch-repsol.js
 *
 * Scrapes Guía Repsol award restaurants for Portugal and Spain.
 *
 * Phase 1: Discover all restaurant page URLs + award tier from listing pages
 *   PT: https://www.guiarepsol.com/pt/comer/edicoes-dos-sois-do-guia-repsol/
 *   ES: https://www.guiarepsol.com/es/soles-repsol/soles-2025/
 *   Tier detected from section headings (3 Soles/Sóis, 2 Soles/Sóis, 1 Sol)
 *
 * Phase 2: Visit each /fichas/restaurante/ page → JSON-LD for coords, address, phone, website, photo
 *
 * Outputs:
 *   data/repsol-raw.json     all discovered restaurant URLs + tiers
 *   data/repsol-cache.json   per-URL detail cache
 *   data/repsol.json         final enriched records
 *
 * Usage:
 *   node fetch-repsol.js
 *   node fetch-repsol.js --listing-only
 *   node fetch-repsol.js --skip-cache
 */

'use strict';

const { chromium } = require('playwright-chromium');
const fs   = require('fs');
const path = require('path');

const LISTING_PAGES = [
  { url: 'https://www.guiarepsol.com/pt/comer/edicoes-dos-sois-do-guia-repsol/', lang: 'pt' },
];
const RAW_FILE   = path.join(__dirname, 'data', 'repsol-raw.json');
const CACHE_FILE = path.join(__dirname, 'data', 'repsol-cache.json');
const OUT_FILE   = path.join(__dirname, 'data', 'repsol.json');

const LISTING_ONLY = process.argv.includes('--listing-only');
const SKIP_CACHE   = process.argv.includes('--skip-cache');
const REBUILD_ONLY = process.argv.includes('--rebuild');
const RATE_MS      = 1200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCache() {
  if (!SKIP_CACHE && fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}

// ── Tier normalisation ────────────────────────────────────────────────────────

function normalizeTier(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('3') || s.includes('três') || s.includes('tres')) return '3 Soles';
  if (s.includes('2') || s.includes('dois') || s.includes('dos'))  return '2 Soles';
  if (s.includes('1') || s.includes('um sol') || s.includes('un sol')) return '1 Sol';
  if (/recom|selec|guia repsol/i.test(s)) return 'Recommended';
  return null;
}

// ── Phase 1: Scrape listing page for restaurant URLs + tiers ─────────────────

async function collectRestaurantLinks(page, lang) {
  // Scroll to load lazy content
  let prevH = 0, stable = 0;
  while (stable < 3) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prevH) stable++; else { stable = 0; prevH = h; }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1000);
  }

  return page.evaluate((lang) => {
    const seen    = new Set();
    const results = [];
    const country = lang === 'pt' ? 'Portugal' : 'Spain';

    for (const a of document.querySelectorAll('a[href*="/fichas/restaurante/"], a[href*="/ficha/restaurante/"]')) {
      const url = a.href;
      if (seen.has(url)) continue;
      seen.add(url);

      // Infer tier from nearest heading ancestor
      let tier = null;
      let el   = a;
      for (let depth = 0; depth < 10 && el; depth++) {
        el = el.parentElement;
        if (!el) break;
        for (const h of el.querySelectorAll('h1,h2,h3,h4,h5')) {
          const t = h.textContent.trim();
          if (/3\s*sol/i.test(t)) { tier = '3 Soles'; break; }
          if (/2\s*sol/i.test(t)) { tier = '2 Soles'; break; }
          if (/1\s*sol/i.test(t)) { tier = '1 Sol';   break; }
        }
        if (tier) break;
      }

      const rawText = (a.textContent || a.title || '').trim().replace(/\s+/g, ' ');
      // Strip badge words ("New", "Novo", "Nuevo") that appear inside the link element
      const name = rawText.replace(/\b(new|novo|nuevo)\b/gi, '').trim().replace(/\s+/g, ' ') || null;
      results.push({ url, name, tier, country });
    }

    return results;
  }, lang);
}

async function scrapeListingPage(page, url, lang) {
  console.log(`  Scraping listing: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(800);

  const entries = await collectRestaurantLinks(page, lang);
  console.log(`    Found ${entries.length} /fichas/restaurante/ links`);

  return entries;
}

// ── Phase 2: Scrape individual restaurant detail page ────────────────────────

async function scrapeDetail(page, url, cache) {
  if (!SKIP_CACHE && cache[url] !== undefined) return cache[url];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(400);

    const result = await page.evaluate(() => {
      // JSON-LD structured data
      let jsonLd = null;
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(el.textContent);
          const type = d['@type'] || (d['@graph'] && '');
          if (['Restaurant','FoodEstablishment','LocalBusiness'].includes(type)) {
            jsonLd = d; break;
          }
          if (d['@graph']) {
            const item = d['@graph'].find(x =>
              ['Restaurant','FoodEstablishment','LocalBusiness'].includes(x['@type'])
            );
            if (item) { jsonLd = item; break; }
          }
        } catch {}
      }

      const getText = sel => document.querySelector(sel)?.textContent?.trim() || null;
      const getAttr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;

      return {
        jsonLd,
        domName:    getText('h1, [class*="title"]'),
        domCity:    getText('[class*="localidad"], [class*="ciudad"], [class*="location"]'),
        domAddress: getText('[class*="address"], [class*="direccion"], address'),
        domPhone:   getText('[class*="tel"], [class*="phone"], [class*="tlf"]'),
        domWebsite: getAttr('a[class*="web"], a[class*="website"], a[rel*="nofollow"]', 'href'),
        domPhoto:   getAttr('[class*="hero"] img, [class*="main-photo"] img, .ficha-foto img', 'src'),
        domCuisine: getText('[class*="cuisine"], [class*="cocina"], [class*="tipo"]'),
        domPrice:   getText('[class*="price"], [class*="precio"]'),
      };
    });

    cache[url] = result;
    return result;
  } catch (e) {
    console.warn(`\n  ! Failed ${url}: ${e.message.split('\n')[0]}`);
    cache[url] = null;
    return null;
  }
}

// ── Build final record ────────────────────────────────────────────────────────

function buildRecord(entry, detail) {
  const jl  = detail?.jsonLd || null;
  const lat = jl?.geo?.latitude  != null ? parseFloat(jl.geo.latitude)  : null;
  const lng = jl?.geo?.longitude != null ? parseFloat(jl.geo.longitude) : null;

  const addressParts = jl?.address;
  const address = addressParts
    ? (typeof addressParts === 'string' ? addressParts
      : [addressParts.streetAddress, addressParts.addressLocality, addressParts.addressRegion]
          .filter(Boolean).join(', '))
    : detail?.domAddress || null;

  const city = (jl?.address?.addressLocality || detail?.domCity || null);

  const cuisineRaw  = jl?.servesCuisine || detail?.domCuisine || '';
  const cuisineTags = cuisineRaw
    ? cuisineRaw.split(/[,\/;]+/).map(s => s.trim()).filter(Boolean)
    : [];

  const photo = (() => {
    const img = jl?.image;
    if (!img) return detail?.domPhoto || null;
    if (typeof img === 'string') return img;
    if (Array.isArray(img)) return typeof img[0] === 'string' ? img[0] : img[0]?.url;
    return img.url || detail?.domPhoto || null;
  })();

  return {
    source:       'repsol',
    restaurant:   jl?.name || detail?.domName || entry.name || null,
    city:         city || null,
    country:      entry.country,
    address,
    lat:          lat && !isNaN(lat) ? lat : null,
    lng:          lng && !isNaN(lng) ? lng : null,
    precise:      !!(lat && lng),
    repsolAward:  entry.tier,
    repsolUrl:    entry.url,
    cuisine:      cuisineRaw || null,
    cuisineTags,
    price:        jl?.priceRange || detail?.domPrice || null,
    website:      detail?.domWebsite || (jl?.url !== entry.url ? jl?.url : null) || null,
    phone:        (jl?.telephone || detail?.domPhone || '').replace(/\s+/g,'') || null,
    photo_url:    photo,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-ES',
    extraHTTPHeaders: { 'Accept-Language': 'es-ES,es;q=0.9,pt;q=0.8' },
  });
  const page  = await context.newPage();
  const cache = loadCache();

  try {
    // ── Rebuild-only: skip scraping, just reprocess raw + cache ──────────────
    if (REBUILD_ONLY) {
      if (!fs.existsSync(RAW_FILE)) { console.error('No repsol-raw.json found. Run without --rebuild first.'); process.exit(1); }
      const allEntries = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
      console.log(`Rebuilding from ${allEntries.length} cached entries…`);
      const records = allEntries.map(entry => buildRecord(entry, cache[entry.url] || {}));
      const withCoords = records.filter(r => r.lat && r.lng).length;
      console.log(`With coordinates: ${withCoords} / ${records.length}`);
      fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
      console.log(`Saved → ${OUT_FILE}\nNext step: node merge-repsol.js`);
      await browser.close();
      return;
    }

    // ── Phase 1 ──────────────────────────────────────────────────────────────
    console.log('\n── Phase 1: Scraping Repsol listing pages ──');
    const allEntries = [];
    const seenUrls   = new Set();

    for (const { url, lang } of LISTING_PAGES) {
      await sleep(600);
      const entries = await scrapeListingPage(page, url, lang);
      for (const e of entries) {
        if (!seenUrls.has(e.url)) {
          seenUrls.add(e.url);
          allEntries.push(e);
        }
      }
    }

    fs.writeFileSync(RAW_FILE, JSON.stringify(allEntries, null, 2));
    console.log(`\nTotal: ${allEntries.length} unique restaurant URLs`);

    const byTier = {};
    allEntries.forEach(e => { byTier[e.tier||'Unknown'] = (byTier[e.tier||'Unknown']||0)+1; });
    Object.entries(byTier).forEach(([k,v]) => console.log(`  ${v.toString().padStart(4)}  ${k}`));

    if (allEntries.length === 0) {
      console.error('\nNo URLs found — check listing pages or adjust selectors.');
      await browser.close();
      return;
    }

    if (LISTING_ONLY) {
      console.log('\n--listing-only: stopping after phase 1.');
      await browser.close();
      return;
    }

    // ── Phase 2 ──────────────────────────────────────────────────────────────
    const needFetch = allEntries.filter(e => !cache[e.url]);
    console.log(`\n── Phase 2: ${allEntries.length} detail pages (${allEntries.length - needFetch.length} cached, ${needFetch.length} to fetch) ──`);

    const records = [];
    let done = 0;

    for (const entry of allEntries) {
      const cached = !SKIP_CACHE && cache[entry.url] !== undefined;
      if (!cached) await sleep(RATE_MS);

      const label = (entry.name || entry.url).slice(0, 50);
      process.stdout.write(`  [${(++done).toString().padStart(3)}/${allEntries.length}] ${label.padEnd(50)} `);

      const detail = await scrapeDetail(page, entry.url, cache);
      const hasCoords = detail?.jsonLd?.geo?.latitude != null;
      process.stdout.write(cached ? '(cached)\n' : hasCoords ? 'ok+coords\n' : detail ? 'ok\n' : 'FAILED\n');

      if (done % 30 === 0) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      records.push(buildRecord(entry, detail || {}));
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    const withCoords = records.filter(r => r.lat && r.lng).length;
    const withPhoto  = records.filter(r => r.photo_url).length;
    console.log(`\nWith coordinates: ${withCoords} / ${records.length}`);
    console.log(`With photo:       ${withPhoto} / ${records.length}`);

    fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
    console.log(`\nSaved → ${OUT_FILE}`);
    console.log('Next step: node merge-repsol.js');

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
