/**
 * normalize-cuisine.js
 *
 * Maps the 500+ raw cuisine tags in awards.json to ~25 canonical categories,
 * writes a `cuisineCategory` field onto each record, and regenerates the
 * chunk files.
 *
 * Priority: specific cuisines win over abstract concepts (e.g. "Contemporary").
 * Texas Monthly records are always "BBQ & Smokehouse".
 * Records with no mappable tags get null (will be filled by Google enrichment).
 *
 * Usage: node normalize-cuisine.js [--dry-run]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DRY_RUN     = process.argv.includes('--dry-run');
const AWARDS_PATH = path.join(__dirname, 'data', 'awards.json');

// ── Canonical taxonomy ────────────────────────────────────────────────────────
// Ordered by priority — first match wins when a record has multiple tags.
// Lower index = wins over higher index when tags conflict.

const TAXONOMY = [
  {
    category: 'BBQ & Smokehouse',
    tags: [
      'bbq', 'barbecue', 'barbeque', 'texas bbq', 'barbecue restaurant',
      'smokehouse', 'barbecue & grills',
    ],
  },
  {
    category: 'Steakhouse',
    tags: [
      'steakhouse', 'steakhouses', 'meats and grills', 'grills', 'meats and seafood',
      'beef', 'steak_house',
    ],
  },
  {
    category: 'Japanese',
    tags: [
      'japanese', 'japanese contemporary', 'sushi', 'sushi bars', 'ramen',
      'ramen restaurant', 'noodles', 'izakaya', 'tempura', 'yakitori', 'soba',
      'teppanyaki', 'unagi / freshwater eel', 'tonkatsu', 'japanese restaurant',
      'sushi restaurant', 'japanese tempura', 'fugu / pufferfish', 'kushiage',
      'udon', 'okonomiyaki', 'yoshoku', 'obanzai', 'yakiniku', 'shabu-shabu',
      'sukiyaki', 'japanese steakhouse', 'oden', 'shojin',
      // Tabelog-specific Japanese cuisine terms
      'kaiseki', 'kaiseki/kappo', 'kappo', 'kappo cuisine',
      'washoku', 'japanese cuisine', 'nihon ryori',
      'robatayaki', 'robata', 'irori cuisine',
      'sashimi', 'fugu', 'unagi', 'eel',
      'donburi', 'katsu', 'katsudon', 'gyudon', 'unadon',
      'wagyu', 'wagyu beef',
      'oden restaurant', 'kushikatsu',
      '懐石', '会席', '割烹', '寿司', '天ぷら', '焼き鳥', 'そば', 'ラーメン',
      'すき焼き', 'しゃぶしゃぶ', '和食',
    ],
  },
  {
    category: 'Chinese',
    tags: [
      'chinese', 'cantonese', 'sichuan', 'szechuan', 'dim sum', 'chinese contemporary',
      'shanghainese', 'fujian', 'huaiyang', 'zhejiang', 'beijing cuisine',
      'chao zhou', 'jiangzhe', 'jiangsu cuisine', 'ningbo', 'taizhou',
      'chinese restaurant', 'noodles and congee', 'congee', 'hotpot',
      'hunanese', 'hunanese and sichuan', 'cantonese roast meats', 'dim sum',
      'hakkanese', 'peranakan', 'dongbei', 'hubei', 'yunnanese', 'xibei',
      'shandong', 'shaanxi', 'xinjiang', 'chiu chow', 'teochew', 'shun tak',
      'macanese', 'hainanese', 'hang zhou', 'jiangsu cuisine',
    ],
  },
  {
    category: 'Italian',
    tags: [
      'italian', 'italian contemporary', 'italian-american', 'tuscan', 'sicilian',
      'venetian', 'campanian', 'lombardian', 'ligurian', 'roman',
      'cuisine from lazio', 'emilian', 'apulian', 'milanese', 'sardinian',
      'cuisine from abruzzo', 'umbrian', 'italian restaurant',
      'cuisine from the marches', 'cuisine from the aosta valley',
      'cuisine from basilicata', 'cuisine from romagna', 'friulian',
      'south tyrolean', 'swabian', 'cuisine from valtellina', 'mantuan',
      'cuisine from parma', 'pasta shops', 'pizza', 'pizza restaurant',
      'piedmontese',
    ],
  },
  {
    category: 'French',
    tags: [
      'french', 'modern french', 'classic french', 'creative french',
      'french contemporary', 'provençal', 'lyonnaise', 'alsatian', 'breton',
      'french restaurant', 'cuisine from south west france', 'savoyard',
      'cuisine from south west france', 'burgundian',
    ],
  },
  {
    category: 'Korean',
    tags: [
      'korean', 'korean contemporary', 'korean restaurant',
      'naengmyeon', 'gomtang', 'dwaeji-gukbap', 'seolleongtang',
      'gejang', 'bulgogi', 'memil-guksu', 'kalguksu', 'mandu',
      'sujebi', 'bibimbap', 'samgyetang', 'chueotang', 'doganitang', 'dubu',
    ],
  },
  {
    category: 'Thai',
    tags: [
      'thai', 'thai contemporary', 'southern thai', 'northern thai',
      'thai-chinese', 'thai restaurant', 'thai and vietnamese', 'isan',
      'pa thong ko',
    ],
  },
  {
    category: 'Indian',
    tags: [
      'indian', 'south indian', 'indian vegetarian', 'indian restaurant',
      'sri lankan', 'bangladeshi', 'pakistani', 'nepali',
    ],
  },
  {
    category: 'Southeast Asian',
    tags: [
      'vietnamese', 'vietnamese contemporary', 'filipino', 'malaysian',
      'indonesian', 'singaporean', 'taiwanese', 'taiwanese contemporary',
      'laotian', 'lao', 'cambodian', 'burmese', 'south east asian',
      'pan asian', 'asian', 'asian fusion', 'asian contemporary',
      'asian influences', 'asian and western',
      'vietnamese restaurant', 'filipino restaurant', 'indonesian restaurant',
      'peranakan', 'balinese', 'central asian',
    ],
  },
  {
    category: 'Mexican',
    tags: [
      'mexican', 'tex-mex', 'new mexican cuisine', 'mexican restaurant',
      'tacos', 'taco restaurant', 'salvadoran', 'honduran', 'guatemalan',
      'central american',
    ],
  },
  {
    category: 'Mediterranean',
    tags: [
      'mediterranean', 'mediterranean cuisine', 'greek', 'spanish',
      'tapas', 'catalan', 'basque', 'turkish', 'tapas/small plates',
      'tapas bars', 'spanish contemporary', 'andalusian', 'asturian',
      'castilian', 'galician', 'iberian', 'greek restaurant',
      'mediterranean restaurant', 'turkish restaurant', 'spanish restaurant',
      'cypriot', 'maltese',
    ],
  },
  {
    category: 'Middle Eastern',
    tags: [
      'middle eastern', 'lebanese', 'persian', 'persian/iranian',
      'israeli', 'moroccan', 'arabic', 'turkish', 'halal', 'saudi cuisine',
      'emirati cuisine', 'persian restaurant', 'north african',
      'egyptian', 'armenian',
    ],
  },
  {
    category: 'Latin American',
    tags: [
      'latin american', 'peruvian', 'brazilian', 'argentinian', 'argentine',
      'caribbean', 'cuban', 'south american', 'colombian', 'venezuelan',
      'puerto rican', 'dominican', 'haitian', 'jamaican', 'trinidadian',
      'chilean', 'latin american restaurant', 'cuban restaurant',
      'carribean restaurant',
    ],
  },
  {
    category: 'Seafood',
    tags: [
      'seafood', 'fish restaurant', 'fish & chips', 'fish and chips',
      'seafood markets', 'shellfish specialities', 'crab specialities',
      'oyster specialities', 'meats and seafood',
    ],
  },
  {
    category: 'Southern & Soul',
    tags: [
      'southern', 'southern / cajun', 'soul food', 'cajun/creole',
      'creole', 'cajun', 'creole restaurant', 'country cooking',
    ],
  },
  {
    category: 'African',
    tags: [
      'african', 'ethiopian', 'north african', 'senegalese', 'south african',
      'moroccan', 'african restaurant', 'egyptian', 'haitian',
    ],
  },
  {
    category: 'European',
    tags: [
      'european', 'british', 'modern british', 'traditional british',
      'british contemporary', 'creative british', 'english',
      'scandinavian', 'nordic', 'danish', 'swedish', 'norwegian', 'finnish',
      'german', 'austrian', 'alpine', 'bavarian', 'swiss', 'belgian',
      'flemish', 'czech', 'polish', 'hungarian', 'croatian', 'balkan',
      'eastern european', 'russian', 'ukrainian', 'armenian',
      'scottish', 'irish', 'corsican', 'basque', 'breton',
      'regional european', 'modern european', 'european contemporary',
      'german restaurant', 'english restaurant',
    ],
  },
  {
    category: 'American',
    tags: [
      'new american', 'american', 'californian', 'american contemporary',
      'north american', 'american restaurant',
    ],
  },
  {
    category: 'Farm to Table',
    tags: [
      'farm to table', 'seasonal cuisine', 'organic', 'regional cuisine',
      'home cooking', 'classic cuisine', 'traditional cuisine',
    ],
  },
  {
    category: 'Vegetarian / Vegan',
    tags: [
      'vegetarian', 'vegan', 'vegetarian / vegan', 'vegetarian/vegan',
      'indian vegetarian', 'live/raw food',
    ],
  },
  {
    category: 'Bakery & Café',
    tags: [
      'bakery', 'bakeries', 'bakery', 'desserts', 'coffee & tea',
      'coffee', 'coffee shop', 'café', 'cafes', 'patisserie/cake shop',
      'breakfast & brunch', 'breakfast restaurant', 'brunch restaurant',
      'pancakes', 'waffles', 'macarons', 'cupcakes', 'custom cakes',
      'ice cream & frozen yogurt', 'ice cream store', 'gelato', 'shaved ice',
      'confectionary', 'candy stores', 'chocolatiers & shops', 'bagels',
      'poke', 'acai bowls', 'bubble tea', 'juice bars & smoothies',
      'tea rooms', 'deli', 'delis', 'sandwiches',
    ],
  },
  {
    category: 'Wine & Spirits',
    tags: [
      'wine & spirits', 'wineries', 'wine bars', 'wine bar',
      'distilleries', 'distillery', 'beer, wine & spirits',
      'wine tasting room', 'wine tasting classes', 'liquor store',
      'beer bar', 'brewery', 'breweries', 'biergarten', 'brewpubs',
    ],
  },
  {
    category: 'Bars & Cocktails',
    tags: [
      'bars & cocktails', 'cocktail bars', 'bar', 'bars', 'cocktail bar',
      'nightlife', 'lounges', 'pubs', 'pub', 'gastropub', 'gastropubs',
      'sports bars', 'whiskey bars', 'irish pub', 'beer bar',
    ],
  },
  {
    category: 'Contemporary',
    tags: [
      'modern cuisine', 'contemporary', 'creative', 'innovative', 'fusion',
      'international', 'world cuisine', 'regional cuisine', 'classic cuisine',
      'traditional cuisine', 'country cooking', 'asian influences',
      'asian contemporary', 'modern british', 'modern french',
      'creative french', 'creative british', 'italian contemporary',
      'french contemporary', 'japanese contemporary', 'thai contemporary',
      'taiwanese contemporary', 'korean contemporary', 'chinese contemporary',
      'spanish contemporary', 'british contemporary', 'european contemporary',
      'modern european', 'australian contemporary', 'vietnamese contemporary',
      'small eats', 'street food', 'sharing', 'pop-up restaurants',
      'pop-up restaurants', 'supper clubs',
    ],
  },
];

// Build a fast lowercase-lookup map: raw tag → canonical category
const TAG_MAP = new Map();
for (const { category, tags } of TAXONOMY) {
  for (const tag of tags) {
    const key = tag.toLowerCase().trim();
    if (!TAG_MAP.has(key)) TAG_MAP.set(key, category); // first-listed category wins
  }
}

// ── Junk tags to ignore ───────────────────────────────────────────────────────
const JUNK = new Set([
  'venues & event spaces', 'caterers', 'hotels', 'bed & breakfast',
  'entertainment', 'casino', 'casinos', 'nightlife', 'music venues',
  'jazz & blues', 'art galleries', 'toy stores', 'florists', 'spa', 'massage',
  'community service/non-profit', 'community gardens', 'cooking schools',
  'cooking classes', 'tasting classes', 'adult education', 'specialty schools',
  'kitchen supplies', 'farmers market', 'food delivery services', 'dietitians',
  'personal chefs', 'pop-up shops', 'farms', 'organic stores', 'health markets',
  'vitamins & supplements', 'international grocery', 'grocery', 'supermarket',
  'convenience stores', 'imported food', 'cheese', 'butcher', 'meat shops',
  'food stands', 'food trucks', 'food court', 'caterers', 'buffets',
  'buffet restaurant', 'cafeteria', 'fast food', 'fast food restaurant',
  'diners', 'diner', 'restaurants', 'tours', 'game meat', 'csa',
  'party & event planning', 'guest houses', 'pop-up restaurants',
  'tailor', 'veterinary',
]);

// ── Category resolver ─────────────────────────────────────────────────────────
function resolveCategory(entry) {
  // Texas Monthly: always BBQ
  if (entry.source === 'texasmonthly') return 'BBQ & Smokehouse';

  // Tabelog: use cuisine field directly if cuisineTags is empty
  if (entry.source === 'tabelog' && !entry.cuisineTags?.length && entry.cuisine) {
    const raw = entry.cuisine.toLowerCase().trim();
    for (const { category, tags: catTags } of TAXONOMY) {
      if (catTags.some(t => raw.includes(t.toLowerCase()))) return category;
    }
  }

  const tags = (entry.cuisineTags || []).map(t => t.toLowerCase().trim());

  // Walk TAXONOMY in priority order — return first category that has a matching tag
  for (const { category, tags: catTags } of TAXONOMY) {
    for (const tag of tags) {
      if (JUNK.has(tag)) continue;
      if (TAG_MAP.get(tag) === category) return category;
    }
  }

  return null; // no match — needs Google enrichment
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const awards = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));
  console.log(`Processing ${awards.length} records…`);

  let assigned = 0, unchanged = 0;
  const dist = {};

  const updated = awards.map(a => {
    const category = resolveCategory(a);
    if (category) {
      assigned++;
      dist[category] = (dist[category] || 0) + 1;
    } else {
      unchanged++;
    }
    return category !== undefined ? { ...a, cuisineCategory: category } : a;
  });

  console.log(`\nAssigned category:   ${assigned}`);
  console.log(`No category (null):  ${unchanged}`);

  console.log('\nDistribution:');
  Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, n]) => console.log(`  ${n.toString().padStart(6)}  ${cat}`));

  // How many unique restaurants (by key) still have null?
  const nullRestaurants = new Set(
    updated
      .filter(a => !a.cuisineCategory)
      .filter(a => a.type === 'organization' || a.source === 'michelin' || a.source === 'texasmonthly')
      .map(a => `${a.restaurant || a.name}|${a.city}`)
  );
  console.log(`\nUnique org/michelin restaurants still null: ${nullRestaurants.size}`);

  if (DRY_RUN) {
    console.log('\nDry run — no files written.');
    return;
  }

  fs.writeFileSync(AWARDS_PATH, JSON.stringify(updated));
  console.log('\nWrote awards.json');

  // Regenerate chunk files
  const { execSync } = require('child_process');
  execSync('node split-data.js', { stdio: 'inherit' });
}

main();
