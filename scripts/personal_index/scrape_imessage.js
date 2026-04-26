// scrape_imessage.js — Scraper chat.db iMessage avec filtre Pipedrive
//
// Lit ~/Library/Messages/chat.db en read-only (Full Disk Access requis).
// Filtre par numéros qui matchent Pipedrive contacts.
// Output: data/imessage_index.jsonl (1 message / ligne)

require('dotenv').config({ path: __dirname + '/../../../mailing-masse/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const CHAT_DB = path.join(os.homedir(), 'Library/Messages/chat.db');
const DATA_DIR = path.join(__dirname, 'data');
const PIPEDRIVE_FILE = path.join(DATA_DIR, 'pipedrive_contacts.json');
const OUT_FILE = path.join(DATA_DIR, 'imessage_index.jsonl');

// Charge contacts Pipedrive
if (!fs.existsSync(PIPEDRIVE_FILE)) {
  console.error('❌ pipedrive_contacts.json manquant — run fetch_pipedrive_contacts.js d\'abord');
  process.exit(1);
}
const pipedrive = JSON.parse(fs.readFileSync(PIPEDRIVE_FILE, 'utf8'));
const phoneSet = new Set(pipedrive.phones.map(p => p.phone));
const phoneToContact = new Map(pipedrive.phones.map(p => [p.phone, p]));
console.log(`📚 ${phoneSet.size} numéros Pipedrive comme filtre`);

// Vérifie chat.db
if (!fs.existsSync(CHAT_DB)) {
  console.error('❌ chat.db introuvable. Active iPhone SMS Forwarding.');
  process.exit(1);
}
try {
  execSync(`sqlite3 -readonly "${CHAT_DB}" "SELECT 1;"`, { stdio: 'pipe' });
} catch {
  console.error('❌ chat.db lecture refusée — Full Disk Access manquant pour ton terminal/Node.js');
  console.error('   System Settings → Privacy & Security → Full Disk Access → ajouter Terminal + Node');
  process.exit(1);
}

function normPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === '1') return digits.substring(1);
  if (digits.length >= 10) return digits.substring(digits.length - 10);
  return null;
}

// Apple stocke message.date en nanosecondes depuis 2001-01-01 UTC
const APPLE_EPOCH_OFFSET = 978307200; // seconds entre 1970 et 2001
function appleDateToISO(appleDate) {
  if (!appleDate) return null;
  // post-iOS 11: nanoseconds. pre: seconds.
  const seconds = appleDate > 1e10 ? appleDate / 1e9 : appleDate;
  const unixSec = APPLE_EPOCH_OFFSET + seconds;
  return new Date(unixSec * 1000).toISOString();
}

// Fetch tous les messages avec handle (numéro/email du correspondant)
function scrapeMessages() {
  console.log(`🔍 Query chat.db (363k+ messages, ~1-2 min)...`);
  // Note: utilise -separator chr(31) pour éviter conflicts avec | dans le texte
  const SEP = String.fromCharCode(31);
  // Pour les messages OUTGOING (is_from_me=1), m.handle_id est NULL.
  // On résout le destinataire via chat_message_join → chat → chat_handle_join → handle.
  // COALESCE prend le handle direct si dispo, sinon le handle du chat.
  const query = `
    SELECT
      m.ROWID,
      COALESCE(h_msg.id, h_chat.id),
      m.date,
      m.is_from_me,
      m.text,
      m.service
    FROM message m
    LEFT JOIN handle h_msg ON m.handle_id = h_msg.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    LEFT JOIN handle h_chat ON h_chat.ROWID = chj.handle_id
    WHERE m.text IS NOT NULL AND length(m.text) > 0
    ORDER BY m.date DESC;
  `.replace(/\n/g, ' ').replace(/\s+/g, ' ');

  const cmd = `sqlite3 -readonly -separator '${SEP}' "${CHAT_DB}" "${query}"`;
  const result = execSync(cmd, { maxBuffer: 500 * 1024 * 1024, encoding: 'utf8' });
  const lines = result.split('\n').filter(Boolean);
  console.log(`  → ${lines.length} messages bruts dans chat.db`);
  return lines.map(line => {
    const parts = line.split(SEP);
    return {
      rowid: parts[0],
      handle: parts[1] || '',
      date_apple: parts[2],
      is_from_me: parts[3] === '1',
      text: parts.slice(4, -1).join(SEP), // text peut contenir le séparateur (rare mais safe)
      service: parts[parts.length - 1] || 'iMessage'
    };
  });
}

async function main() {
  const messages = scrapeMessages();

  let writeStream = fs.createWriteStream(OUT_FILE, { encoding: 'utf8' });
  let totalKept = 0;
  let totalSkipped = 0;
  const contactStats = new Map(); // phone → count
  const seenRowids = new Set(); // dédup: même message dans plusieurs chats group

  for (const m of messages) {
    if (!m.handle) { totalSkipped++; continue; }
    if (seenRowids.has(m.rowid)) { totalSkipped++; continue; }
    const norm = normPhone(m.handle);
    // Email iMessage handles: aussi possible
    const isEmail = m.handle.includes('@');
    let contact = null;
    if (norm && phoneSet.has(norm)) {
      contact = phoneToContact.get(norm);
    } else if (isEmail) {
      // pourrait matcher emailMap mais on garde par phone uniquement pour cette phase
      totalSkipped++;
      continue;
    } else {
      totalSkipped++;
      continue;
    }

    const entry = {
      ts: appleDateToISO(parseFloat(m.date_apple)),
      from_me: m.is_from_me,
      service: m.service,
      handle: m.handle,
      pipedrive_id: contact.id,
      pipedrive_name: contact.name,
      text: m.text
    };
    writeStream.write(JSON.stringify(entry) + '\n');
    seenRowids.add(m.rowid);
    totalKept++;
    contactStats.set(norm, (contactStats.get(norm) || 0) + 1);
  }

  await new Promise(resolve => writeStream.end(resolve));
  console.log(`\n✓ ${totalKept} messages indexés (${totalSkipped} skippés — pas dans Pipedrive)`);
  console.log(`✓ ${contactStats.size} contacts Pipedrive avec historique iMessage`);
  console.log(`\nTop 10 contacts par volume:`);
  const sorted = [...contactStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [phone, count] of sorted) {
    const c = phoneToContact.get(phone);
    console.log(`  ${count.toString().padStart(5)} msgs · ${c.name} (${c.raw})`);
  }
  console.log(`\nFichier: ${OUT_FILE}`);
  const stat = fs.statSync(OUT_FILE);
  console.log(`Taille: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

if (require.main === module) {
  main();
}
