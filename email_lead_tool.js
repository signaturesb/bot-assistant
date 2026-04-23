// email_lead_tool.js
// Outil: traiter_lead_email
// Flow: Gmail (ID ou recherche sujet) → extraction infos → Dropbox match Centris/rue → Pipedrive deal → envoi docs → Telegram *
// Appelé par Claude via tool_use OU par le Gmail Poller automatiquement.
'use strict';

const { parseLeadEmail, parseLeadEmailWithAI, detectLeadSource, isJunkLeadEmail } = require('./lead_parser');

// ─── Gmail: lire un email par ID ou chercher par sujet/query ─────────────────
async function gmailFetchEmail({ messageId, query, gmailTokens, log }) {
  const _log = log || (() => {});
  if (!gmailTokens?.access_token) { _log('WARN', 'LEAD', 'Pas de token Gmail'); return null; }

  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const headers = { Authorization: `Bearer ${gmailTokens.access_token}` };

  // Si on a un ID direct → fetch direct
  if (messageId) {
    const r = await fetch(`${base}/messages/${messageId}?format=full`, { headers });
    if (!r.ok) { _log('WARN', 'LEAD', `Gmail fetch ${messageId}: ${r.status}`); return null; }
    return await r.json();
  }

  // Sinon → search
  if (!query) { _log('WARN', 'LEAD', 'gmailFetchEmail: messageId ou query requis'); return null; }
  const q = encodeURIComponent(query);
  const listR = await fetch(`${base}/messages?q=${q}&maxResults=5`, { headers });
  if (!listR.ok) { _log('WARN', 'LEAD', `Gmail search: ${listR.status}`); return null; }
  const list = await listR.json();
  if (!list.messages?.length) { _log('INFO', 'LEAD', `Aucun email trouvé pour: ${query}`); return null; }

  // Prendre le plus récent (premier de la liste)
  const r2 = await fetch(`${base}/messages/${list.messages[0].id}?format=full`, { headers });
  if (!r2.ok) return null;
  return await r2.json();
}

// ─── Décoder un email Gmail (headers + body) ─────────────────────────────────
function decodeGmailMessage(msg) {
  if (!msg) return { subject: '', from: '', body: '', date: '' };

  const headers = msg.payload?.headers || [];
  const h = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  // Extraire le body (text/plain préféré, sinon text/html)
  function extractBody(payload) {
    if (!payload) return '';
    const mime = payload.mimeType || '';

    if (mime === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (mime === 'text/html' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    // multipart — chercher text/plain d'abord, puis text/html
    if (payload.parts?.length) {
      const plain = payload.parts.find(p => p.mimeType === 'text/plain');
      if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64').toString('utf-8');
      const html = payload.parts.find(p => p.mimeType === 'text/html');
      if (html?.body?.data) return Buffer.from(html.body.data, 'base64').toString('utf-8');
      // Récursif pour multipart imbriqués
      for (const part of payload.parts) {
        const sub = extractBody(part);
        if (sub) return sub;
      }
    }
    return '';
  }

  return {
    subject: h('subject'),
    from:    h('from'),
    to:      h('to'),
    date:    h('date'),
    body:    extractBody(msg.payload),
    id:      msg.id,
    threadId: msg.threadId,
  };
}

// ─── Dropbox: chercher le dossier terrain par Centris# ou rue ─────────────────
async function dropboxFindListing({ centris, adresse, dbxToken, log }) {
  const _log = log || (() => {});
  if (!dbxToken) { _log('WARN', 'LEAD', 'Pas de token Dropbox'); return null; }

  // Lister /Terrain en ligne/
  let folders = [];
  try {
    const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dbxToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Terrain en ligne', recursive: false }),
    });
    if (!r.ok) { _log('WARN', 'LEAD', `Dropbox list: ${r.status}`); return null; }
    const data = await r.json();
    folders = data.entries?.filter(e => e['.tag'] === 'folder') || [];
  } catch (e) { _log('ERR', 'LEAD', `Dropbox list error: ${e.message}`); return null; }

  if (!folders.length) return null;

  // 1. Match par Centris# (priorité absolue — zéro ambiguïté)
  if (centris) {
    const hit = folders.find(f => f.name.includes(centris));
    if (hit) {
      _log('OK', 'LEAD', `Dropbox match Centris# ${centris} → ${hit.name}`);
      return hit;
    }
  }

  // 2. Match par adresse/rue (normaliser: lowercase, enlever accents, ignorer numéros civiques)
  if (adresse) {
    const norm = (s) => s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const addrNorm = norm(adresse);
    // Extraire mots significatifs (>3 chars, pas les numéros civiques seuls)
    const words = addrNorm.split(' ').filter(w => w.length > 3 && !/^\d+$/.test(w));

    let bestFolder = null;
    let bestScore = 0;
    for (const f of folders) {
      const fNorm = norm(f.name);
      let score = 0;
      for (const w of words) { if (fNorm.includes(w)) score++; }
      if (score > bestScore) { bestScore = score; bestFolder = f; }
    }
    if (bestScore >= 1 && bestFolder) {
      _log('OK', 'LEAD', `Dropbox match adresse (score=${bestScore}) → ${bestFolder.name}`);
      return bestFolder;
    }
  }

  _log('INFO', 'LEAD', `Aucun dossier Dropbox trouvé pour centris=${centris} adresse=${adresse}`);
  return null;
}

// ─── Dropbox: lister les PDFs d'un dossier ────────────────────────────────────
async function dropboxListPDFs({ folderPath, dbxToken, log }) {
  const _log = log || (() => {});
  try {
    const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dbxToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath, recursive: false }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.entries || []).filter(e => e['.tag'] === 'file' && e.name.toLowerCase().endsWith('.pdf'));
  } catch { return []; }
}

// ─── Dropbox: obtenir un lien temporaire pour un fichier ──────────────────────
async function dropboxTempLink({ filePath, dbxToken }) {
  try {
    const r = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dbxToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.link || null;
  } catch { return null; }
}

// ─── Pipedrive: vérifier doublons ─────────────────────────────────────────────
async function pipedriveFindDuplicate({ email, telephone, pdKey, log }) {
  const _log = log || (() => {});
  if (!pdKey) return null;

  const base = 'https://api.pipedrive.com/v1';
  const cleanTel = (telephone || '').replace(/\D/g, '');

  // Chercher par email
  if (email) {
    try {
      const r = await fetch(`${base}/persons/search?term=${encodeURIComponent(email)}&fields=email&api_token=${pdKey}`);
      if (r.ok) {
        const d = await r.json();
        if (d.data?.items?.length) {
          _log('WARN', 'LEAD', `Doublon email trouvé: ${email}`);
          return d.data.items[0].item;
        }
      }
    } catch {}
  }

  // Chercher par téléphone
  if (cleanTel?.length >= 10) {
    try {
      const r = await fetch(`${base}/persons/search?term=${encodeURIComponent(cleanTel)}&fields=phone&api_token=${pdKey}`);
      if (r.ok) {
        const d = await r.json();
        if (d.data?.items?.length) {
          _log('WARN', 'LEAD', `Doublon tel trouvé: ${cleanTel}`);
          return d.data.items[0].item;
        }
      }
    } catch {}
  }

  return null;
}

// ─── Pipedrive: créer personne + deal ─────────────────────────────────────────
async function pipedriveCreateDeal({ prenom, nom, email, telephone, centris, adresse, type, source, note, pdKey, pdPipelineId, pdFieldType, pdFieldSource, pdFieldCentris, pdFieldSeq, pdTypeMap, log }) {
  const _log = log || (() => {});
  if (!pdKey) { _log('WARN', 'LEAD', 'Pas de clé Pipedrive'); return null; }

  const base = 'https://api.pipedrive.com/v1';
  const fullNom = [prenom, nom].filter(Boolean).join(' ');

  // 1. Créer la personne
  const personBody = {
    name: fullNom || 'Prospect',
    ...(email    ? { email:    [{ value: email,    primary: true }] } : {}),
    ...(telephone ? { phone:   [{ value: telephone, primary: true }] } : {}),
  };
  let personId = null;
  try {
    const r = await fetch(`${base}/persons?api_token=${pdKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personBody),
    });
    const d = await r.json();
    personId = d.data?.id;
    _log('OK', 'LEAD', `Pipedrive personne créée: ${fullNom} (ID ${personId})`);
  } catch (e) { _log('ERR', 'LEAD', `Pipedrive personne: ${e.message}`); }

  // 2. Créer le deal
  const typeId = (pdTypeMap || {})[type] || (pdTypeMap || {})['terrain'] || 37;
  const dealTitle = `${fullNom || 'Prospect'} — ${type?.replace(/_/g, ' ') || 'terrain'}${centris ? ` (#${centris})` : ''}`;

  const dealBody = {
    title:       dealTitle,
    pipeline_id: pdPipelineId || 7,
    stage_id:    49, // Nouveau lead
    ...(personId ? { person_id: personId } : {}),
    [pdFieldType   || 'd8961ad7b8b9bf9866befa49ff2afae58f9a888e']: typeId,
    [pdFieldSource || 'df69049da6f662bee6a3211068b993f6e465da71']: source || 'centris',
    [pdFieldCentris|| '22d305edf31135fc455a032e81582b98afc80104']: centris || '',
    [pdFieldSeq    || '17a20076566919bff80b59f06866251ed250fcab']: true, // Séquence active
  };

  let dealId = null;
  try {
    const r = await fetch(`${base}/deals?api_token=${pdKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dealBody),
    });
    const d = await r.json();
    dealId = d.data?.id;
    _log('OK', 'LEAD', `Pipedrive deal créé: ${dealTitle} (ID ${dealId})`);
  } catch (e) { _log('ERR', 'LEAD', `Pipedrive deal: ${e.message}`); }

  // 3. Ajouter la note
  if (dealId && note) {
    try {
      await fetch(`${base}/notes?api_token=${pdKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deal_id: dealId, content: note }),
      });
      _log('OK', 'LEAD', `Note Pipedrive ajoutée`);
    } catch {}
  }

  return { dealId, personId, dealTitle };
}

// ─── Gmail: envoyer email avec pièce jointe PDF (base64) ──────────────────────
async function gmailSendWithAttachment({ to, toName, subject, bodyText, pdfBuffer, pdfFilename, gmailTokens, fromEmail, log }) {
  const _log = log || (() => {});
  if (!gmailTokens?.access_token) { _log('WARN', 'LEAD', 'Pas de token Gmail pour envoi'); return false; }

  // Construire le MIME multipart
  const boundary = `----=_Part_${Date.now()}`;
  const toHeader = toName ? `"${toName}" <${to}>` : to;

  let mime = [
    `From: Shawn Barrette <${fromEmail || 'shawn@signaturesb.com'}>`,
    `To: ${toHeader}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    bodyText,
  ].join('\r\n');

  if (pdfBuffer && pdfFilename) {
    const b64 = pdfBuffer.toString('base64');
    mime += [
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf; name="${pdfFilename}"`,
      `Content-Disposition: attachment; filename="${pdfFilename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    mime += `\r\n--${boundary}--`;
  }

  const encoded = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  try {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${gmailTokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });
    if (!r.ok) {
      const err = await r.text();
      _log('ERR', 'LEAD', `Gmail send: ${r.status} ${err.substring(0, 200)}`);
      return false;
    }
    _log('OK', 'LEAD', `Email envoyé à ${to}`);
    return true;
  } catch (e) { _log('ERR', 'LEAD', `Gmail send error: ${e.message}`); return false; }
}

// ─── Dropbox: télécharger un fichier (retourne Buffer) ────────────────────────
async function dropboxDownloadFile({ filePath, dbxToken, log }) {
  const _log = log || (() => {});
  try {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dbxToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: filePath }),
      },
    });
    if (!r.ok) { _log('WARN', 'LEAD', `Dropbox download ${filePath}: ${r.status}`); return null; }
    const buf = await r.arrayBuffer();
    return Buffer.from(buf);
  } catch (e) { _log('ERR', 'LEAD', `Dropbox download: ${e.message}`); return null; }
}

// ════════════════════════════════════════════════════════════════════════════════
// FONCTION PRINCIPALE: traiterLeadEmail
// ════════════════════════════════════════════════════════════════════════════════
async function traiterLeadEmail({ messageId, query, gmailTokens, dbxToken, pdKey, apiKey, pdConfig, log, sendTelegram }) {
  const _log = log || console.log.bind(console);
  const _tg  = sendTelegram || null;

  _log('INFO', 'LEAD', `traiterLeadEmail start — messageId=${messageId} query=${query}`);

  // ── 1. Récupérer l'email Gmail ──────────────────────────────────────────────
  const rawMsg = await gmailFetchEmail({ messageId, query, gmailTokens, log: _log });
  if (!rawMsg) {
    const err = `❌ Email introuvable (messageId=${messageId} query=${query})`;
    _log('ERR', 'LEAD', err);
    if (_tg) await _tg(err);
    return { ok: false, error: 'email_not_found' };
  }

  const decoded = decodeGmailMessage(rawMsg);
  const { subject, from, body, date } = decoded;

  _log('INFO', 'LEAD', `Email décodé: "${subject}" de ${from}`);

  // ── 2. Vérifier que c'est pas du junk ──────────────────────────────────────
  if (isJunkLeadEmail(subject, from, body)) {
    _log('INFO', 'LEAD', `Email junk ignoré: "${subject}"`);
    return { ok: false, error: 'junk_email' };
  }

  // ── 3. Extraire les infos du prospect (regex + AI fallback) ─────────────────
  let info = parseLeadEmail(body, subject, from);

  // Compter les champs extraits
  const extracted = [info.nom, info.telephone, info.email, info.centris].filter(Boolean).length;
  _log('INFO', 'LEAD', `Regex: nom="${info.nom}" tel="${info.telephone}" email="${info.email}" centris="${info.centris}" addr="${info.adresse}" (${extracted}/4 champs)`);

  // AI fallback si moins de 2 champs extraits
  if (extracted < 2 && apiKey) {
    _log('INFO', 'LEAD', `Fallback AI (seulement ${extracted} champs par regex)...`);
    info = await parseLeadEmailWithAI(body, subject, from, info, { apiKey, logger: _log });
    _log('INFO', 'LEAD', `Post-AI: nom="${info.nom}" tel="${info.telephone}" email="${info.email}" centris="${info.centris}"`);
  }

  // ── 4. Séparer prénom/nom ────────────────────────────────────────────────────
  const parts  = (info.nom || '').trim().split(/\s+/);
  const prenom = parts[0] || '';
  const nom    = parts.slice(1).join(' ') || '';

  // ── 5. Détecter la source ────────────────────────────────────────────────────
  const sourceDetect = detectLeadSource(from, subject);
  const source = sourceDetect?.source || 'centris';

  // ── 6. Vérifier doublons Pipedrive ──────────────────────────────────────────
  let doublon = null;
  if (pdKey) {
    doublon = await pipedriveFindDuplicate({ email: info.email, telephone: info.telephone, pdKey, log: _log });
  }

  let dealResult = null;
  let pipedriveStatus = '';

  if (doublon) {
    pipedriveStatus = `⚠️ Doublon détecté (${doublon.name}) — deal non créé`;
    _log('WARN', 'LEAD', `Doublon Pipedrive: ${doublon.name}`);
  } else {
    // ── 7. Créer deal Pipedrive ──────────────────────────────────────────────
    const noteContent = [
      `📧 Lead entrant — ${sourceDetect?.label || 'Email'}`,
      `📅 ${date || new Date().toLocaleDateString('fr-CA')}`,
      info.centris ? `🏡 Centris# ${info.centris}` : '',
      info.adresse ? `📍 ${info.adresse}` : '',
      `📧 ${info.email || 'N/A'} | 📞 ${info.telephone || 'N/A'}`,
    ].filter(Boolean).join('\n');

    dealResult = await pipedriveCreateDeal({
      prenom, nom,
      email:     info.email,
      telephone: info.telephone,
      centris:   info.centris,
      adresse:   info.adresse,
      type:      info.type,
      source,
      note:      noteContent,
      pdKey,
      pdPipelineId: pdConfig?.pipelineId || 7,
      pdFieldType:  pdConfig?.fieldType,
      pdFieldSource:pdConfig?.fieldSource,
      pdFieldCentris:pdConfig?.fieldCentris,
      pdFieldSeq:   pdConfig?.fieldSeq,
      pdTypeMap:    pdConfig?.typeMap,
      log: _log,
    });
    pipedriveStatus = dealResult?.dealId
      ? `✅ Deal créé (ID ${dealResult.dealId})`
      : `❌ Erreur création deal`;
  }

  // ── 8. Matcher dossier Dropbox ───────────────────────────────────────────────
  let dropboxFolder = null;
  let docsStatus = '⏭️ Aucun dossier Dropbox trouvé';

  if (dbxToken) {
    dropboxFolder = await dropboxFindListing({
      centris: info.centris,
      adresse: info.adresse,
      dbxToken,
      log: _log,
    });
  }

  // ── 9. Envoyer les docs si email prospect dispo + dossier trouvé ─────────────
  let pdfSent = false;
  let pdfName = '';

  if (dropboxFolder && info.email && gmailTokens?.access_token) {
    const pdfs = await dropboxListPDFs({ folderPath: dropboxFolder.path_display, dbxToken, log: _log });

    if (pdfs.length) {
      // Prendre le premier PDF (fiche principale)
      const pdf = pdfs[0];
      pdfName = pdf.name;
      const pdfBuf = await dropboxDownloadFile({ filePath: pdf.path_display, dbxToken, log: _log });

      if (pdfBuf) {
        const emailSubject = `Information — ${info.adresse || dropboxFolder.name.replace(/_/g, ' ')}`;
        const emailBody = [
          `Bonjour,`,
          ``,
          `Merci pour votre intérêt. Veuillez trouver ci-joint l'information concernant la propriété.`,
          ``,
          `N'hésitez pas si vous avez des questions.`,
          ``,
          `Au plaisir,`,
          `Shawn Barrette`,
          `RE/MAX PRESTIGE | 514-927-1340`,
          `signatureSB.com`,
        ].join('\n');

        pdfSent = await gmailSendWithAttachment({
          to:          info.email,
          toName:      info.nom || prenom,
          subject:     emailSubject,
          bodyText:    emailBody,
          pdfBuffer:   pdfBuf,
          pdfFilename: pdfName,
          gmailTokens,
          fromEmail:   'shawn@signaturesb.com',
          log: _log,
        });

        docsStatus = pdfSent
          ? `✅ Docs envoyés: ${pdfName}`
          : `❌ Erreur envoi docs`;
      }
    } else {
      docsStatus = `📁 Dossier trouvé (${dropboxFolder.name}) — aucun PDF`;
    }
  } else if (!dropboxFolder) {
    docsStatus = info.centris
      ? `❌ Dossier introuvable pour Centris# ${info.centris}`
      : `⚠️ Pas de Centris# — match impossible`;
  } else if (!info.email) {
    docsStatus = `⚠️ Email prospect absent — docs non envoyés`;
  }

  // ── 10. Confirmation Telegram ─────────────────────────────────────────────────
  const msg = [
    `🔔 *Nouveau lead entrant*`,
    ``,
    `👤 ${info.nom || '(nom manquant)'}`,
    `📞 ${info.telephone || '(tel manquant)'}`,
    `📧 ${info.email || '(email manquant)'}`,
    `🏡 Centris# ${info.centris || 'N/A'} | ${info.type?.replace(/_/g, ' ') || 'terrain'}`,
    info.adresse ? `📍 ${info.adresse}` : '',
    `📬 Source: ${sourceDetect?.label || source}`,
    ``,
    `🗂️ Pipedrive: ${pipedriveStatus}`,
    `📄 Docs: ${docsStatus}`,
    ``,
    `*`,
  ].filter(s => s !== '').join('\n');

  if (_tg) {
    await _tg(msg);
    _log('OK', 'LEAD', `Telegram notifié`);
  }

  return {
    ok: true,
    prospect: { prenom, nom, email: info.email, telephone: info.telephone, centris: info.centris, adresse: info.adresse, type: info.type },
    deal: dealResult,
    doublon: doublon ? { name: doublon.name } : null,
    dropbox: dropboxFolder ? { name: dropboxFolder.name, path: dropboxFolder.path_display } : null,
    pdfSent,
    pdfName,
    telegramMsg: msg,
  };
}

module.exports = {
  traiterLeadEmail,
  gmailFetchEmail,
  decodeGmailMessage,
  dropboxFindListing,
  dropboxListPDFs,
  dropboxDownloadFile,
  dropboxTempLink,
  pipedriveFindDuplicate,
  pipedriveCreateDeal,
  gmailSendWithAttachment,
};
