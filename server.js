const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const DATA = path.join(__dirname, 'data');
const AWARDS_FILE = path.join(DATA, 'awards.json');

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));

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

  // Send initial ping so browser knows it's connected
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
  try {
    if (!fs.existsSync(AWARDS_FILE)) return;
    const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
    const count = awards.length;
    if (count === lastAwardCount) return;

    // Compute quick stats for the toast
    const added = count - lastAwardCount;
    const newSlice = awards.slice(-Math.abs(added)); // approximate new entries
    const winners = newSlice.filter(a => a.status === 'Winner').length;
    const rests = new Set(newSlice.map(a => a.restaurant || a.name).filter(Boolean)).size;

    // Get current phase for the toast progress bar
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

// Init lastAwardCount on startup
if (fs.existsSync(AWARDS_FILE)) {
  try { lastAwardCount = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8')).length; } catch (e) {}
}

app.listen(PORT, () => {
  console.log(`\n🍽  James Beard Awards Map`);
  console.log(`   http://localhost:${PORT}\n`);
  if (lastAwardCount) console.log(`   ${lastAwardCount} awards currently loaded`);
});
