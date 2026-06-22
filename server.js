/**
 * Motorly Boostr Proxy — Railway
 * Usa Chrome real (Puppeteer) para bypasear el Cloudflare JS Challenge de Boostr.
 * La app móvil llama a este servidor en lugar de api.boostr.cl directamente.
 */

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { upsertRegistration, runDailyCheck, setFetchFines } = require('./push');
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

// GetAPI — fuente principal para datos de vehículo + Revisión Técnica
const GETAPI_KEY = '00079d11-b98d-4568-8e75-cc56c5847ac3';
const GETAPI_BASE = 'https://chile.getapi.cl';

async function fetchGetApi(plate, timeoutMs = 10000) {
  const res = await fetch(`${GETAPI_BASE}/v1/vehicles/plate/${plate}`, {
    headers: { 'X-Api-Key': GETAPI_KEY, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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

// El cron de push.js necesita consultar multas sin duplicar la API key
setFetchFines((plate) => fetchDirect(`/vehicle/traffic_tickets/${plate}.json`));

// ─── Scrape boostr.cl website (SSR) ──────────────────────────────
// El sitio es server-side rendered: los datos están en el HTML.
// Extraemos de window.__NUXT__, script JSON-LD, o del DOM visible.
async function scrapeBoostWebsite(plate, endpoint, timeoutMs = 40000) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(`https://boostr.cl/vehicle/${plate}`, {
      waitUntil: 'load',
      timeout: timeoutMs,
    });

    // Extraer todo el estado disponible de la página
    const pageData = await page.evaluate((ep) => {
      const result = {};

      // 1. window.__NUXT__ (Nuxt 2/3 SSR state)
      try {
        const n = window.__NUXT__ || window.__NUXT_DATA__ || window.__nuxt__;
        if (n) result.nuxt = n;
      } catch {}

      // 2. Script tags con JSON (JSON-LD, inline data)
      const scripts = Array.from(document.querySelectorAll('script'));
      result.scripts = scripts
        .map(s => s.textContent?.trim())
        .filter(t => t && (t.startsWith('{') || t.startsWith('[') || t.includes(ep)))
        .slice(0, 5);

      // 3. Texto visible de la página (para extracción manual)
      result.bodyText = document.body?.innerText?.slice(0, 3000);

      return result;
    }, endpoint);

    console.log(`[scrape] bodyText sample: ${pageData.bodyText?.slice(0, 200)}`);
    console.log(`[scrape] scripts found: ${pageData.scripts?.length}`);
    console.log(`[scrape] nuxt present: ${!!pageData.nuxt}`);

    // Buscar en __NUXT__
    if (pageData.nuxt) {
      const str = JSON.stringify(pageData.nuxt);
      if (str.includes(endpoint) || str.includes('expiryDate') || str.includes('expiry_date')) {
        return { _source: 'nuxt', _raw: pageData.nuxt };
      }
    }

    // Buscar en scripts inline
    for (const s of (pageData.scripts || [])) {
      if (s.includes(endpoint) || s.includes('expiry')) {
        try { return { _source: 'script', _raw: JSON.parse(s) }; } catch {}
      }
    }

    // Si no encontramos JSON, devolver el texto para diagnóstico
    return { _source: 'text', _raw: pageData.bodyText, _scripts: pageData.scripts };
  } finally {
    await page.close();
  }
}

// ─── Fetch via real Chrome (api.boostr.cl con Puppeteer stealth) ─
async function fetchWithChrome(path, timeoutMs = 45000) {
  const url = `${BASE}${path}?apikey=${API_KEY}`;
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
    });

    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

    // Esperar hasta 15s para que CF challenge resuelva y aparezca el JSON
    let text = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      text = await page.evaluate(() => document.body?.innerText?.trim() ?? '');
      if (text.startsWith('{') || text.startsWith('[')) break;
      console.log(`[chrome] waiting for JSON, body starts with: ${text.slice(0, 60)}`);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!text.startsWith('{') && !text.startsWith('[')) {
      throw new Error(`No JSON after wait. Body: ${text.slice(0, 200)}`);
    }

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

// Vehicle data (legacy — Boostr, mantenido por compatibilidad)
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

// Vehicle data + Revisión Técnica — fuente principal (GetAPI, datos más frescos)
app.get('/vehicle/:plate/getapi', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[getapi] fetching ${plate}`);
  try {
    const data = await fetchGetApi(plate);
    res.json(data);
  } catch (e) {
    console.error(`[getapi] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Inspection (Revisión Técnica) — URL correcta: /vehicle/inspection/{plate}.json
app.get('/vehicle/:plate/inspection', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[inspection] fetching ${plate}`);
  try {
    const data = await fetchDirect(`/vehicle/inspection/${plate}.json`);
    res.json(data);
  } catch (e) {
    console.error(`[inspection] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// SOAP insurance — URL correcta: /vehicle/soap/{plate}.json
app.get('/vehicle/:plate/soap', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[soap] fetching ${plate}`);
  try {
    const data = await fetchDirect(`/vehicle/soap/${plate}.json`, 25000);
    res.json(data);
  } catch (e) {
    console.error(`[soap] error for ${plate}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Fines (multas) — URL correcta: /vehicle/traffic_tickets/{plate}.json
app.get('/vehicle/:plate/fines', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  console.log(`[fines] fetching ${plate}`);
  try {
    const data = await fetchDirect(`/vehicle/traffic_tickets/${plate}.json`);
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
    // Todo directo con API key — no Puppeteer necesario
    const [vehicle, inspection, soap] = await Promise.all([
      fetchDirect(`/vehicle/${plate}.json`, 10000),
      fetchDirect(`/vehicle/inspection/${plate}.json`, 15000).catch(() => null),
      fetchDirect(`/vehicle/soap/${plate}.json`, 25000).catch(() => null),
    ]);
    return res.json({ vehicle, inspection, soap });
  } catch (e) {
    console.error(`[all] error for ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});


// Debug: muestra todas las URLs que carga boostr.cl/vehicle/:plate
app.get('/debug/:plate', async (req, res) => {
  const plate = req.params.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const b = await getBrowser();
  const page = await b.newPage();
  const urls = [];
  const jsonResponses = {};

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      const ct = response.headers()['content-type'] || '';
      urls.push({ url: url.slice(0, 120), status, ct: ct.slice(0, 40) });
      if (ct.includes('json')) {
        try {
          jsonResponses[url.slice(-80)] = await response.json();
        } catch {}
      }
    });

    await page.goto(`https://boostr.cl/vehicle/${plate}`, {
      waitUntil: 'load',
      timeout: 40000,
    });

    await new Promise(r => setTimeout(r, 5000));

    res.json({ urls, jsonResponses });
  } catch (e) {
    res.status(500).json({ error: e.message, urls });
  } finally {
    await page.close();
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
