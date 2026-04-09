# James Beard Awards Map

An interactive map of James Beard Foundation Restaurant & Chef Award nominees and winners from 1991 to present — 10,800+ awards across 4,900+ restaurants.

**[View the map →](https://bjb2.github.io/james-beard-map/)**

![Awards](https://img.shields.io/badge/awards-10%2C800%2B-FEA219?style=flat-square) ![Restaurants](https://img.shields.io/badge/restaurants-4%2C900%2B-FEA219?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-white?style=flat-square)

---

## Features

- **Interactive map** with clustered pins for every nominated and winning restaurant
- **Filter** by year, state, award category, award status (Winner / Semifinalist / Nominee), and cuisine type
- **Search** by chef or restaurant name
- **Find awards near me** — geolocation with adjustable radius
- **Rich popups** — Yelp photo, star rating, price tier, menu link, Yelp page, Google Maps, and website where available
- **Sidebar results list** — click any result to fly to its location and open the popup
- Color-coded pins: gold for Winners, silver for Semifinalists, bronze for Nominees

## Data Sources

| Data | Source |
|------|--------|
| Award records | [James Beard Foundation](https://www.jamesbeard.org/awards/search-past-awards) — Restaurant & Chef category, 1991–present |
| City-level geocoding | [OpenStreetMap Nominatim](https://nominatim.org/) |
| Restaurant-level geocoding | [Photon](https://photon.komoot.io/) (OSM-based POI search) |
| Restaurant enrichment (websites, descriptions) | DuckDuckGo Instant Answer + Wikipedia APIs |
| Cuisine categories | [Yelp Fusion API](https://docs.developer.yelp.com/docs/fusion-intro) |
| Ratings, pricing, photos, menus | [Yelp Fusion API](https://docs.developer.yelp.com/docs/fusion-intro) — targeted at Winners and 2023+ nominees |

Award data is pre-built and served as a static JSON file — no live API calls required at runtime.

## Local Development

```bash
npm install
node server.js      # serves at http://localhost:3000
```

### Rebuilding data from scratch

```bash
node fetch-data.js          # fetch awards from JBF → data/raw-awards.json
node geocode.js             # geocode all locations → data/awards.json
node enrich.js              # enrich with websites/images → data/awards.json
node yelp-enrich.js         # Yelp cuisine tags + coordinates for unresolved restaurants
node clean-cuisine.js       # strip non-food categories from cuisine-cache.json
node yelp-details.js        # Yelp ratings/photos/menus for Winners + 2023+ nominees
```

Geocoding caches (`data/city-cache.json`, `data/restaurant-cache.json`, etc.) are gitignored — they're large and can be regenerated. API keys are stored in `.key.txt` (also gitignored).

## Tech Stack

- [Leaflet.js](https://leafletjs.com/) + [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) — map rendering and pin clustering
- [Esri World Dark Gray](https://www.esri.com/) — map tiles
- OpenStreetMap [Nominatim](https://nominatim.org/) + [Photon](https://photon.komoot.io/) — geocoding
- [Yelp Fusion API](https://docs.developer.yelp.com/docs/fusion-intro) — cuisine categories, ratings, photos, and menus
- Node.js / Express — local development server and data pipeline

## License

MIT — see [LICENSE](LICENSE)

Award data © James Beard Foundation. This project is not affiliated with or endorsed by the James Beard Foundation.
