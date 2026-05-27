/**
 * Motorly Boostr Proxy — Railway
 * Usa Chrome real (Puppeteer) para bypasear el Cloudflare JS Challenge de Boostr.
 * La app móvil llama a este servidor en lugar de api.boostr.cl directamente.
 */

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { upsertRegistration, runDailyCheck } = require('./push');
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const API_KEY =
  'clnts.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNsbnRzXzAxSlI1WUQ4WE5aMTc2MkJWNFZBTkE2NllaIiwidHlwZSI6ImFwaWtleSIsImFjY2Vzc0xldmVsIjoiZnVsbCIsImlhdCI6MTc0NzE4OTc0MCwiZXhwIjozMzI5OTg1OTc0MH0.PBY6YlxcmLb4q8u7u0XVMI0JEoEk89F0h3eqr_qTAI';

const BASE = 'https://api.boostr.cl';

// ─── Browser pool ────────────────────────────────────────────────
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('[puppeteer] launching Chrome...');
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1280,800',
    ],
  });
  console.log('[puppeteer] Chrome ready');
  return browser;
}

// ─── Fetch via real Chrome ────────────────────────────────────────
async function fetchWithChrome(path, timeoutMs = 30000) {
  const url = `${BASE}${path}?apikey=${API_KEY}`;
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Extra headers to look like a real browser
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    });

    // Use domcontentloaded — CF challenge completes before networkidle
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Poll until body contains JSON (Cloudflare may redirect + challenge ~3-8s)
    const text = await page.waitForFunction(
      () => {
        const t = document.body?.innerText?.trim() ?? '';
        return (t.startsWith('{') || t.startsWith('[')) ? t : false;
      },
      { timeout: timeoutMs, polling: 500 }
    ).then(h => h.jsonValue());

    if (!text) throw new Error('No JSON found after CF challenge');
    return JSON.parse(text);
  } finally {
    await page.close();
  }
}

// ─── Routes ──────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'motorly-boostr-proxy', version: '2.0' });
});

// Debug: test multiple auth combinations
app.get('/test/:plate', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const results = {};

  const attempts = [
    { label: 'header_only',    url: `https://api.boostr.cl/vehicle/${plate}.json`,              headers: { 'X-API-KEY': API_KEY } },
    { label: 'header_plus_param', url: `https://api.boostr.cl/vehicle/${plate}.json?apikey=${API_KEY}`, headers: { 'X-API-KEY': API_KEY } },
    { label: 'bearer_only',    url: `https://api.boostr.cl/vehicle/${plate}.json`,              headers: { 'Authorization': `Bearer ${API_KEY}` } },
  ];

  for (const a of attempts) {
    try {
      const response = await fetch(a.url, {
        headers: { ...a.headers, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      results[a.label] = { status: response.status, body: text.slice(0, 300) };
    } catch (e) {
      results[a.label] = { error: e.message };
    }
  }

  res.json(results);
});

// Vehicle data
app.get('/vehicle/:plate', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[vehicle] fetching ${plate}`);
  try {
    const data = await fetchWithChrome(`/vehicle/${plate}.json`);
    res.json(data);
  } catch (e) {
    console.error(`[vehicle] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Inspection (Revisión Técnica)
app.get('/vehicle/:plate/inspection', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[inspection] fetching ${plate}`);
  try {
    const data = await fetchWithChrome(`/vehicle/${plate}/inspection.json`);
    res.json(data);
  } catch (e) {
    console.error(`[inspection] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// SOAP insurance
app.get('/vehicle/:plate/soap', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[soap] fetching ${plate}`);
  try {
    const data = await fetchWithChrome(`/vehicle/${plate}/soap.json`);
    res.json(data);
  } catch (e) {
    console.error(`[soap] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Fines (multas)
app.get('/vehicle/:plate/fines', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[fines] fetching ${plate}`);
  try {
    const data = await fetchWithChrome(`/vehicle/fines/${plate}.json`);
    res.json(data);
  } catch (e) {
    console.error(`[fines] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// All vehicle data in one shot (parallel)
app.get('/vehicle/:plate/all', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[all] fetching ${plate}`);
  try {
    const [vehicle, inspection, soap] = await Promise.all([
      fetchWithChrome(`/vehicle/${plate}.json`),
      fetchWithChrome(`/vehicle/${plate}/inspection.json`).catch(() => null),
      fetchWithChrome(`/vehicle/${plate}/soap.json`).catch(() => null),
    ]);
    res.json({ vehicle, inspection, soap });
  } catch (e) {
    console.error(`[all] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Push notification registration ──────────────────────────

// POST /register — app sends push token + vehicle expiry dates
app.post('/register', (req, res) => {
  const { token, plate, name, inspectionExpiry, soapExpiry, permisoExpiry } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    upsertRegistration({ token, plate, name, inspectionExpiry, soapExpiry, permisoExpiry });
    console.log(`[register] ${plate} — token: ${token.slice(0, 20)}...`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[register] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /push/run — manual trigger for testing
app.post('/push/run', async (req, res) => {
  try {
    await runDailyCheck();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Motorly proxy listening on port ${PORT}`);
  // Pre-warm the browser
  try {
    await getBrowser();
  } catch (e) {
    console.error('[startup] failed to launch browser:', e.message);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  if (browser) await browser.close();
  process.exit(0);
});
