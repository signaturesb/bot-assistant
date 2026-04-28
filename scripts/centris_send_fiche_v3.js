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

// ─── PROTECTIONS ENVOI CLIENT ───────────────────────────────────────────
// Règle Shawn: jamais envoyer sans accord explicite, jamais doubler.
const TEST_EMAILS = ['shawnbarrette@icloud.com', 'shawn@signaturesb.com', 'shawnbarrette@gmail.com'];
const isProductionSend = !TEST_EMAILS.includes(EMAIL.toLowerCase());
const FORCE_RESEND = process.argv.includes('--force-resend');
const AUDIT_LOG = '/tmp/centris_sends_audit.jsonl';

if (isProductionSend && !FORCE_RESEND) {
  // Check audit log pour dédup 24h
  if (fs.existsSync(AUDIT_LOG)) {
    const log = fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(Boolean);
    const recent = log.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const dup = recent.find(e => e.email === EMAIL.toLowerCase() && e.mls === MLS && (Date.now() - new Date(e.ts).getTime()) < 24 * 3600 * 1000);
    if (dup) {
      console.error(`❌ ENVOI BLOQUÉ — déjà envoyé à ${EMAIL} pour MLS ${MLS} il y a ${Math.round((Date.now() - new Date(dup.ts).getTime()) / 60000)} min.`);
      console.error(`   Pour forcer un re-envoi: ajouter flag --force-resend`);
      process.exit(1);
    }
  }
}

function auditSend(success) {
  const entry = { ts: new Date().toISOString(), mls: MLS, email: EMAIL.toLowerCase(), success, type: TYPE };
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch {}
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

  // PDF capture avec dedup par hash de contenu
  const downloads = [];
  const seenHashes = new Set();
  const crypto = require('crypto');
  function attachPdfCapture(p) {
    p.on('response', async resp => {
      try {
        const url = resp.url();
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('pdf') && !/\.pdf/i.test(url)) return;
        const buf = await resp.body();
        if (buf.length < 5000 || buf.slice(0, 4).toString() !== '%PDF') return;
        if (/Matrix.?Stats.?Guide/i.test(url)) return;
        // Dedup par hash MD5 du contenu
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        if (seenHashes.has(hash)) {
          console.log(`  ⏭ DUP skip: ${(buf.length/1024).toFixed(0)}KB ${url.substring(0, 60)}`);
          return;
        }
        seenHashes.add(hash);
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

  // Si on arrive sur PrintOptions, c'est PARFAIT — le PDF est prêt à générer
  if (/PrintOptions/i.test(page.url())) {
    console.log('  🎯 Page PrintOptions! On va déclencher la fiche descriptive...');
    await page.waitForTimeout(3000);
    // Cherche le bouton Imprimer/Print qui va générer le PDF
    try {
      const printBtn = page.locator('input[value*="Imprim" i], button:has-text("Imprimer"), input[type="submit"][value*="Print" i]').first();
      if (await printBtn.isVisible({ timeout: 5000 })) {
        const [popup, dl] = await Promise.all([
          ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null),
          page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
          printBtn.click({ timeout: 5000 }),
        ]);
        if (popup) {
          attachPdfCapture(popup);
          await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          await popup.waitForTimeout(7000);
          await popup.close().catch(() => {});
        }
        if (dl) {
          const dest = path.join(DOWNLOAD_DIR, `${Date.now()}_print.pdf`);
          await dl.saveAs(dest);
          const buf = fs.readFileSync(dest);
          if (buf.slice(0, 4).toString() === '%PDF') {
            const hash = crypto.createHash('md5').update(buf).digest('hex');
            if (!seenHashes.has(hash)) {
              seenHashes.add(hash);
              downloads.push({ name: path.basename(dest), path: dest, size: buf.length, url: 'PrintOptions', category: 'fiche_descriptive' });
              console.log('    📥 PrintOptions PDF: ' + (buf.length/1024).toFixed(0) + 'KB');
            }
          }
        }
      }
    } catch (e) { console.log('    PrintOptions err: ' + e.message?.substring(0, 100)); }
  }

  // Step 5: SCROLL DOWN — fiche descriptive est en bas
  console.log('⬇️ Scroll fiche descriptive...');
  try {
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
  } catch (e) {
    console.log('  scroll err (page may have navigated): ' + e.message?.substring(0, 80));
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: '/tmp/matrix_detail_v3_' + MLS + '.png', fullPage: true });

  // Step 6: Trouver les 2 BONS PDFs: Fiche descriptive + Déclaration vendeur
  // (Règle Shawn: TOUJOURS ces 2-là, pas certificat ni plans)
  console.log('📄 Chercher liens fiche descriptive + DV...');
  const pdfLinks = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a')) {
      const href = a.href || '';
      const txt = (a.innerText || a.textContent || '').trim();
      let score = 0;
      let category = 'other';

      // PRIORITÉ 1: Fiche descriptive (avec photos, doc complet client)
      if (/fiche\s*descriptive|fiche\s*detail|description.*client/i.test(txt)) {
        score += 100; category = 'fiche_descriptive';
      }
      // PRIORITÉ 1: Déclaration du vendeur (DV — formulaire OACIQ obligatoire)
      if (/d[eé]claration\s*(du\s*)?vendeur|^DV$|DV\s*\(|formulaire\s*DV/i.test(txt)) {
        score += 100; category = 'declaration_vendeur';
      }
      // CIGMRedirector avec Custom Action = export dynamique (probablement fiche)
      if (/CIGMRedirector.*Action=Custom/i.test(href)) {
        score += 50; if (category === 'other') category = 'cigm_custom';
      }
      // PDF direct
      if (/\.pdf/i.test(href)) score += 20;

      // EXCLUSIONS — Shawn ne veut PAS ces docs
      if (/Matrix.?Stats.?Guide|certificat\s*localisation|plan\s*cadastr|cadastre/i.test(txt + ' ' + href)) {
        score = 0; // skip
      }
      // Penalize generic doc/print buttons
      if (/^Imprimer$|guide|aide|help/i.test(txt)) score -= 10;

      if (score > 0 && href && !seen.has(href)) {
        seen.add(href);
        out.push({ href, text: txt.substring(0, 80), score, category });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  });
  console.log('  ' + pdfLinks.length + ' liens scorés:');
  for (const l of pdfLinks.slice(0, 10)) {
    console.log('    [' + l.score + '] (' + l.category + ') ' + l.text + ' → ' + l.href.substring(0, 80));
  }

  // Step 7: Click PDFs prioritaires (fiche descriptive + DV en premier)
  // Tag chaque download avec sa catégorie pour nommage propre dans email
  const linkByCategory = {};
  for (const link of pdfLinks.slice(0, 10)) {
    if (!linkByCategory[link.category]) linkByCategory[link.category] = link;
  }
  // Attache catégorie au capture pour tagging
  let currentCategory = 'unknown';
  const taggedDownloads = [];

  // Override capture: tag chaque PDF avec sa catégorie au moment du click
  const originalDownloads = downloads.slice(); // snapshot

  // Dedupe par href (plusieurs CIGMRedirector identiques dans la page)
  const uniqueLinks = [];
  const seenHrefs = new Set();
  for (const l of pdfLinks) {
    if (!seenHrefs.has(l.href)) { seenHrefs.add(l.href); uniqueLinks.push(l); }
  }
  console.log('  → ' + uniqueLinks.length + ' liens uniques après dedup');

  // Pour CIGMRedirector: faut click DOM direct (le token est généré par JS au click)
  // Pour mediaserver direct: window.open OK
  for (const link of uniqueLinks.slice(0, 5)) {
    console.log('  ↻ Trigger ' + link.category + ': ' + link.href.substring(0, 80));
    const before = downloads.length;

    if (link.category === 'cigm_custom' || /CIGMRedirector/.test(link.href)) {
      // Click le N-ième CIGMRedirector via JS (le token est généré au click).
      // On trace l'index dans uniqueLinks car tous les hrefs sont identiques (T=tok placeholder).
      try {
        const idx = uniqueLinks.filter(l => /CIGMRedirector/.test(l.href)).indexOf(link);
        const [popup] = await Promise.all([
          ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null),
          page.evaluate((i) => {
            const all = [...document.querySelectorAll('a')].filter(a => /CIGMRedirector/i.test(a.href || ''));
            if (all[i]) all[i].click();
          }, idx),
        ]);
        if (popup) {
          attachPdfCapture(popup);
          await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          // Le PDF peut prendre du temps à générer côté serveur
          await popup.waitForTimeout(6000);
          await popup.close().catch(() => {});
        } else {
          // Pas de popup — peut-être direct download
          await page.waitForTimeout(5000);
        }
      } catch (e) { console.log('    err: ' + e.message?.substring(0, 100)); }
    } else {
      // mediaserver direct — window.open OK
      try {
        const newPage = await ctx.newPage();
        attachPdfCapture(newPage);
        await newPage.goto(link.href, { waitUntil: 'load', timeout: 20000 }).catch(() => null);
        await newPage.waitForTimeout(3000);
        await newPage.close().catch(() => {});
      } catch {}
    }

    // Tag les nouveaux downloads
    for (let i = before; i < downloads.length; i++) {
      if (!downloads[i].category) downloads[i].category = link.category;
    }
  }
  console.log('⏳ Wait 5s downloads auto...');
  await page.waitForTimeout(5000);

  // Vérification: a-t-on la fiche descriptive?
  const hasFiche = downloads.some(d => d.category === 'fiche_descriptive' || d.category === 'cigm_custom');
  const hasDV = downloads.some(d => d.category === 'declaration_vendeur');

  if (!hasFiche) {
    console.log();
    console.log('⚠️  La fiche descriptive (CIGMRedirector) ne se télécharge pas auto.');
    console.log('   Le bouton Print génère un PDF côté serveur via JS — Playwright limite.');
    console.log();
    console.log('═══ ACTION REQUISE — 10 secondes ═══');
    console.log('   Dans la fenêtre Chrome ouverte:');
    console.log('   1. Clique "Imprimer" (ou icône PDF) sur la fiche descriptive');
    console.log('   2. Le PDF s\'ouvre / se télécharge');
    console.log('   3. Le script détecte automatiquement et envoie l\'email');
    console.log();
    console.log('   (Si tu veux pas, attends 30 sec et email part avec DV seule)');
    console.log();
    // Wait up to 3 MINUTES (suffit pour click humain) — avance dès qu'un nouveau PDF arrive
    const startWait = Date.now();
    const baseCount = downloads.length;
    while (Date.now() - startWait < 180000) {
      if (downloads.length > baseCount) {
        // Tag le nouveau download comme fiche_descriptive
        for (let i = baseCount; i < downloads.length; i++) {
          if (!downloads[i].category) downloads[i].category = 'fiche_descriptive';
        }
        console.log('  ✓ Nouveau PDF détecté! Continue...');
        await page.waitForTimeout(3000); // Attend 3s additional pour autres PDFs si plusieurs
        break;
      }
      await page.waitForTimeout(1000);
    }
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

  // Nommage propre selon catégorie du download
  const CATEGORY_NAMES = {
    fiche_descriptive: `Fiche_Descriptive_${MLS}.pdf`,
    declaration_vendeur: `Declaration_Vendeur_${MLS}.pdf`,
    cigm_custom: `Fiche_${MLS}.pdf`,
    other: `Document_${MLS}.pdf`,
  };
  const attachments = [];
  const seenCats = {};
  for (let i = 0; i < valid.length; i++) {
    const f = valid[i];
    // Trouve la catégorie via downloads array
    const dlEntry = downloads.find(d => d.name === f);
    const cat = dlEntry?.category || 'other';
    let name = CATEGORY_NAMES[cat] || CATEGORY_NAMES.other;
    if (seenCats[cat]) name = name.replace('.pdf', `_${seenCats[cat]+1}.pdf`);
    seenCats[cat] = (seenCats[cat] || 0) + 1;
    attachments.push({
      name,
      content: fs.readFileSync(path.join(DOWNLOAD_DIR, f)).toString('base64')
    });
    console.log('  📎 ' + name + ' (' + cat + ', ' + (fs.statSync(path.join(DOWNLOAD_DIR, f)).size/1024).toFixed(0) + 'KB)');
  }

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
    auditSend(true);
  } else {
    console.log('  ❌ HTTP ' + r.status + ': ' + txt.substring(0, 200));
    auditSend(false);
  }

  await ctx.close();
  console.log();
  console.log('═══ TERMINÉ ═══');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
