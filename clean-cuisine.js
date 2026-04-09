/**
 * clean-cuisine.js
 * Strips non-food/beverage categories from cuisine-cache.json.
 * Removes entries whose only categories were junk.
 */

const fs = require('fs');

const REMOVE = new Set([
  // medical / health
  'services','health services',"doctor's office",'medical practice','medical clinic',
  'dentist\'s','psychotherapist','psychological services','rehabilitation center',
  'alternative healthcare','physiotherapist','chiropractor','hospital','hospital unit',
  'nursing home','care services','dietitians',
  // office / professional
  'office','real estate agent','lawyer','financial services','consulting','insurance broker',
  'notary','ad agency','ngo','government','government buildings','community service/non-profit',
  // retail / shopping
  'shopping','jewelry store','flower shop','clothes store','furniture store','cosmetics shop',
  'bookstore','arts and craft store','pawn shop','smoke shop','shopping mall','nail salon',
  'garden center','art','art gallery','art galleries','music store','tattoo shop',
  // transport / infrastructure
  'transportation','bus stop','parking','atm','car wash','mechanic','equipment rental',
  'shipping store','warehouse','factory',
  // education
  'education','school','trade school','kindergarten','specialty schools','music school',
  'dance studio','childcare',
  // hospitality / lodging (not specifically food)
  'hotel','lodging','resort','bed & breakfast','apartment or condo',
  // leisure / outdoors (non-food)
  'outdoors','park','golf course','sports','bowling','fishing','boat rental','playground',
  'aquarium','lake','nature reserve','historic site',
  // venues / other
  'event space','conference center','museum','tourist attraction','place of worship',
  'buddhist temple','temple','church','social club','design studio','photographer',
  'music venue','nightclub','video games','laundry','garden','farm',
  // other junk
  'salon','barber','bank','hospital','insurance broker','wholesale',
]);

const cache = JSON.parse(fs.readFileSync('data/cuisine-cache.json', 'utf8'));

let removed = 0, cleaned = 0, kept = 0;
const out = {};

for (const [key, cats] of Object.entries(cache)) {
  const filtered = cats.filter(c => !REMOVE.has(c.toLowerCase()) && !REMOVE.has(c));
  if (filtered.length === 0) { removed++; continue; }
  if (filtered.length < cats.length) cleaned++;
  else kept++;
  out[key] = filtered;
}

fs.writeFileSync('data/cuisine-cache.json', JSON.stringify(out, null, 2));
console.log(`Kept intact:   ${kept}`);
console.log(`Cleaned (some cats removed): ${cleaned}`);
console.log(`Removed entirely (all cats were junk): ${removed}`);
console.log(`Remaining entries: ${Object.keys(out).length}`);

// Show final category distribution
const cats = {};
Object.values(out).flat().forEach(c => cats[c] = (cats[c]||0)+1);
console.log('\nTop 30 remaining categories:');
Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,30)
  .forEach(([c,n]) => console.log(n.toString().padStart(4), c));
