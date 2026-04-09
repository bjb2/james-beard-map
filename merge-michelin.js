/**
 * merge-michelin.js
 *
 * Merges data/michelin.json into data/awards.json:
 *   - JBF records that match a Michelin restaurant get michelinAward added
 *   - Michelin-only restaurants are appended as new records (source: 'michelin')
 *
 * Matching: word-overlap on name + same city (case-insensitive)
 *
 * Usage: node merge-michelin.js
 * Safe to re-run — reads the original JBF-only backup if present.
 */

const fs   = require('fs');
const path = require('path');

const AWARDS_FILE  = path.join(__dirname, 'data', 'awards.json');
const BACKUP_FILE  = path.join(__dirname, 'data', 'awards.jbf.json');
const MICHELIN_FILE = path.join(__dirname, 'data', 'michelin.json');

// Word-overlap name matching (same approach as geocode.js)
function nameWords(s) {
  return (s || '').toLowerCase().split(/[\s\-&,'/()]+/).filter(w => w.length >= 3);
}
function namesMatch(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  return wa.some(w => wb.some(v => v.includes(w) || w.includes(v)));
}
function citiesMatch(a, b) {
  return (a || '').toLowerCase().trim() === (b || '').toLowerCase().trim();
}

function main() {
  // Always work from a clean JBF-only backup so re-runs are safe
  let jbfAwards;
  if (fs.existsSync(BACKUP_FILE)) {
    console.log('Using existing JBF backup…');
    jbfAwards = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  } else {
    jbfAwards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
    // Strip any previously merged Michelin-only records before saving backup
    const onlyJbf = jbfAwards.filter(a => a.source !== 'michelin');
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(onlyJbf, null, 2));
    jbfAwards = onlyJbf;
    console.log(`Backed up ${jbfAwards.length} JBF records → awards.jbf.json`);
  }

  const michelin = JSON.parse(fs.readFileSync(MICHELIN_FILE, 'utf8'));
  console.log(`JBF records: ${jbfAwards.length} | Michelin records: ${michelin.length}`);

  // Build city → michelin records lookup
  const michelinByCity = new Map();
  for (const m of michelin) {
    const key = (m.city || '').toLowerCase().trim();
    if (!michelinByCity.has(key)) michelinByCity.set(key, []);
    michelinByCity.get(key).push(m);
  }

  // Track which Michelin records matched a JBF record
  const matched = new Set();

  // Annotate JBF records that have a Michelin match
  let jbfEnriched = 0;
  const enriched = jbfAwards.map(a => {
    const cityKey = (a.city || '').toLowerCase().trim();
    const candidates = michelinByCity.get(cityKey) || [];
    const restName = a.restaurant || a.name || '';
    const match = candidates.find(m => namesMatch(restName, m.restaurant));
    if (!match) return a;
    matched.add(match);
    jbfEnriched++;
    return {
      ...a,
      michelinAward:  match.michelinAward,
      michelinUrl:    match.michelinUrl    || a.michelinUrl    || undefined,
      greenStar:      match.greenStar      || undefined,
    };
  });

  // Build Michelin-only records for unmatched entries
  const michelinOnly = michelin
    .filter(m => !matched.has(m))
    .map(m => ({
      source:        'michelin',
      restaurant:    m.restaurant,
      city:          m.city,
      country:       m.country,
      address:       m.address || null,
      lat:           m.lat,
      lng:           m.lng,
      precise:       !!(m.lat && m.lng),
      michelinAward: m.michelinAward,
      greenStar:     m.greenStar || false,
      cuisine:       m.cuisine   || null,
      price:         m.price     || null,
      website:       m.website   || null,
      michelinUrl:   m.michelinUrl || null,
      phone:         m.phone     || null,
      cuisineTags:   m.cuisine ? m.cuisine.split(',').map(s => s.trim()).filter(Boolean) : [],
    }));

  const merged = [...enriched, ...michelinOnly];
  fs.writeFileSync(AWARDS_FILE, JSON.stringify(merged));

  console.log(`\nResults:`);
  console.log(`  JBF records annotated with Michelin data: ${jbfEnriched}`);
  console.log(`  Michelin-only records added:              ${michelinOnly.length}`);
  console.log(`  Total records in awards.json:             ${merged.length}`);

  // Breakdown of Michelin-only by award
  const byAward = {};
  michelinOnly.forEach(m => byAward[m.michelinAward] = (byAward[m.michelinAward]||0)+1);
  console.log('\nMichelin-only by tier:');
  Object.entries(byAward).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${v.toString().padStart(5)}  ${k}`));
}

main();
