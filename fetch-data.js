/**
 * Fetch all James Beard Restaurant & Chef awards from Algolia.
 * Uses year-based pagination to work around Algolia's 1000-result limit per query.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ALGOLIA_APP_ID = 'KG14YQNXY6';
const ALGOLIA_API_KEY = '50409b5e385fb9d7f0d4dea2f5a83e04';
const INDEX_NAME = 'JBFORG_Awards';
const BASE_URL = `https://${ALGOLIA_APP_ID}-dsn.algolia.net`;

async function searchAlgolia(params) {
  const res = await axios.post(
    `${BASE_URL}/1/indexes/*/queries`,
    { requests: [{ indexName: INDEX_NAME, params }] },
    {
      headers: {
        'x-algolia-api-key': ALGOLIA_API_KEY,
        'x-algolia-application-id': ALGOLIA_APP_ID,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.results[0];
}

async function main() {
  console.log('Fetching James Beard Restaurant & Chef awards from Algolia...\n');

  // First, get all available years
  const facetResult = await searchAlgolia(
    'facets=year&facetFilters=parentCategory%3ARestaurant%20%26%20Chef&hitsPerPage=0'
  );
  const yearFacets = facetResult.facets?.year || {};
  const years = Object.keys(yearFacets).sort((a, b) => parseInt(b) - parseInt(a));

  console.log(`Found ${years.length} years: ${years.join(', ')}`);
  console.log(`Total records: ${Object.values(yearFacets).reduce((a, b) => a + b, 0)}\n`);

  const allAwards = [];
  const seenIds = new Set();

  for (const year of years) {
    const count = yearFacets[year];
    process.stdout.write(`Fetching ${year} (${count} records)...`);

    let page = 0;
    let totalPages = 1;
    let yearRecords = 0;

    while (page < totalPages) {
      const params = new URLSearchParams({
        facetFilters: JSON.stringify(['parentCategory:Restaurant & Chef', `year:${year}`]),
        hitsPerPage: '1000',
        page: String(page),
        attributesToRetrieve: 'name,restaurant,city,state,category,parentCategory,status,year,type,summary,nomination',
        attributesToHighlight: ''
      }).toString();

      const result = await searchAlgolia(params);
      totalPages = result.nbPages;

      for (const hit of result.hits) {
        if (!seenIds.has(hit.objectID)) {
          seenIds.add(hit.objectID);
          allAwards.push({
            id: hit.objectID,
            name: hit.name || null,
            restaurant: hit.restaurant || null,
            city: hit.city || null,
            state: hit.state || null,
            category: hit.category || null,
            status: hit.status || null,
            year: hit.year || null,
            type: hit.type || null,
            summary: hit.summary || null
          });
          yearRecords++;
        }
      }
      page++;

      // Small delay to be polite
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(` got ${yearRecords}`);
  }

  console.log(`\nTotal fetched: ${allAwards.length} awards`);

  // Show location coverage stats
  const withCity = allAwards.filter(a => a.city && a.state).length;
  const withState = allAwards.filter(a => a.state && !a.city).length;
  const noLocation = allAwards.filter(a => !a.city && !a.state).length;
  console.log(`With city+state: ${withCity}`);
  console.log(`State only: ${withState}`);
  console.log(`No location: ${noLocation}`);

  // Show unique cities
  const cities = new Set(allAwards.filter(a => a.city).map(a => `${a.city}, ${a.state}`));
  console.log(`Unique city/state combos: ${cities.size}`);

  // Sample of records with location
  console.log('\nSample records with location:');
  allAwards.filter(a => a.city && a.state).slice(0, 5).forEach(a => {
    console.log(`  ${a.name} | ${a.restaurant} | ${a.city}, ${a.state} | ${a.category} | ${a.status} | ${a.year}`);
  });

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'raw-awards.json'), JSON.stringify(allAwards, null, 2));
  console.log('\nSaved to data/raw-awards.json');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
