# James Beard Awards Map

An interactive map of James Beard Foundation Restaurant & Chef Award nominees and winners from 1991 to present — 10,800+ awards, 6,100+ precisely geocoded restaurant locations across the US.

**[View the map →](https://bryanbeard.github.io/james-beard-map/)**

![James Beard Awards Map](https://img.shields.io/badge/awards-10%2C800%2B-FEA219?style=flat-square) ![Locations](https://img.shields.io/badge/locations-6%2C100%2B-FEA219?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-white?style=flat-square)

---

## Features

- **Interactive map** with clustered pins for every nominated and winning restaurant
- **Filter** by year, state, category, and award status (Winner / Semifinalist / Nominee)
- **Search** by chef or restaurant name
- **Find awards near me** — geolocation with adjustable radius
- **Rich popups** with Google Maps links, website links, and descriptions where available
- Color-coded pins: gold for Winners, silver for Semifinalists, bronze for Nominees

## Data

Award data is sourced from the [James Beard Foundation](https://www.jamesbeard.org/awards/search-past-awards) and covers the **Restaurant & Chef** category only. Geocoding uses OpenStreetMap (Nominatim + Photon). Enrichment data (websites, descriptions) is sourced from DuckDuckGo Instant Answer and Wikipedia APIs.

All data is pre-built and served as a static JSON file — no server required.

## Local Development

```bash
npm install
node server.js      # serves at http://localhost:3000
```

To rebuild the data from scratch:

```bash
node fetch-data.js  # fetch awards from JBF (saves to data/raw-awards.json)
node geocode.js     # geocode all locations (saves to data/awards.json)
node enrich.js      # enrich with websites/images (updates data/awards.json)
```

## Tech Stack

- [Leaflet.js](https://leafletjs.com/) + [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) — map rendering
- [Esri World Dark Gray](https://www.esri.com/) — map tiles
- OpenStreetMap [Nominatim](https://nominatim.org/) + [Photon](https://photon.komoot.io/) — geocoding
- Node.js / Express — local development server and data pipeline

## License

MIT — see [LICENSE](LICENSE)

Award data © James Beard Foundation. This project is not affiliated with or endorsed by the James Beard Foundation.
