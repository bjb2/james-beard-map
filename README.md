# Delectable

An interactive map of restaurant awards from the James Beard Foundation, Michelin Guide, and Texas Monthly — 29,900+ award records across 24,000+ unique restaurants.

**[View the map →](https://www.delectable.guide)**

![Awards](https://img.shields.io/badge/awards-29%2C900%2B-FEA219?style=flat-square) ![Restaurants](https://img.shields.io/badge/restaurants-24%2C000%2B-FEA219?style=flat-square) ![License](https://img.shields.io/badge/license-Apache%202.0-white?style=flat-square)

---

## Features

- **Interactive map** with clustered pins for every nominated and winning restaurant
- **Filter** by year, award category, award status (Winner / Semifinalist / Nominee), cuisine type, source (JBF / Michelin / Texas Monthly), and Michelin tier
- **Search** by chef, restaurant name, or city
- **Find awards near me** — browser geolocation or ZIP code lookup with adjustable radius
- **Rich popups** — photo, rating, price tier, menu link, Yelp, Google Maps, Michelin, and website where available
- **Community features** — sign in with Google to track visited restaurants, build lists, and add personal notes
- **List sharing** — public shareable lists with per-restaurant notes and creator attribution
- **User profiles** — visited history, Want to Go list, and custom lists with stats
- Color-coded pins: gold for Winners, silver for Semifinalists, bronze for Nominees/Bib Gourmand

## Data Sources

| Data | Source |
|------|--------|
| JBF award records | [James Beard Foundation](https://www.jamesbeard.org/awards/search-past-awards) — Restaurant & Chef, 1991–present |
| Michelin awards | [Michelin Guide](https://guide.michelin.com/) — Stars, Bib Gourmand, Selected |
| Texas Monthly | [Texas Monthly Top 50 BBQ](https://www.texasmonthly.com/bbq/) |
| Geocoding | [Photon](https://photon.komoot.io/) (OSM-based POI search) |
| Photos, addresses, websites, business status | [Google Places API](https://developers.google.com/maps/documentation/places/web-service) |
| Cuisine categories, ratings, pricing, menus | [Yelp Fusion API](https://docs.developer.yelp.com/docs/fusion-intro) |
| Community data (lists, visits, notes) | [Supabase](https://supabase.com/) (Postgres + Auth) |

Award data is pre-built and served as static JSON chunks — no live API calls required at runtime for map data.

## Local Development

```bash
npm install
node server.js      # serves at http://localhost:3000
```

## Tech Stack

- [Leaflet.js](https://leafletjs.com/) + [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) — map rendering and pin clustering
- [Esri World Dark Gray](https://www.esri.com/) — map tiles
- [Supabase](https://supabase.com/) — Postgres database, auth, and community features
- [Google Places API](https://developers.google.com/maps/documentation/places/web-service) — restaurant enrichment (photos, addresses, websites)
- [Yelp Fusion API](https://docs.developer.yelp.com/docs/fusion-intro) — cuisine categories, ratings, photos, and menus
- [Photon](https://photon.komoot.io/) — geocoding
- [Vercel](https://vercel.com/) — hosting and deployment
- Node.js — data pipeline scripts

## Data Pipeline

The enrichment pipeline is run offline to build `data/awards.json` and the split chunk files. It is not needed for normal development.

```bash
node fetch-data.js          # fetch JBF awards → data/raw-awards.json
node fetch-michelin.js      # fetch Michelin data → data/michelin.json
node merge-michelin.js      # merge Michelin into awards dataset
node merge-texasmonthly.js  # merge Texas Monthly into awards dataset
node geocode.js             # geocode all locations
node enrich-google.js       # Google Places enrichment for Michelin restaurants
node enrich-google-jbf.js   # Google Places enrichment for JBF restaurants
node enrich-types.js        # cuisine type classification via Google Places
node yelp-enrich.js         # Yelp cuisine tags + coordinates
node yelp-details.js        # Yelp ratings/photos/menus
node normalize-cuisine.js   # normalize cuisine category labels
node split-data.js          # split awards.json into priority chunks for loading
node scripts/seed-restaurants.js  # seed Supabase restaurants + awards tables
```

Cache files (`data/*-cache.json`) are gitignored — they're large and can be regenerated. API keys are stored in `.key.txt` (also gitignored). See `docs/google-api-cost-analysis.md` before running Google enrichment.

## Database

Supabase migrations are in `supabase/migrations/` and should be run in order. The schema covers: `restaurants`, `restaurant_awards`, `profiles`, `visits`, `lists`, `list_items`, `dish_notes`, and `tags`.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE)

Any redistribution or derivative work must retain the NOTICE file with attribution to the original author and data sources.

Award data © James Beard Foundation. Michelin Guide data © Michelin. This project is not affiliated with or endorsed by the James Beard Foundation or Michelin.
