# Google Places API — Cost Analysis & Future Strategy

**Total spent to date: ~$275**
**Decision: No further Google API work until a unified enrichment script is written.**

---

## What We Were Trying to Do

For each restaurant in the dataset, we wanted:
- A photo
- A verified website URL
- Business status (open/closed)
- Formatted address
- Cuisine type classification (`types`, `primaryType`)

---

## What Actually Happened

Three separate enrichment scripts ran independently, each making their own Google API calls:

### `enrich-google.js` — Michelin restaurants
- **API**: Places API v1 Text Search (`places:searchText`)
- **Field mask**: `places.id, places.displayName, places.businessStatus, places.websiteUri, places.photos, places.formattedAddress`
- **Volume**: ~3,829 entries
- **Flow**: 1 Text Search → if photo reference returned, 1 Photo Media fetch
- **Cache**: `data/google-cache.json`

### `enrich-google-jbf.js` — JBF restaurants
- Identical logic to above, just pointed at JBF data
- **Volume**: ~3,864 entries
- **Cache**: `data/google-jbf-cache.json`

### `enrich-texasmonthly.js` — Texas Monthly restaurants
- Same pattern
- **Volume**: ~118 entries
- **Cache**: `data/google-tm-cache.json`

### `enrich-types.js` — Cuisine type classification (separate pass)
- **Problem**: `types` and `primaryType` were not included in the original field masks above, so a fourth script was needed just to get cuisine types
- **Flow**:
  - Phase 1: Place Details (`/v1/places/{placeId}`) for restaurants already in cache — **846 calls**
  - Phase 2: Text Search again for any uncached restaurants
- **Field mask**: `types, primaryType` only
- **Cache**: `data/google-types-cache.json`

---

## Cost Breakdown (approximate)

| Call type | Volume | Rate | Cost |
|---|---|---|---|
| Text Search | ~7,811 | $17/1,000 | ~$133 |
| Photo Media | ~5,820 | $7/1,000 | ~$41 |
| Place Details | ~846 | $17/1,000 | ~$14 |
| Text Search (enrich-types re-run) | ~unknown | $17/1,000 | ~$30–50 |
| Misc / overruns | — | — | ~$30 |
| **Total** | | | **~$275** |

---

## The Core Inefficiencies

1. **One script per data source** — A restaurant in both Michelin and JBF data was hit with two separate Text Search calls. There are ~24K unique restaurants but ~29K award entries; duplicates were charged twice.

2. **Cuisine types were an afterthought** — Because `types`/`primaryType` were missing from the original field masks, `enrich-types.js` had to make a full second pass (Place Details for cached entries, Text Search again for uncached ones).

3. **Photo Media is a separate billable call** — Each photo reference from Text Search required a second API call to resolve to an actual URL. This doubled the call count for any restaurant where a photo was needed.

---

## Current State of Caches

All fetched data is persisted in `data/`. Do not delete these files.

| File | Entries | Contains |
|---|---|---|
| `data/google-cache.json` | 3,829 | Michelin: placeId, website, address, photoUrl |
| `data/google-jbf-cache.json` | 3,864 | JBF: placeId, website, address, photoUrl |
| `data/google-tm-cache.json` | 118 | Texas Monthly: placeId, website, address, photoUrl |
| `data/google-types-cache.json` | 846 | placeId → types, primaryType |

Of ~24K unique restaurants, ~5,820 have a Google photo and ~7,800 have a placeId cached.

---

## The Right Approach for Future Enrichment

**One script, one Text Search call per unique restaurant, all fields in one field mask.**

### Unified field mask
```
places.id,
places.displayName,
places.businessStatus,
places.websiteUri,
places.photos,
places.formattedAddress,
places.types,
places.primaryType
```

This gets everything in a single Text Search call — no separate Place Details pass needed for cuisine types.

### Script logic (when written)
1. Deduplicate `awards.json` by restaurant key (`name|city|state`) before making any calls
2. Skip any restaurant already in any existing cache (check all four cache files)
3. Text Search once per unique restaurant with the full field mask above
4. If `photos[0]` is returned, fetch Photo Media immediately in the same run
5. Write results to a single unified cache file

### Worst-case cost from scratch (24K unique restaurants)
| Call type | Volume | Rate | Cost |
|---|---|---|---|
| Text Search | 24,000 | $17/1,000 | ~$408 |
| Photo Media | ~16,000 (est. uncached) | $7/1,000 | ~$112 |
| **Total** | | | **~$520** |

### Incremental cost (resume from current state, ~16K uncached)
| Call type | Volume | Rate | Cost |
|---|---|---|---|
| Text Search | ~16,200 | $17/1,000 | ~$275 |
| Photo Media | ~10,000 (est.) | $7/1,000 | ~$70 |
| **Total** | | | **~$345** |

---

## Before Running Any Future Google API Work

- [ ] Write the unified single-pass script (dedup by key, full field mask, single cache)
- [ ] Set a Google Cloud billing alert at $50 increments
- [ ] Run a dry-run that logs what would be fetched without making calls
- [ ] Verify cache hit logic is working before processing the full dataset
