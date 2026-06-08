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

// CORS — permite requests desde el browser (web version de la app)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;

const API_KEY =
  'clnts.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbGllbnQiOjE3NSwicGxhbiI6ImN1c3RvbSIsImFkZG9ucyI6IiIsImV4Y2x1ZGVzIjoiIiwicmF0ZSI6IjV4MTAiLCJjdXN0b20iOnsiZG9jdW1lbnRfbnVtYmVyX2RhaWx5X2xpbWl0IjowLCJwbGF0ZXNfZGFpbHlfbGltaXQiOjB9LCJpYXQiOjE3Nzg3ODA4MjksImV4cCI6MTkwNTAxMTIyOX0.30q7FCtygUDaqyaV0RrHTYC4s-bAqo3SXIHekYF23lE';

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

// ─── Fetch directo con API key (rápido, ~200ms) ──────────────────
async function fetchDirect(path, timeoutMs = 10000) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-API-KEY': API_KEY,
      'Authorization': `Bearer ${API_KEY}`,
      'User-Agent': 'AutoK-App/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    throw new Error('Got HTML — Cloudflare blocked, needs Puppeteer');
  }
  return JSON.parse(text);
}

// ─── Scrape boostr.cl website ─────────────────────────────────────
// Navega al sitio web, intercepta responses de la API interna,
// y también extrae datos del estado JS de la SPA (Nuxt/Vue).
async function scrapeBoostWebsite(plate, endpoint, timeoutMs = 50000) {
  const b = await getBrowser();
  const page = await b.newPage();
  const responses = {};

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Capturar TODAS las respuestas JSON de la API interna
    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        responses[url] = json;
        console.log(`[intercept] ${url.slice(-60)}`);
      } catch {}
    });

    // Navegar con 'load' (más rápido que networkidle0)
    await page.goto(`https://boostr.cl/vehicle/${plate}`, {
      waitUntil: 'load',
      timeout: timeoutMs,
    });

    // Esperar 6s para que el SPA cargue los datos asincrónicos
    await new Promise(r => setTimeout(r, 6000));

    // Intentar extraer del estado Nuxt/Vue
    const nuxtData = await page.evaluate(() => {
      try {
        const n = window.__NUXT__ || window.__nuxt__;
        return n ? JSON.stringify(n) : null;
      } catch { return null; }
    });

    // Buscar en las respuestas interceptadas
    const plateLC = plate.toLowerCase();
    for (const [url, json] of Object.entries(responses)) {
      if (url.includes(endpoint) || url.includes(plateLC)) {
        console.log(`[intercept] matched ${endpoint} at ${url}`);
        return json;
      }
    }

    // Intentar extraer del DOM directamente
    if (nuxtData) {
      const raw = JSON.parse(nuxtData);
      const str = JSON.stringify(raw);
      if (str.includes(endpoint)) {
        console.log(`[nuxt] found ${endpoint} in __NUXT__`);
        return raw;
      }
    }

    console.log(`[scrape] no data found for ${endpoint}, responses:`, Object.keys(responses));
    return null;
  } finally {
    await page.close();
  }
}

// ─── Fetch via real Chrome (api.boostr.cl directo) ───────────────
async function fetchWithChrome(path, timeoutMs = 30000) {
  const url = `${BASE}${path}?apikey=${API_KEY}`;
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

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

// ─── Fetch principal: directo → website intercept → Puppeteer API
async function fetchBoostr(path, timeoutMs = 45000) {
  // Para vehicle principal → directo con API key (rápido)
  try {
    const data = await fetchDirect(path, 10000);
    console.log(`[direct] OK ${path}`);
    return data;
  } catch (e) {
    console.log(`[direct] failed (${e.message})`);
    // Para sub-endpoints (inspection/soap/fines) → scrape el website
    return fetchWithChrome(path, timeoutMs);
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
    const data = await fetchBoostr(`/vehicle/${plate}.json`);
    res.json(data);
  } catch (e) {
    console.error(`[vehicle] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Inspection (Revisión Técnica)
app.get('/vehicle/:plate/inspection', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[inspection] fetching ${plate} via website scrape`);
  try {
    const data = await scrapeBoostWebsite(plate, 'inspection');
    if (!data) return res.status(404).json({ status: 'not_found', data: null });
    res.json(data);
  } catch (e) {
    console.error(`[inspection] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// SOAP insurance
app.get('/vehicle/:plate/soap', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[soap] fetching ${plate} via website scrape`);
  try {
    const data = await scrapeBoostWebsite(plate, 'soap');
    if (!data) return res.status(404).json({ status: 'not_found', data: null });
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
    const data = await fetchBoostr(`/vehicle/fines/${plate}.json`);
    res.json(data);
  } catch (e) {
    console.error(`[fines] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// All vehicle data — vehicle directo + inspection/soap via website intercept
app.get('/vehicle/:plate/all', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[all] fetching ${plate}`);
  try {
    // Vehicle directo con API key (rápido)
    const vehicle = await fetchDirect(`/vehicle/${plate}.json`, 10000);

    // Inspection y SOAP en una sola navegación al website
    const b = await getBrowser();
    const page = await b.newPage();
    let inspection = null, soap = null;

    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );

      page.on('response', async (response) => {
        const url = response.url();
        try {
          if (url.includes('inspection') && url.includes(plate.toLowerCase())) {
            inspection = await response.json();
            console.log(`[intercept] inspection captured for ${plate}`);
          } else if (url.includes('soap') && url.includes(plate.toLowerCase())) {
            soap = await response.json();
            console.log(`[intercept] soap captured for ${plate}`);
          }
        } catch {}
      });

      await page.goto(`https://boostr.cl/vehicle/${plate}`, {
        waitUntil: 'networkidle0',
        timeout: 45000,
      });

      if (!inspection || !soap) await new Promise(r => setTimeout(r, 3000));
    } finally {
      await page.close();
    }

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
