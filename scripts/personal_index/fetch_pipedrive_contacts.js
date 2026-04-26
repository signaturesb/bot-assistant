// fetch_pipedrive_contacts.js — Fetch tous les contacts Pipedrive (phones + emails)
// pour servir de filtre aux scrapers iMessage + Gmail.
// Output: data/pipedrive_contacts.json

require('dotenv').config({ path: __dirname + '/../../../mailing-masse/.env' });
const fs = require('fs');
const path = require('path');

const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY;
if (!PIPEDRIVE_API_KEY) {
  console.error('❌ PIPEDRIVE_API_KEY manquant');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const OUT_FILE = path.join(DATA_DIR, 'pipedrive_contacts.json');

// Normalise un numéro de téléphone pour matching
// Ex: "514-927-1340" → "5149271340", "+1 (514) 927-1340" → "5149271340"
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  // Garde les 10 derniers digits (format NA)
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === '1') return digits.substring(1);
  if (digits.length >= 10) return digits.substring(digits.length - 10);
  return null;
}

async function fetchAllPersons() {
  const persons = [];
  let start = 0;
  const limit = 500;
  let more = true;

  while (more) {
    const url = `https://api.pipedrive.com/v1/persons?api_token=${PIPEDRIVE_API_KEY}&start=${start}&limit=${limit}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Pipedrive ${r.status}`);
    const j = await r.json();
    if (!j.success) throw new Error('Pipedrive: success=false');
    const data = j.data || [];
    persons.push(...data);
    more = j.additional_data?.pagination?.more_items_in_collection || false;
    start = j.additional_data?.pagination?.next_start || (start + limit);
    process.stdout.write(`  ${persons.length} contacts...\r`);
  }
  return persons;
}

async function main() {
  console.log('📞 Fetch contacts Pipedrive...');
  const persons = await fetchAllPersons();
  console.log(`\n✓ ${persons.length} contacts récupérés`);

  // Normalise + dédoublonne
  const phoneMap = new Map();   // phone (normalized) → person summary
  const emailMap = new Map();   // email (lowercased) → person summary

  for (const p of persons) {
    const id = p.id;
    const name = p.name || `Person #${id}`;

    // Phones: peut être array d'objets { value, label, primary }
    const phones = Array.isArray(p.phone) ? p.phone : [];
    for (const ph of phones) {
      const norm = normalizePhone(ph.value || ph);
      if (norm) {
        if (!phoneMap.has(norm)) phoneMap.set(norm, { id, name, phone: norm, raw: ph.value || ph });
      }
    }

    // Emails: même structure (peut être { value: "x@y" } ou string ou null)
    const emails = Array.isArray(p.email) ? p.email : [];
    for (const em of emails) {
      let val = '';
      if (em && typeof em === 'object') val = String(em.value || '');
      else if (typeof em === 'string') val = em;
      val = val.toLowerCase().trim();
      if (val && val.includes('@')) {
        if (!emailMap.has(val)) emailMap.set(val, { id, name, email: val });
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    totalPersons: persons.length,
    uniquePhones: phoneMap.size,
    uniqueEmails: emailMap.size,
    phones: Array.from(phoneMap.values()),
    emails: Array.from(emailMap.values()),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\n📊 Stats:`);
  console.log(`   ${out.totalPersons} persons Pipedrive`);
  console.log(`   ${out.uniquePhones} numéros uniques (normalisés 10 digits)`);
  console.log(`   ${out.uniqueEmails} emails uniques`);
  console.log(`\n✓ Sauvegardé: ${OUT_FILE}`);
}

if (require.main === module) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { normalizePhone };
