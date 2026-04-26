// scrape_gmail.js — Bulk fetch Gmail (5 ans) avec filtre Pipedrive emails
// Output: data/gmail_index.jsonl

require('dotenv').config({ path: __dirname + '/../../../mailing-masse/.env' });
// Charge aussi les Gmail tokens depuis le fichier dédié
require('dotenv').config({ path: '/Users/signaturesb/Downloads/signaturesb-bot.env', override: false });

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PIPEDRIVE_FILE = path.join(DATA_DIR, 'pipedrive_contacts.json');
const OUT_FILE = path.join(DATA_DIR, 'gmail_index.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'gmail_scrape_state.json');

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
  console.error('❌ Gmail OAuth manquant — vérifier ~/Downloads/signaturesb-bot.env');
  process.exit(1);
}

// ─── OAuth refresh ────────────────────────────────────────────────────────
async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!r.ok) throw new Error(`OAuth refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

// ─── Gmail API helpers ────────────────────────────────────────────────────
async function gmailReq(accessToken, p, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(`https://gmail.googleapis.com${p}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (r.status === 429 || r.status === 403) {
      // Rate limit → backoff
      await new Promise(rs => setTimeout(rs, (i + 1) * 2000));
      continue;
    }
    if (!r.ok) throw new Error(`Gmail ${p} → ${r.status}: ${(await r.text()).substring(0, 100)}`);
    return r.json();
  }
  throw new Error(`Gmail ${p} → max retries`);
}

// Liste les message IDs avec query (ex: "in:sent after:2021/01/01")
async function listMessageIds(accessToken, query, maxResults = 100000) {
  const ids = [];
  let pageToken = null;
  let pages = 0;
  while (true) {
    const qs = new URLSearchParams({ q: query, maxResults: '500' });
    if (pageToken) qs.set('pageToken', pageToken);
    const r = await gmailReq(accessToken, `/gmail/v1/users/me/messages?${qs.toString()}`);
    if (r.messages) ids.push(...r.messages.map(m => m.id));
    pageToken = r.nextPageToken;
    pages++;
    process.stdout.write(`    ${ids.length} IDs (page ${pages})\r`);
    if (!pageToken || ids.length >= maxResults) break;
  }
  console.log('');
  return ids;
}

// Get message metadata (sans body, rapide)
async function getMessageMeta(accessToken, id) {
  return gmailReq(accessToken, `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
}

// Extract email d'un header "Name <email@x.com>" ou "email@x.com"
function extractEmails(headerValue) {
  if (!headerValue) return [];
  const matches = headerValue.match(/[\w.+-]+@[\w.-]+\.[\w-]+/g) || [];
  return matches.map(e => e.toLowerCase());
}

function getHeader(payload, name) {
  const h = payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(PIPEDRIVE_FILE)) {
    console.error('❌ pipedrive_contacts.json manquant — run fetch_pipedrive_contacts.js d\'abord');
    process.exit(1);
  }
  const pipedrive = JSON.parse(fs.readFileSync(PIPEDRIVE_FILE, 'utf8'));
  // Exclu les emails de Shawn lui-même + shared (ses From sont toujours lui)
  const SELF_EMAILS = new Set([
    'shawn@signaturesb.com',
    'julie@signaturesb.com',
    'shawnbarrette@gmail.com', // adapter selon
    'no-reply@signaturesb.com',
  ]);
  const validEmails = pipedrive.emails.filter(e => !SELF_EMAILS.has(e.email.toLowerCase()));
  const emailSet = new Set(validEmails.map(e => e.email.toLowerCase()));
  const emailToContact = new Map(validEmails.map(e => [e.email.toLowerCase(), e]));
  console.log(`📚 ${emailSet.size} emails Pipedrive comme filtre (${pipedrive.emails.length - emailSet.size} self/shared exclus)`);

  console.log(`🔑 OAuth refresh...`);
  let accessToken = await getAccessToken();
  console.log(`  ✓ Access token obtenu`);

  // Window: 3 ans en arrière (compromise: assez de données + pas trop coûteux)
  const since = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000);
  const sinceStr = `${since.getFullYear()}/${(since.getMonth() + 1).toString().padStart(2, '0')}/${since.getDate().toString().padStart(2, '0')}`;
  console.log(`📅 Fenêtre: après ${sinceStr}`);

  console.log(`\n📨 1. Liste des IDs de messages SENT...`);
  const sentIds = await listMessageIds(accessToken, `in:sent after:${sinceStr}`, 50000);
  console.log(`  ${sentIds.length} sent IDs`);

  console.log(`\n📥 2. Liste des IDs de messages REÇUS (incluant archivés)...`);
  // Utilise -in:sent au lieu de in:inbox pour capturer aussi les emails archivés
  const inboxIds = await listMessageIds(accessToken, `-in:sent -in:trash -in:spam after:${sinceStr}`, 80000);
  console.log(`  ${inboxIds.length} reçus IDs`);

  // Dédoublonne (rare mais possible)
  const allIds = [...new Set([...sentIds, ...inboxIds])];
  console.log(`\n🔄 ${allIds.length} IDs uniques au total`);

  console.log(`\n📦 3. Fetch metadata + filtre par Pipedrive emails (peut prendre 10-30 min)...`);
  const writeStream = fs.createWriteStream(OUT_FILE, { encoding: 'utf8' });
  let kept = 0, skipped = 0, errors = 0, processed = 0;
  const contactStats = new Map();
  const startTime = Date.now();

  // Token expire après 1h → refresh tous les ~3000 calls
  const REFRESH_EVERY = 3000;

  for (const id of allIds) {
    processed++;
    if (processed % REFRESH_EVERY === 0) {
      try { accessToken = await getAccessToken(); } catch (e) { console.error('refresh err:', e.message); }
    }

    try {
      const msg = await getMessageMeta(accessToken, id);
      const payload = msg.payload || {};
      const from = getHeader(payload, 'From');
      const to = getHeader(payload, 'To');
      const cc = getHeader(payload, 'Cc');
      const subject = getHeader(payload, 'Subject');
      const date = getHeader(payload, 'Date');

      // Tous les emails dans From/To/Cc
      const allEmails = [...extractEmails(from), ...extractEmails(to), ...extractEmails(cc)];
      const matchedEmails = allEmails.filter(e => emailSet.has(e));
      if (!matchedEmails.length) { skipped++; continue; }

      const contact = emailToContact.get(matchedEmails[0]);
      const isFromMe = from.toLowerCase().includes('shawn@signaturesb.com');

      const entry = {
        ts: date ? new Date(date).toISOString() : null,
        from_me: isFromMe,
        from,
        to,
        subject,
        snippet: msg.snippet || '',
        labelIds: msg.labelIds || [],
        threadId: msg.threadId,
        gmailId: id,
        pipedrive_id: contact.id,
        pipedrive_name: contact.name,
        matched_email: matchedEmails[0]
      };
      writeStream.write(JSON.stringify(entry) + '\n');
      kept++;
      contactStats.set(contact.id, (contactStats.get(contact.id) || 0) + 1);
    } catch (e) {
      errors++;
      if (errors < 5) console.error(`  err id=${id}: ${e.message}`);
    }

    if (processed % 200 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const eta = Math.round((allIds.length - processed) / rate);
      process.stdout.write(`    ${processed}/${allIds.length} processed · ${kept} matched · ETA ${Math.floor(eta/60)}m${eta%60}s\r`);
    }
  }

  await new Promise(rs => writeStream.end(rs));

  console.log(`\n\n✓ Terminé en ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.log(`  ${kept} emails indexés (${skipped} skippés · ${errors} erreurs)`);
  console.log(`  ${contactStats.size} contacts Pipedrive avec historique Gmail`);

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastRun: new Date().toISOString(),
    kept, skipped, errors,
    contactsCount: contactStats.size
  }, null, 2));

  const stat = fs.statSync(OUT_FILE);
  console.log(`\nFichier: ${OUT_FILE}`);
  console.log(`Taille: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

if (require.main === module) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}
