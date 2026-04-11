'use strict';
// Visits each Repsol detail page to extract the sol tier from
// span.hero__ficha__info__category, then updates repsol-raw.json.
// Run once, then: node fetch-repsol.js --rebuild && node merge-repsol.js

const { chromium } = require('playwright-chromium');
const fs   = require('fs');
const path = require('path');

const RAW_FILE = path.join(__dirname, 'data', 'repsol-raw.json');
const RATE_MS  = 900;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTier(text) {
  // Normalize accents: Sóis → sois, Sóles → soles, etc.
  const s = (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (s.includes('3')) return '3 Soles';
  if (s.includes('2')) return '2 Soles';
  if (s.includes('1')) return '1 Sol';
  if (/recom|selec/i.test(s)) return 'Recommended';
  return null;
}

async function main() {
  const entries = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  console.log(`Patching tiers for ${entries.length} entries…`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let patched = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    process.stdout.write(`  [${(i+1).toString().padStart(3)}/${entries.length}] ${entry.url.slice(-40).padEnd(40)} `);
    try {
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const text = await page.$eval(
        'span.hero__ficha__info__category, [class*="hero__ficha__info__category"]',
        el => el.textContent.trim()
      ).catch(() => null);
      const tier = parseTier(text);
      entry.tier = tier;
      if (tier) patched++;
      process.stdout.write(`${tier || '(none)'}\n`);
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message.split('\n')[0]}\n`);
    }
    if ((i + 1) % 20 === 0) fs.writeFileSync(RAW_FILE, JSON.stringify(entries, null, 2));
    await sleep(RATE_MS);
  }

  fs.writeFileSync(RAW_FILE, JSON.stringify(entries, null, 2));
  await browser.close();

  console.log(`\nPatched ${patched} / ${entries.length} entries with tier.`);
  console.log('Next: node fetch-repsol.js --rebuild && node merge-repsol.js && node split-data.js');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
