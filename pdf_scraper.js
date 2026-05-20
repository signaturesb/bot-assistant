// pdf_scraper.js — Scraping PDF universel avec cascade 3 niveaux
// Capable de bypass: consent walls, JS-rendered, anti-bot, Cloudflare basic
//
// CASCADE:
// 1. Direct HTTP (got avec stealth headers) — pour PDFs accessibles direct
// 2. Firecrawl — sites statiques + extraction markdown
// 3. rebrowser-playwright + Browserless — stealth full (consent walls, JS)
//
// Utilise les meilleurs outils GitHub 2026 déjà installés:
// - rebrowser-playwright (anti-detect natif)
// - got (HTTP avec retry intelligent)
// - cheerio (parsing HTML rapide)
// - pdf-parse (extract text PDFs)
// - p-limit (concurrence contrôlée)

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const CACHE_DIR = path.join(DATA_DIR, 'pdf_scraper_cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

// Headers stealth pour fetch direct (browser-like)
const STEALTH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

// ─── Helper: download buffer si direct PDF ──────────────────────────────────
async function downloadDirectPDF(url, timeoutMs = 30000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: STEALTH_HEADERS,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return { success: false, status: res.status, message: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const isPDF = buf.length > 1000 && buf.slice(0, 4).toString() === '%PDF';
    if (!isPDF) {
      return { success: false, message: `Not PDF (CT: ${ct}, size: ${buf.length})`, html: buf.toString('utf8').substring(0, 5000) };
    }
    return {
      success: true,
      buffer: buf,
      size: buf.length,
      content_type: ct,
      filename: decodeURIComponent(url.split('/').pop().split('?')[0] || 'document.pdf'),
      method: 'direct-http',
    };
  } catch (e) {
    return { success: false, message: `Direct fetch fail: ${e.message?.substring(0, 100)}` };
  }
}

// ─── Helper: extract PDF links from HTML ─────────────────────────────────────
function extractPDFLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  // Markdown links
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+\.pdf[^\s)]*)\)/gi;
  let m;
  while ((m = mdRe.exec(html)) !== null) {
    if (!seen.has(m[2])) { seen.add(m[2]); links.push({ text: m[1].substring(0, 100), url: m[2] }); }
  }
  // HTML <a href="...pdf">
  const htmlRe = /<a[^>]+href=["']([^"']+\.pdf[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = htmlRe.exec(html)) !== null) {
    let url = m[1];
    // Resolve relative URLs
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/') && baseUrl) {
      try { url = new URL(url, baseUrl).href; } catch {}
    } else if (!url.startsWith('http') && baseUrl) {
      try { url = new URL(url, baseUrl).href; } catch {}
    }
    if (!seen.has(url)) {
      seen.add(url);
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 100);
      links.push({ text, url });
    }
  }
  // Naked PDF URLs
  const nakedRe = /(?<!["'(\[])(https?:\/\/[^\s<>"']+\.pdf\b[^\s<>"']*)/gi;
  while ((m = nakedRe.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); links.push({ text: '(lien direct)', url: m[1] }); }
  }
  return links;
}

// ─── LEVEL 2: Firecrawl scrape ───────────────────────────────────────────────
async function tryFirecrawl(url, motsCles = []) {
  try {
    const fc = require('./firecrawl_scraper');
    const r = await fc.scrapUrl(url, motsCles);
    if (!r || !r.contenu) return { success: false, message: 'Firecrawl empty' };
    return { success: true, content: r.contenu, fromCache: r.fromCache, method: 'firecrawl' };
  } catch (e) { return { success: false, message: `Firecrawl: ${e.message?.substring(0, 100)}` }; }
}

// ─── LEVEL 3: rebrowser-playwright + Browserless stealth ────────────────────
async function tryBrowserlessStealth(url, opts = {}) {
  let browser = null;
  try {
    // Reuse cua_driver's launchBrowser (rebrowser + Browserless config)
    const cuaDriver = require('./cua_driver');
    if (!cuaDriver.CUA_AVAILABLE()) return { success: false, message: 'CUA driver indispo' };
    // Use lazy-load internal helpers (we don't expose launchBrowser publicly, but we can reach)
    let playwright;
    try { playwright = require('rebrowser-playwright'); }
    catch { try { playwright = require('playwright-core'); }
    catch { return { success: false, message: 'No playwright' }; }}

    // Launch via Browserless si dispo
    const wsEndpoint = process.env.BROWSERLESS_WS;
    if (wsEndpoint) {
      browser = await playwright.chromium.connect(wsEndpoint, { timeout: 30000 });
    } else {
      browser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
      });
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: STEALTH_HEADERS['User-Agent'],
      locale: 'fr-CA',
      timezoneId: 'America/Toronto',
      acceptDownloads: true,
      extraHTTPHeaders: STEALTH_HEADERS,
    });
    // Anti-detect script
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-CA', 'fr', 'en-CA', 'en'] });
    `);

    const page = await context.newPage();

    // Intercept downloads (PDF direct)
    let downloadedBuffer = null;
    page.on('download', async (d) => {
      try {
        const tmpPath = path.join(CACHE_DIR, `dl_${Date.now()}_${d.suggestedFilename()}`);
        await d.saveAs(tmpPath);
        downloadedBuffer = { buffer: fs.readFileSync(tmpPath), filename: d.suggestedFilename() };
      } catch (e) { console.warn('[PDF-SCRAPER] download error:', e.message); }
    });

    // Navigate
    const navResult = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => ({ error: e.message }));

    // Si direct PDF download
    await page.waitForTimeout(2000);
    if (downloadedBuffer) {
      return {
        success: true,
        buffer: downloadedBuffer.buffer,
        filename: downloadedBuffer.filename,
        size: downloadedBuffer.buffer.length,
        method: 'browserless-download',
      };
    }

    // Handle consent walls auto (clic "Accepter", "OK", "J'accepte", "Continue")
    await handleConsentWalls(page);
    await page.waitForTimeout(2000);

    // Get final HTML + check PDF links
    const finalUrl = page.url();
    const html = await page.content();
    const pdfLinks = extractPDFLinks(html, finalUrl);

    // Try page.pdf() as fallback (render current page as PDF)
    let renderedPDF = null;
    if (opts.renderAsPDF) {
      try {
        renderedPDF = await page.pdf({ format: 'Letter', printBackground: true });
      } catch {}
    }

    return {
      success: true,
      method: 'browserless-html',
      html_length: html.length,
      final_url: finalUrl,
      pdf_links: pdfLinks,
      rendered_pdf: renderedPDF ? { buffer: renderedPDF, size: renderedPDF.length } : null,
    };
  } catch (e) {
    return { success: false, message: `Browserless: ${e.message?.substring(0, 200)}` };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// Helper: clic les consent walls courants (cookies, GDPR, "j'accepte")
async function handleConsentWalls(page) {
  const selectors = [
    'button:has-text("Accepter")', 'button:has-text("J\'accepte")',
    'button:has-text("Tout accepter")', 'button:has-text("OK")',
    'button:has-text("Continuer")', 'button:has-text("Continue")',
    'button:has-text("Accept all")', 'button:has-text("Accept")',
    'button:has-text("Agree")', 'a:has-text("Accepter")',
    '#cookiescript_accept', '.cookie-accept', '[id*=consent] button',
    '[class*=cookie-consent] button', 'button[aria-label*="Accept" i]',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(() => {});
        console.log(`[PDF-SCRAPER] Clicked consent: ${sel}`);
        await page.waitForTimeout(800);
      }
    } catch {}
  }
}

// ─── API PUBLIQUE — Cascade automatique ─────────────────────────────────────
/**
 * Scrape une URL et extract PDFs avec fallback automatique.
 * @param {string} url
 * @param {object} opts — { motsCles, renderAsPDF, skipLevel1 }
 * @returns {Promise<{success, content?, pdf_links?, buffer?, filename?, method, message}>}
 */
async function scrapePDFUniversal(url, opts = {}) {
  const startedAt = Date.now();
  // LEVEL 1: Direct HTTP (si URL termine .pdf, ultra-rapide)
  if (!opts.skipLevel1 && /\.pdf(\?|$)/i.test(url)) {
    console.log(`[PDF-SCRAPER] L1 direct PDF: ${url.substring(0, 80)}`);
    const r1 = await downloadDirectPDF(url);
    if (r1.success) return { ...r1, elapsed_ms: Date.now() - startedAt };
    console.log(`[PDF-SCRAPER] L1 fail: ${r1.message}`);
  }

  // LEVEL 2: Firecrawl
  console.log(`[PDF-SCRAPER] L2 Firecrawl: ${url.substring(0, 80)}`);
  const r2 = await tryFirecrawl(url, opts.motsCles);
  if (r2.success) {
    const pdfLinks = extractPDFLinks(r2.content, url);
    return { ...r2, pdf_links: pdfLinks, elapsed_ms: Date.now() - startedAt };
  }
  console.log(`[PDF-SCRAPER] L2 fail: ${r2.message}`);

  // LEVEL 3: rebrowser-playwright + Browserless (stealth ultime)
  console.log(`[PDF-SCRAPER] L3 Browserless stealth: ${url.substring(0, 80)}`);
  const r3 = await tryBrowserlessStealth(url, opts);
  if (r3.success) return { ...r3, elapsed_ms: Date.now() - startedAt };

  return {
    success: false,
    message: `Tous niveaux échoués. L1: ${url.endsWith('.pdf') ? 'tried' : 'skipped'}. L2: ${r2.message}. L3: ${r3.message}`,
    elapsed_ms: Date.now() - startedAt,
  };
}

/**
 * Cherche tous les PDFs sur une page + télécharge ceux qui matchent les filtres.
 * @param {string} url
 * @param {object} opts — { motsCles, maxPDFs, filterKeyword }
 * @returns {Promise<{success, pdf_links, downloaded: [{buffer, filename}], message}>}
 */
async function findAndDownloadPDFs(url, opts = {}) {
  const { motsCles = [], maxPDFs = 5, filterKeyword } = opts;
  const r = await scrapePDFUniversal(url, { motsCles });
  if (!r.success) return r;

  let pdfLinks = r.pdf_links || [];
  if (filterKeyword) {
    const kw = filterKeyword.toLowerCase();
    pdfLinks = pdfLinks.filter(l =>
      l.text.toLowerCase().includes(kw) ||
      l.url.toLowerCase().includes(kw)
    );
  }

  const toDownload = pdfLinks.slice(0, maxPDFs);
  const downloaded = [];
  const errors = [];

  // p-limit pour concurrence contrôlée
  let pLimit;
  try { pLimit = require('p-limit').default || require('p-limit'); }
  catch { pLimit = (n) => (fn) => fn(); }
  const limit = pLimit(3);

  await Promise.all(toDownload.map(link => limit(async () => {
    const dl = await downloadDirectPDF(link.url);
    if (dl.success) {
      downloaded.push({ buffer: dl.buffer, filename: dl.filename, size: dl.size, text: link.text, url: link.url });
    } else {
      errors.push({ url: link.url, error: dl.message });
    }
  })));

  return {
    success: downloaded.length > 0,
    method: r.method,
    pdf_links_found: pdfLinks.length,
    downloaded_count: downloaded.length,
    downloaded,
    errors,
    message: `${downloaded.length}/${toDownload.length} PDFs téléchargés`,
  };
}

module.exports = {
  scrapePDFUniversal,
  findAndDownloadPDFs,
  downloadDirectPDF,
  extractPDFLinks,
  handleConsentWalls,
};
