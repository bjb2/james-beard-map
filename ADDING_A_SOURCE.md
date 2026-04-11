# Adding a New Award Source to Delectable

Reference for integrating a new restaurant award/recognition source (e.g. Gault & Millau, La Liste, Zagat, Yelp Top 100).

---

## 1. Decide on a source key

Pick a short lowercase identifier. Used in `source` field and throughout the codebase.

| Source | Key |
|---|---|
| James Beard Foundation | `jbf` |
| Michelin Guide | `michelin` |
| Texas Monthly BBQ | `texasmonthly` |
| Tabelog Award | `tabelog` |
| Your new source | `yoursource` |

---

## 2. Acquire the data

**Option A — Existing GitHub dataset (preferred, like Michelin)**
- Find a maintained CSV/JSON repo (e.g. `ngshiheng/michelin-my-maps`)
- Write `fetch-[source].js` using `axios` to download and parse it
- No rate limiting needed

**Option B — Scrape the awards page (like Tabelog)**
- Use `playwright-chromium` (already installed)
- Check pagination: try `?page=2`, `?page=3` manually before writing code
- Check for XHR API calls (open DevTools > Network > XHR while loading the page)
- Use `page.goto(url, { waitUntil: 'networkidle' })` then DOM extraction

**Common pitfalls:**
- Pages often show only ~50-100 results by default — always check for pagination
- Infinite scroll and `?page=N` look identical from outside; test manually first
- Restaurant detail pages usually have `<script type="application/ld+json">` with `@type: Restaurant` containing `geo.latitude` / `geo.longitude` — use this instead of Google API

---

## 3. Output shape: `data/[source].json`

Every fetch script must produce an array of objects with at minimum:

```json
{
  "restaurant": "Name in English",
  "city": "City or Ward",
  "country": "Country name (null if USA)",
  "address": "Full address or null",
  "lat": 35.659,
  "lng": 139.727,
  "[source]Award": "Gold",        ← tier label specific to this source
  "[source]Url": "https://...",   ← link back to source page
  "cuisine": "Sushi, Japanese",
  "cuisineTags": ["Sushi", "Japanese"],
  "price": "¥¥¥",
  "website": "https://...",
  "phone": "+81-3-...",
  "photo_url": "https://..."
}
```

Run `node fetch-[source].js --listing-only` first to verify the listing shape before doing detail-page scraping.

---

## 4. Files to create / modify

### Create: `fetch-[source].js`
Copy `fetch-tabelog.js` or `fetch-michelin.js` as a template.
- Phase 1: collect all award entries (name, tier, city, source URL)
- Phase 2: enrich each entry from its detail page (coords from JSON-LD, photo, phone, website)
- Cache detail pages to `data/[source]-cache.json` — re-runnable
- Output to `data/[source].json`

### Create: `merge-[source].js`
Copy `merge-tabelog.js` as a template.
- Strip previously merged records (`source !== '[source]'`) for idempotency
- Match existing JBF/Michelin records by name + city (word-overlap)
- Annotate matches with `[source]Award`, `[source]Url`
- Append unmatched as new records with `source: '[source]'`

### Modify: `split-data.js`
Add a new partition `pN`:
```js
const p6 = awards.filter(r => r.source === '[source]');
// add to files array:
['data/awards-p6.json', p6, '[Source] Award'],
```
Also update `p2` filter to exclude the new source:
```js
const p2 = awards.filter(r => r.source !== 'michelin' && r.source !== 'tabelog' && r.source !== '[source]');
```

### Modify: `normalize-cuisine.js`
- Add any new cuisine tag strings to the relevant category in `TAXONOMY`
- Add a source-specific shortcut if the source always maps to one category (like `texasmonthly` → BBQ):
```js
if (entry.source === '[source]') return 'CategoryName';
```

### Modify: `scripts/seed-restaurants.js`
Add an award row builder branch:
```js
} else if (entry.source === '[source]') {
  awardRows.push({
    restaurant_key: key,
    source:         '[source]',
    award_type:     entry.[source]Award || 'Award',
    award_detail:   '[Source] Award 2025',
    year:           2025,
  });
}
```
Add any new URL field to `buildRestaurant`:
```js
[source]_url: entry.[source]Url || null,
```
Add the merge preference:
```js
if (!existing.[source]_url && update.[source]_url) existing.[source]_url = update.[source]_url;
```

### Create: `supabase/migrations/0NN_add_[source].sql`
```sql
alter table public.restaurants
  add column if not exists [source]_url text;

-- Drop and recreate restaurants_with_summary view to add new award
-- to priority ranking (copy from 012_add_tabelog.sql and extend the CASE).
```

### Modify: `index.html`
Touch 6 places:

**1. CSS badge** (near `.badge-michelin`):
```css
.badge-[source] { background: #HEX; color: #fff; }
```

**2. Filter dropdown** (inside `#filter-source`):
```html
<option value="[source]">[Source] Only</option>
```

**3. `applyFilters()`** — add source constant and filter clause:
```js
const is[Source] = a.source === '[source]';
if (source === '[source]' && !is[Source]) return false;
// Add is[Source] to the JBF-specific filter guard:
if (!isMichelin && !isTM && !isTabelog && !is[Source]) {
```

**4. `buildMarkers()`** — add `has[Source]` detection and marker assignment:
```js
const has[Source] = loc.awards.some(a => a.source === '[source]');
// In the if/else chain, before the final Michelin else:
} else if (has[Source]) {
  michelinTier = /* best tier logic */;
  bestStatus = '[source]';
}
```

**5. `markerIcon()`** — add a new marker shape/colour block:
```js
if (status === '[source]') {
  // return L.divIcon(...) with distinctive shape/colour
}
```

**6. `buildPopup()`** — add `is[Source]Only` popup + badge function + inject into JBF mixed popup:
```js
function [source]Badge(tier) { ... }

// In buildPopup:
const is[Source]Only = awards.every(a => a.source === '[source]');
if (is[Source]Only) { /* dedicated popup */ }

// In JBF popup setup:
const [source]Record = awards.find(a => a.source === '[source]');
const [source]Award  = firstMeta.[source]Award || [source]Record?.[source]Award || null;
```

**7. Sidebar result items** — add badge class and text:
```js
const is[Source] = a.source === '[source]';
const badgeClass = ... : is[Source] ? 'badge-[source]' : ...
const badgeText  = ... : is[Source] ? `[Source] ${a.[source]Award}` : ...
```

**8. Data chunk** (in `loadData`):
```js
{ file: './data/awards-p6.json', label: '[Source] Award', optional: true },
```
`optional: true` means the app loads fine before the data exists.

### Modify: `package.json`
```json
"fetch:[source]": "node fetch-[source].js",
"fetch:[source]:listing": "node fetch-[source].js --listing-only",
"merge:[source]": "node merge-[source].js && node normalize-cuisine.js && node split-data.js"
```

---

## 5. Run order

```bash
# 1. Test listing scrape first (fast)
node fetch-[source].js --listing-only
# → inspect data/[source]-raw.json, verify count and shape

# 2. Full scrape with detail pages
node fetch-[source].js
# → inspect data/[source].json

# 3. Merge, normalize cuisine, re-split chunks
npm run merge:[source]
# → data/awards.json and data/awards-pN.json updated

# 4. Apply DB migration (Supabase dashboard or CLI)
# → run 0NN_add_[source].sql

# 5. Re-seed the database
node scripts/seed-restaurants.js <service_role_key>
```

---

## 6. Marker colour / shape conventions

| Source | Shape | Colour |
|---|---|---|
| Michelin ★★★ | Diamond (large) | `#E4002B` red |
| Michelin ★★ | Diamond (medium) | `#E4002B` red |
| Michelin ★ / Bib | Diamond (small) | `#E4002B` / `#E8611A` |
| JBF Winner | Circle (large) | `#FEA219` orange |
| JBF Semifinalist | Circle (medium) | `#c0c0c0` silver |
| JBF Nominee | Circle (small) | `#cd7f32` bronze |
| Texas Monthly | Square | `#1a6fa8` blue |
| Tabelog Gold | Star (large) | `#D4AF37` gold |
| Tabelog Silver | Star (medium) | `#9BA7B4` silver |
| Tabelog Bronze | Star (small) | `#C47A35` bronze |
| *Next source* | Pentagon / other | Pick a distinct colour |

Use `clip-path` polygons for non-circle/square shapes in `L.divIcon` HTML.

---

## 7. Checklist

- [ ] `fetch-[source].js` created, outputs correct shape
- [ ] `data/[source].json` looks good (coords, names, tiers)
- [ ] `merge-[source].js` created, idempotent
- [ ] `split-data.js` updated (new pN, p2 filter updated)
- [ ] `normalize-cuisine.js` updated (new tags if needed)
- [ ] `scripts/seed-restaurants.js` updated (award rows + URL field)
- [ ] `supabase/migrations/0NN_add_[source].sql` created and applied
- [ ] `index.html` updated (CSS, filter, applyFilters, buildMarkers, markerIcon, buildPopup, sidebar, loadData chunk)
- [ ] `package.json` scripts added
- [ ] Pipeline run end-to-end, map shows new pins
