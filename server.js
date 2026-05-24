/**
 * Motorly Boostr Proxy — Railway
 * Usa Chrome real (Puppeteer) para bypasear el Cloudflare JS Challenge de Boostr.
 * La app móvil llama a este servidor en lugar de api.boostr.cl directamente.
 */

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
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
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  });
  console.log('[puppeteer] Chrome ready');
  return browser;
}

// ─── Fetch via real Chrome ────────────────────────────────────────
async function fetchWithChrome(path, timeoutMs = 15000) {
  const url = `${BASE}${path}?apikey=${API_KEY}`;
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Wait for JSON to appear (Cloudflare challenge may add a delay)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });

    // Some CF challenges redirect — wait for actual content
    const text = await page.evaluate(() => document.body.innerText.trim());

    if (!text.startsWith('{') && !text.startsWith('[')) {
      throw new Error('CF_BLOCKED: ' + text.slice(0, 200));
    }

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
