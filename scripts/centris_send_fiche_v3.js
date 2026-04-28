// centris_send_fiche_v3.js — Flow complet Matrix avec gestion
// LoginIntermediateMLD + omnisearch + scroll détail + PDF descriptive
//
// Usage: node scripts/centris_send_fiche_v3.js <type> <mls> <email> [message]

const { chromium } = require('/Users/signaturesb/Documents/github/mailing-masse/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const TYPE = (process.argv[2] || 'terrain').toLowerCase();
const MLS = process.argv[3];
const EMAIL = process.argv[4];
const MESSAGE = process.argv[5] || '';

if (!MLS || !EMAIL) {
  console.error('Usage: node centris_send_fiche_v3.js <type> <mls> <email> [message]');
  process.exit(1);
}

const TYPE_TO_SECTION = {
  terrain: 'https://matrix.centris.ca/Matrix/Search/Land',
  terre: 'https://matrix.centris.ca/Matrix/Search/Land',
  maison: 'https://matrix.centris.ca/Matrix/Search/Residential',
  unifamiliale: 'https://matrix.centris.ca/Matrix/Search/Residential',
  condo: 'https://matrix.centris.ca/Matrix/Search/Condominium',
  copropriete: 'https://matrix.centris.ca/Matrix/Search/Condominium',
  plex: 'https://matrix.centris.ca/Matrix/Search/Income',
  ferme: 'https://matrix.centris.ca/Matrix/Search/Farm',
};
const SECTION_URL = TYPE_TO_SECTION[TYPE] || TYPE_TO_SECTION.terrain;

const PROFILE_DIR = path.join(__dirname, '..', '.playwright-centris-profile');
const DOWNLOAD_DIR = path.join('/tmp', 'centris_pdfs_' + MLS);
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function loadCreds() {
  const f = path.join(process.env.HOME, 'Documents/github/mailing-masse/.env');
  const text = fs.readFileSync(f, 'utf8');
  return {
    user: text.match(/CENTRIS_USER\s*=\s*"?([^"\n]+)"?/)?.[1]?.trim(),
    pass: text.match(/CENTRIS_PASS\s*=\s*"?([^"\n]+)"?/)?.[1]?.trim(),
    brevoKey: text.match(/BREVO_API_KEY\s*=\s*"?([^"\n]+)"?/)?.[1]?.trim(),
  };
}

// Attend que l'URL ne soit plus une page d'auth/intermediate
async function waitOutOfAuth(page, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const url = page.url();
    if (!/Login|accounts\.centris|IntermediateMLD|OpenIDSignIn/i.test(url) || /\/Matrix\/(Search|Default|Home|Results|Land|Residential|Condominium|Income|Farm)/i.test(url)) {
      return true;
    }
    await page.waitForTimeout(1500);
  }
  return false;
}

(async () => {
  const creds = loadCreds();
  console.log(`🚀 Fiche Centris — type=${TYPE}, MLS=${MLS}`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    acceptDownloads: true,
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // PDF capture
  const downloads = [];
  function attachPdfCapture(p) {
    p.on('response', async resp => {
      try {
        const url = resp.url();
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('pdf') && !/\.pdf/i.test(url)) return;
        const buf = await resp.body();
        if (buf.length < 5000 || buf.slice(0, 4).toString() !== '%PDF') return;
        if (/Matrix.?Stats.?Guide/i.test(url)) return;
        const fname = `${Date.now()}_${(url.split('/').pop().split('?')[0] || 'pdf').replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 60)}.pdf`;
        const dest = path.join(DOWNLOAD_DIR, fname);
        fs.writeFileSync(dest, buf);
        downloads.push({ name: fname, path: dest, size: buf.length, url });
        console.log(`  📥 PDF: ${(buf.length/1024).toFixed(0)}KB ← ${url.substring(0, 90)}`);
      } catch {}
    });
  }
  attachPdfCapture(page);
  ctx.on('page', attachPdfCapture);

  // Step 1: Aller sur /Matrix/Default pour bypass intermediate
  console.log('📍 Matrix Default...');
  await page.goto('https://matrix.centris.ca/Matrix/Default.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Login Matrix si demandé
  if (await page.locator('text=/Connect to Matrix|User code|Code utilisateur/i').first().isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  🔐 Login Matrix...');
    const inputs = await page.locator('input').all();
    for (const inp of inputs) {
      const t = await inp.getAttribute('type');
      if (t === 'password') await inp.fill(creds.pass);
      else if (t !== 'checkbox' && t !== 'submit' && t !== 'hidden') await inp.fill(creds.user);
    }
    await page.locator('button:has-text("Connect"), input[type="submit"]').first().click();
    await page.waitForTimeout(5000);
  }

  // Wait through any intermediate auth pages
  console.log('  ⏳ Wait out of auth...');
  await waitOutOfAuth(page);
  console.log('  ✓ URL:', page.url());

  // Step 2: Aller à la section search appropriée
  console.log('📍 Section search...');
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await waitOutOfAuth(page);
  console.log('  ✓ URL:', page.url());

  // Step 3: Trouver le sous-onglet "No Centris" et cliquer
  console.log('🔢 Onglet No Centris...');
  let onNoCentris = false;
  try {
    // Cherche un lien/onglet "No Centris" — souvent dans une nav top de la section
    const noCentrisLink = page.locator('a:has-text("No Centris"), a:has-text("MLS"), a[href*="MLS"]').first();
    if (await noCentrisLink.isVisible({ timeout: 3000 })) {
      await noCentrisLink.click();
      await page.waitForTimeout(2500);
      onNoCentris = true;
      console.log('  ✓ Click No Centris');
    }
  } catch {}

  // Si pas trouvé, on utilise le omnisearch au top
  console.log('🔍 Search MLS ' + MLS + '...');
  await page.waitForTimeout(1500);
  let searched = false;
  // Fields candidates par priorité
  const inputCandidates = [
    'input[type="text"][placeholder*="Centris" i]',
    'input[type="text"][placeholder*="MLS" i]',
    'input[type="text"][name*="MLS" i]',
    'input[type="text"][id*="MLS" i]',
    'textarea[placeholder*="MLS" i]',
    '#m_ucMLNumberSearch_m_tbMLNumber',  // Matrix common ID
    'input[type="text"]',
  ];
  for (const sel of inputCandidates) {
    try {
      const inp = page.locator(sel).first();
      if (await inp.isVisible({ timeout: 1500 })) {
        await inp.click();
        await inp.fill(MLS);
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter');
        searched = true;
        console.log('  ✓ Search submitted (selector: ' + sel.substring(0, 40) + ')');
        break;
      }
    } catch {}
  }
  if (!searched) console.log('  ⚠️ Aucun input trouvé');

  await page.waitForTimeout(6000);
  console.log('  URL:', page.url());
  await page.screenshot({ path: '/tmp/matrix_results_v3_' + MLS + '.png' });

  // Step 4: Click result row
  console.log('🎯 Click result...');
  let resultClicked = false;
  // Méthode 1: links avec texte contenant le MLS
  const links = await page.locator('a').all();
  for (const link of links) {
    try {
      const txt = await link.innerText({ timeout: 300 }).catch(() => '');
      if (txt.includes(MLS) && txt.length < 500) {
        await link.click();
        resultClicked = true;
        console.log('  ✓ Click link contenant MLS');
        break;
      }
    } catch {}
  }
  if (!resultClicked) {
    // Méthode 2: rows
    const rows = await page.locator('tr').all();
    for (const row of rows) {
      try {
        const txt = await row.innerText({ timeout: 300 }).catch(() => '');
        if (txt.includes(MLS)) {
          const link = row.locator('a').first();
          if (await link.isVisible({ timeout: 800 }).catch(() => false)) {
            await link.click();
            resultClicked = true;
            console.log('  ✓ Click row');
            break;
          }
        }
      } catch {}
    }
  }
  await page.waitForTimeout(5000);
  console.log('  URL détail:', page.url());

  // Step 5: SCROLL DOWN — fiche descriptive est en bas
  console.log('⬇️ Scroll fiche descriptive...');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: '/tmp/matrix_detail_v3_' + MLS + '.png', fullPage: true });

  // Step 6: Trouver TOUS les liens PDF / fiche descriptive / documents
  console.log('📄 Chercher liens PDFs...');
  const pdfLinks = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a')) {
      const href = a.href || '';
      const txt = (a.innerText || a.textContent || '').trim();
      const score =
        (/\.pdf/i.test(href) ? 10 : 0) +
        (/fiche\s*descriptive/i.test(txt) ? 20 : 0) +
        (/fiche/i.test(txt) ? 5 : 0) +
        (/document/i.test(txt) ? 3 : 0) +
        (/certificat|plan|cadastre/i.test(txt) ? 3 : 0) +
        (/Document|FichaDescrip|attache|plan/i.test(href) ? 5 : 0);
      if (score > 0 && href && !seen.has(href)) {
        seen.add(href);
        out.push({ href, text: txt.substring(0, 80), score });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  });
  console.log('  ' + pdfLinks.length + ' liens scorés:');
  for (const l of pdfLinks.slice(0, 10)) {
    console.log('    [' + l.score + '] ' + l.text + ' → ' + l.href.substring(0, 80));
  }

  // Step 7: Click chaque PDF link (en priorité fiche descriptive)
  for (const link of pdfLinks.slice(0, 8)) {
    try {
      const [popup] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null),
        page.evaluate(url => window.open(url, '_blank'), link.href),
      ]);
      if (popup) {
        attachPdfCapture(popup);
        await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await popup.waitForTimeout(2500);
        await popup.close().catch(() => {});
      }
    } catch {}
  }
  console.log('⏳ Wait 10s downloads...');
  await page.waitForTimeout(10000);

  // Manual fallback
  if (downloads.length === 0) {
    console.log('⚠️ Aucun PDF auto. 90 sec pour télécharger manuellement → ' + DOWNLOAD_DIR);
    await page.waitForTimeout(90000);
  }

  // Step 8: Send email avec template branded
  const allFiles = fs.readdirSync(DOWNLOAD_DIR);
  const valid = allFiles.filter(f => {
    const buf = fs.readFileSync(path.join(DOWNLOAD_DIR, f));
    return buf.length > 5000 && buf.slice(0, 4).toString() === '%PDF' && !/Matrix.?Stats.?Guide/i.test(f);
  });
  console.log();
  console.log('📦 ' + valid.length + ' PDF(s) valide(s)');
  for (const v of valid) console.log('  • ' + v + ' (' + (fs.statSync(path.join(DOWNLOAD_DIR, v)).size/1024).toFixed(0) + 'KB)');

  if (valid.length === 0) {
    console.log('❌ Aucun PDF — abort');
    await ctx.close();
    process.exit(1);
  }

  console.log();
  console.log('📧 Envoi email à ' + EMAIL + '...');
  const tplPath = path.join(__dirname, 'centris_fiche_email_template.html');
  let htmlBody = fs.readFileSync(tplPath, 'utf8');
  const messageHtml = (MESSAGE || `J'ai le plaisir de vous transmettre la fiche détaillée de la propriété <strong>Centris #${MLS}</strong>.`).replace(/\n/g, '<br/>');
  const dateStr = new Date().toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Toronto' });
  htmlBody = htmlBody
    .replace(/\{MESSAGE_HTML\}/g, messageHtml)
    .replace(/\{CENTRIS_NUM\}/g, MLS)
    .replace(/\{DATE_ENVOI\}/g, dateStr);

  const attachments = valid.map((f, i) => ({
    name: valid.length === 1 ? `Fiche_Centris_${MLS}.pdf` : `Fiche_Centris_${MLS}_${i+1}.pdf`,
    content: fs.readFileSync(path.join(DOWNLOAD_DIR, f)).toString('base64')
  }));

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': creds.brevoKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Shawn Barrette', email: 'shawn@signaturesb.com' },
      replyTo: { email: 'shawn@signaturesb.com', name: 'Shawn Barrette' },
      to: [{ email: EMAIL }],
      cc: [{ email: 'shawn@signaturesb.com', name: 'Shawn' }],
      subject: `Fiche propriété — Centris #${MLS}`,
      htmlContent: htmlBody,
      attachment: attachments,
    })
  });
  const txt = await r.text();
  if (r.ok || r.status === 201) {
    console.log('  ✅ Email envoyé!');
    console.log('  ', JSON.parse(txt).messageId);
  } else {
    console.log('  ❌ HTTP ' + r.status + ': ' + txt.substring(0, 200));
  }

  await ctx.close();
  console.log();
  console.log('═══ TERMINÉ ═══');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
