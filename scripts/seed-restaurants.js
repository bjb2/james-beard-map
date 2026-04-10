/**
 * seed-restaurants.js
 *
 * Reads awards.json and upserts into the Supabase `restaurants` and
 * `restaurant_awards` tables.  Safe to re-run — uses upsert throughout.
 *
 * Usage:
 *   SUPABASE_URL=https://... SUPABASE_KEY=<service_role_key> node scripts/seed-restaurants.js
 *
 * Or create a .env file with those vars and run:
 *   node -r dotenv/config scripts/seed-restaurants.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bnlnlfnrkwizviiabhex.supabase.co';
// Accept key from env var OR as first CLI argument
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.argv[2];

if (!SUPABASE_KEY) {
  console.error('ERROR: Supabase service role key is required.');
  console.error('  node scripts/seed-restaurants.js <service_role_key>');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const AWARDS_FILE = path.join(__dirname, '../data/awards.json');
const BATCH_SIZE  = 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATE_ABBR = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DC:'District of Columbia', DE:'Delaware',
  FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois',
  IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana',
  ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota',
  MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada',
  NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York',
  NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon',
  PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota',
  TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia',
  WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming',
};

/**
 * Some data sources (e.g. Michelin) embed the state abbreviation in the city
 * field ("San Antonio, TX") with no separate state and country="USA".
 * Normalize these so all US restaurants share the same city/state format.
 * Returns { city, state, country }.
 */
function normalizeLocation(entry) {
  let city    = (entry.city    || '').trim();
  let state   = (entry.state   || '').trim() || null;
  let country = (entry.country || '').trim() || null;

  // Strip embedded state abbreviation from city: "San Antonio, TX" → city="San Antonio", state="Texas"
  const m = city.match(/^(.+),\s*([A-Z]{2})$/);
  if (m && STATE_ABBR[m[2]]) {
    city    = m[1].trim();
    state   = state || STATE_ABBR[m[2]];
    country = (country === 'USA' || !country) ? null : country;
  }

  return { city: city || null, state, country };
}

function makeKey(entry) {
  const name  = (entry.restaurant || entry.name || '').trim();
  const { city, state, country } = normalizeLocation(entry);
  const place = state || country || '';
  return [name, city || '', place].join('|');
}

/**
 * Determine Michelin award_type from raw entry.
 * One entry can produce multiple award rows (star + green star).
 */
function michelinAwardRows(entry, key) {
  const rows = [];

  if (entry.greenStar) {
    rows.push({
      restaurant_key: key,
      source:         'michelin',
      award_type:     'Green Star',
      award_detail:   'Michelin Green Star',
      year:           null,
    });
  }

  const award = entry.michelinAward || '';
  if (award.includes('3') || award.toLowerCase().includes('three')) {
    rows.push({ restaurant_key: key, source: 'michelin', award_type: 'Star', award_detail: 'Three Stars', year: null });
  } else if (award.includes('2') || award.toLowerCase().includes('two')) {
    rows.push({ restaurant_key: key, source: 'michelin', award_type: 'Star', award_detail: 'Two Stars', year: null });
  } else if (award.includes('1') || award.toLowerCase().includes('one') || award.toLowerCase().includes('star')) {
    rows.push({ restaurant_key: key, source: 'michelin', award_type: 'Star', award_detail: 'One Star', year: null });
  } else if (award.toLowerCase().includes('bib')) {
    rows.push({ restaurant_key: key, source: 'michelin', award_type: 'Bib Gourmand', award_detail: award, year: null });
  } else if (award.toLowerCase().includes('selected') || award.toLowerCase().includes('recommended')) {
    rows.push({ restaurant_key: key, source: 'michelin', award_type: 'Selected', award_detail: award, year: null });
  } else if (award) {
    // Unknown Michelin award type — store it as-is
    rows.push({ restaurant_key: key, source: 'michelin', award_type: award, award_detail: award, year: null });
  }

  return rows;
}

function buildRestaurant(entry, key) {
  const yelp    = entry.yelpDetail || {};
  const photo   = entry.googlePhoto || yelp.image || null;
  const cuisine = entry.cuisineTags || (entry.cuisine ? [entry.cuisine] : null) || null;
  const { city, state, country } = normalizeLocation(entry);

  return {
    key,
    name:             (entry.restaurant || entry.name || '').trim(),
    city,
    state,
    country,
    address:          entry.address || yelp.address || null,
    lat:              entry.lat  ?? null,
    lng:              entry.lng  ?? null,
    photo_url:        photo,
    cuisine_tags:     cuisine,
    cuisine_category: entry.cuisineCategory || null,
    business_status:  entry.businessStatus || null,
    is_closed:        yelp.isClosed ?? false,
    website:          entry.website || null,
    phone:            entry.phone || yelp.phone || null,
    yelp_url:         yelp.url || null,
    michelin_url:     entry.michelinUrl || null,
    price:            entry.price || yelp.price || null,
    updated_at:       new Date().toISOString(),
  };
}

function buildJbfAwardRow(entry, key) {
  // Skip individual nominees where the restaurant is just context
  // (type === 'individual' means a chef was nominated, not the restaurant itself)
  return {
    restaurant_key: key,
    source:         'jbf',
    award_type:     entry.status || null,      // 'Winner' | 'Nominee'
    award_detail:   entry.category || null,    // e.g. "Best New Restaurant"
    year:           entry.year ? parseInt(entry.year, 10) : null,
  };
}

async function upsertBatch(table, rows, conflictKey) {
  const { error } = await sb
    .from(table)
    .upsert(rows, { onConflict: conflictKey, ignoreDuplicates: false });
  if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Reading awards.json…');
  const raw = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  console.log(`  ${raw.length} total award entries`);

  // Build deduplicated restaurant map and award rows list
  const restaurantMap = new Map();  // key → restaurant row
  const awardRows     = [];

  for (const entry of raw) {
    const key = makeKey(entry);
    if (!key.startsWith('|')) {
      // Upsert restaurant (last-write-wins for display data; photo/coords preferred)
      if (!restaurantMap.has(key)) {
        restaurantMap.set(key, buildRestaurant(entry, key));
      } else {
        // Prefer entries with more complete data
        const existing = restaurantMap.get(key);
        const update   = buildRestaurant(entry, key);
        if (!existing.photo_url && update.photo_url) existing.photo_url = update.photo_url;
        if (!existing.lat       && update.lat)       { existing.lat = update.lat; existing.lng = update.lng; }
        if (!existing.website   && update.website)   existing.website   = update.website;
        if (!existing.address   && update.address)   existing.address   = update.address;
        if (!existing.phone     && update.phone)     existing.phone     = update.phone;
        if (!existing.michelin_url && update.michelin_url) existing.michelin_url = update.michelin_url;
        if (!existing.cuisine_tags     && update.cuisine_tags)     existing.cuisine_tags     = update.cuisine_tags;
        if (!existing.cuisine_category && update.cuisine_category) existing.cuisine_category = update.cuisine_category;
      }
    }

    // Award rows
    if (entry.source === 'michelin' || entry.type === 'michelin') {
      awardRows.push(...michelinAwardRows(entry, key));
    } else if (entry.source === 'texasmonthly') {
      awardRows.push({
        restaurant_key: key,
        source:         'texasmonthly',
        award_type:     'Top 50',
        award_detail:   'Texas Monthly Top 50 BBQ',
        year:           entry.tmYear || null,
      });
    } else {
      // JBF — only org nominations are restaurant awards; individual nominees link chef to restaurant
      awardRows.push(buildJbfAwardRow(entry, key));
    }
  }

  const restaurants = [...restaurantMap.values()];
  console.log(`  ${restaurants.length} unique restaurants`);
  console.log(`  ${awardRows.length} award records`);

  // ── Upsert restaurants ──────────────────────────────────────────────────────
  console.log('\nUpserting restaurants…');
  for (let i = 0; i < restaurants.length; i += BATCH_SIZE) {
    const batch = restaurants.slice(i, i + BATCH_SIZE);
    await upsertBatch('restaurants', batch, 'key');
    process.stdout.write(`  ${Math.min(i + BATCH_SIZE, restaurants.length)} / ${restaurants.length}\r`);
  }
  console.log(`  Done.`);

  // ── Upsert award rows ───────────────────────────────────────────────────────
  // Awards have no natural unique key beyond (restaurant_key, source, award_type, year, award_detail).
  // We delete-then-insert per source to stay idempotent.
  console.log('\nReplacing award records…');

  const sources = [...new Set(awardRows.map(r => r.source))];
  for (const source of sources) {
    const { error: delErr } = await sb
      .from('restaurant_awards')
      .delete()
      .eq('source', source);
    if (delErr) throw new Error(`Delete awards for ${source} failed: ${delErr.message}`);

    const rows = awardRows.filter(r => r.source === source);
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await sb.from('restaurant_awards').insert(batch);
      if (error) throw new Error(`Insert awards (${source}) failed: ${error.message}`);
      process.stdout.write(`  [${source}] ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}\r`);
    }
    console.log(`  [${source}] ${rows.length} rows inserted.`);
  }

  console.log('\nSeed complete.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
