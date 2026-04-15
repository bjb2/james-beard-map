try { require('dotenv').config(); } catch(e) {}

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = 3000;
const DATA = path.join(__dirname, 'data');
const AWARDS_FILE = path.join(DATA, 'awards.json');

// In-memory cache for admin search (invalidated on file change)
let awardsCache = null;
function readAwards() {
  if (!awardsCache) awardsCache = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  return awardsCache;
}

app.use(compression());
app.use((req, res, next) => { console.log('[REQ]', req.method, req.url); next(); });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/profile.html', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/list', (req, res) => res.sendFile(path.join(__dirname, 'list.html')));
app.get('/list.html', (req, res) => res.sendFile(path.join(__dirname, 'list.html')));

// Block /admin from non-localhost before the static file handler can serve it
function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).send('Forbidden');
}
app.use(['/admin', '/admin.html', '/api/admin'], localOnly);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.use('/data', express.static(path.join(__dirname, 'data')));
app.use(express.static(__dirname));

// Awards data
app.get('/api/awards', (req, res) => {
  if (!fs.existsSync(AWARDS_FILE)) {
    return res.status(503).json({ error: 'Geocoding not yet complete.' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(AWARDS_FILE);
});

// Status
app.get('/api/status', (req, res) => {
  function countCache(file) {
    try { return Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'))).length; }
    catch { return 0; }
  }

  const cityCount = countCache('city-cache.json');
  const restCount = countCache('restaurant-cache.json');
  const geocodedCount = fs.existsSync(AWARDS_FILE)
    ? JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8')).length : 0;

  const CITY_TOTAL = 973, REST_TOTAL = 4957;
  let phase, phaseProgress;
  if (cityCount < CITY_TOTAL) { phase = 1; phaseProgress = Math.round(cityCount / CITY_TOTAL * 100); }
  else if (restCount < REST_TOTAL) { phase = 2; phaseProgress = Math.round(restCount / REST_TOTAL * 100); }
  else { phase = 3; phaseProgress = 100; }

  const overall = phase === 1 ? Math.round(phaseProgress * 0.4)
    : phase === 2 ? 40 + Math.round(phaseProgress * 0.55)
    : 95 + Math.round(phaseProgress * 0.05);

  res.json({ ready: geocodedCount > 0, geocodedCount, phase, phaseProgress, overall, cityCount, restCount });
});

// ── Server-Sent Events: push updates to browser when awards.json changes ──────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write('event: connected\ndata: {}\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastUpdate(payload) {
  const msg = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

// Watch awards.json for changes and push to all connected browsers
let lastAwardCount = 0;
fs.watch(DATA, (event, filename) => {
  if (filename !== 'awards.json') return;
  awardsCache = null; // invalidate admin cache
  try {
    if (!fs.existsSync(AWARDS_FILE)) return;
    const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
    const count = awards.length;
    if (count === lastAwardCount) return;

    const added = count - lastAwardCount;
    const newSlice = awards.slice(-Math.abs(added));
    const winners = newSlice.filter(a => a.status === 'Winner').length;
    const rests = new Set(newSlice.map(a => a.restaurant || a.name).filter(Boolean)).size;

    function countCache(file) {
      try { return Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'))).length; }
      catch { return 0; }
    }
    const cityCount = countCache('city-cache.json');
    const restCount = countCache('restaurant-cache.json');
    const CITY_TOTAL = 973, REST_TOTAL = 4957;
    const phase = cityCount < CITY_TOTAL ? 1 : restCount < REST_TOTAL ? 2 : 3;
    const phaseProgress = phase === 1 ? Math.round(cityCount / CITY_TOTAL * 100)
      : phase === 2 ? Math.round(restCount / REST_TOTAL * 100) : 100;
    const overall = phase === 1 ? Math.round(phaseProgress * 0.4)
      : phase === 2 ? 40 + Math.round(phaseProgress * 0.55) : 95;

    lastAwardCount = count;
    broadcastUpdate({ count, added: Math.abs(added), winners, rests, phase, phaseProgress, overall });
    console.log(`[SSE] Pushed update: ${count} awards (+${Math.abs(added)}), ${sseClients.size} client(s)`);
  } catch (e) {}
});

if (fs.existsSync(AWARDS_FILE)) {
  try { lastAwardCount = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8')).length; } catch (e) {}
}

// ── Admin API ─────────────────────────────────────────────────────────────────
app.use('/api/admin', express.json());

const CUISINE_CATEGORIES = [
  'BBQ & Smokehouse','Steakhouse','Japanese','Chinese','Italian','French','Korean',
  'Thai','Indian','Southeast Asian','Mexican','Mediterranean','Middle Eastern',
  'Latin American','Seafood','Southern & Soul','African','European','American',
  'Farm to Table','Vegetarian / Vegan','Bakery & Café','Wine & Spirits',
  'Bars & Cocktails','Contemporary',
];

// Search records grouped by unique restaurant (name + city)
app.get('/api/admin/records', (req, res) => {
  const q            = (req.query.q || '').toLowerCase().trim();
  const source       = req.query.source || '';
  const missingPhoto = req.query.missingPhoto === '1';

  if (!q && !source && !missingPhoto) return res.json({ total: 0, records: [] });

  const awards = readAwards();

  const groups = new Map();
  for (const a of awards) {
    const name = (a.restaurant || a.name || '').trim();
    const city = (a.city || '').trim();
    const gk = `${name.toLowerCase()}|${city.toLowerCase()}`;
    if (!groups.has(gk)) groups.set(gk, { name, city, entries: [] });
    groups.get(gk).entries.push(a);
  }

  let results = [];
  for (const [gk, g] of groups) {
    const best    = g.entries.find(e => e.googlePhoto) || g.entries[0];
    const sources = [...new Set(g.entries.map(e => e.source))];
    results.push({
      _key:           gk,
      name:           g.name,
      city:           g.city,
      state:          best.state   || null,
      country:        best.country || null,
      sources,
      googlePhoto:    best.googlePhoto || null,
      website:        best.website  || g.entries.find(e => e.website)?.website || null,
      address:        best.address  || null,
      lat:            best.lat      || null,
      lng:            best.lng      || null,
      phone:          best.phone    || null,
      businessStatus: best.businessStatus  || null,
      cuisineCategory:best.cuisineCategory || null,
      cuisineTags:    best.cuisineTags     || null,
    });
  }

  if (q)            results = results.filter(r => r.name.toLowerCase().includes(q) || (r.city||'').toLowerCase().includes(q));
  if (source)       results = results.filter(r => r.sources.includes(source));
  if (missingPhoto) results = results.filter(r => !r.googlePhoto);

  res.json({ total: results.length, records: results.slice(0, 100) });
});

// Update enrichment fields across all entries for a restaurant
app.patch('/api/admin/records', (req, res) => {
  const { _key, fields } = req.body || {};
  if (!_key || !fields) return res.status(400).json({ error: 'Missing _key or fields' });

  const ALLOWED = ['googlePhoto','website','address','lat','lng','phone','businessStatus','cuisineCategory','cuisineTags'];
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.includes(k)) safe[k] = (v === '') ? null : v;
  }
  if (!Object.keys(safe).length) return res.status(400).json({ error: 'No valid fields provided' });

  const awards = readAwards();
  let updated = 0;
  for (const a of awards) {
    const name = (a.restaurant || a.name || '').trim().toLowerCase();
    const city = (a.city || '').trim().toLowerCase();
    if (`${name}|${city}` === _key) { Object.assign(a, safe); updated++; }
  }
  if (!updated) return res.status(404).json({ error: 'No records matched that key' });

  const tmp = AWARDS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(awards));
  fs.renameSync(tmp, AWARDS_FILE);
  awardsCache = awards;

  exec('node split-data.js', { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: stderr || err.message, updated });
    res.json({ ok: true, updated });
  });
});

// Supabase reseed — streams output as SSE
app.post('/api/admin/seed', (req, res) => {
  if (!process.env.SUPABASE_KEY) return res.status(400).json({ error: 'SUPABASE_KEY not set in environment' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const proc = spawn('node', ['scripts/seed-restaurants.js'], { cwd: __dirname });
  const send = line => res.write(`data: ${JSON.stringify(line)}\n\n`);
  proc.stdout.on('data', d => d.toString().trim().split('\n').forEach(send));
  proc.stderr.on('data', d => d.toString().trim().split('\n').forEach(l => send('[err] ' + l)));
  proc.on('close', code => { send(code === 0 ? '__DONE__' : '__FAILED__'); res.end(); });
});

// Cuisine category list for admin UI
app.get('/api/admin/cuisine-categories', (req, res) => res.json(CUISINE_CATEGORIES));

// Commit data files and push to GitHub
app.post('/api/admin/git-push', (req, res) => {
  const msg = (req.body?.message || 'Update restaurant data via admin').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = line => res.write(`data: ${JSON.stringify(line)}\n\n`);

  const DATA_FILES = [
    'data/awards.json',
    'data/awards-p1.json', 'data/awards-p2.json', 'data/awards-p3.json',
    'data/awards-p4.json', 'data/awards-p5.json', 'data/awards-p6.json',
    'data/awards-p7.json', 'data/awards-p8.json',
  ];

  function run(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd: __dirname });
      proc.stdout.on('data', d => d.toString().trim().split('\n').forEach(send));
      proc.stderr.on('data', d => d.toString().trim().split('\n').forEach(l => send('[err] ' + l)));
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    });
  }

  (async () => {
    try {
      send('> git add data/awards*.json');
      await run('git', ['add', ...DATA_FILES]);

      send('> git commit');
      await run('git', ['commit', '-m', msg]);

      send('> git push');
      await run('git', ['push']);

      send('__DONE__');
    } catch (e) {
      // "nothing to commit" is not a real error
      if (e.message.includes('exited 1') && e.message.includes('commit')) {
        send('Nothing to commit — working tree clean.');
        send('__DONE__');
      } else {
        send('Error: ' + e.message);
        send('__FAILED__');
      }
    }
    res.end();
  })();
});

app.listen(PORT, () => {
  console.log(`\n🍽  James Beard Awards Map`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   http://localhost:${PORT}/admin  (local only)\n`);
  if (lastAwardCount) console.log(`   ${lastAwardCount} awards currently loaded`);
});
