# PATCH — Intégration `traiter_lead_email` dans bot.js

## Fichier créé: `email_lead_tool.js` ✅ (déjà dans le repo)

## 3 modifications à faire dans `bot.js`

---

### MODIFICATION 1 — require en haut du fichier
**Après la ligne:** `const leadParser = require('./lead_parser');`
**Ajouter:**
```js
const emailLeadTool = require('./email_lead_tool');
```

---

### MODIFICATION 2 — Définition de l'outil Claude
**Dans le tableau `tools` passé à l'API Anthropic** (chercher `{ name: 'voir_emails_recents'` ou `{ name: 'creer_deal'`),
**Ajouter l'entrée suivante dans le tableau:**

```js
{
  name: 'traiter_lead_email',
  description: 'Ouvre un email Gmail par ID ou recherche, extrait les infos prospect (nom/tel/email/Centris), trouve le dossier Dropbox, crée le deal Pipedrive et envoie les docs. Utiliser quand Shawn dit "traite le lead de [nom/sujet]" ou "ouvre le dernier email Centris et traite-le".',
  input_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'ID Gmail du message à traiter (optionnel si query fourni)',
      },
      query: {
        type: 'string',
        description: 'Recherche Gmail pour trouver l\'email (ex: "from:centris.ca" ou "subject:demande terrain"). Utilisé si messageId absent.',
      },
    },
    required: [],
  },
},
```

---

### MODIFICATION 3 — Handler dans toolHandlers
**Dans l'objet/switch `toolHandlers`** (chercher `case 'voir_emails_recents':` ou `'creer_deal':`),
**Ajouter:**

```js
case 'traiter_lead_email': {
  const { messageId, query } = toolInput;
  
  // Injecter la fonction sendTelegram pour la notif finale
  const sendTelegramMsg = async (msg) => {
    try {
      await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' });
    } catch(e) {
      await bot.sendMessage(ALLOWED_ID, msg.replace(/[*_`]/g, '')).catch(()=>{});
    }
  };

  // Récupérer les tokens depuis les fonctions existantes du bot
  const gTokens = await getGmailTokens().catch(() => null);
  const dbxTok  = await getDropboxToken().catch(() => null);

  const result = await emailLeadTool.traiterLeadEmail({
    messageId,
    query: query || 'from:centris.ca OR from:remax.ca subject:demande newer_than:1d',
    gmailTokens: gTokens,
    dbxToken:    dbxTok,
    pdKey:       PD_KEY,
    apiKey:      API_KEY,
    pdConfig: {
      pipelineId:  AGENT.pipeline_id,
      fieldType:   PD_FIELD_TYPE,
      fieldSource: PD_FIELD_SOURCE,
      fieldCentris:PD_FIELD_CENTRIS,
      fieldSeq:    PD_FIELD_SEQ,
      typeMap:     PD_TYPE_MAP,
    },
    log,
    sendTelegram: sendTelegramMsg,
  });

  if (!result.ok) {
    toolResult = `❌ ${result.error === 'email_not_found' ? 'Email introuvable' : result.error === 'junk_email' ? 'Email non pertinent (junk)' : result.error}`;
  } else {
    const p = result.prospect;
    toolResult = [
      `✅ Lead traité`,
      `👤 ${p.prenom} ${p.nom} | 📞 ${p.telephone || 'N/A'} | 📧 ${p.email || 'N/A'}`,
      `🏡 Centris# ${p.centris || 'N/A'} — ${p.type?.replace(/_/g,' ')}`,
      result.doublon ? `⚠️ Doublon: ${result.doublon.name}` : `🗂️ Deal ID: ${result.deal?.dealId || 'N/A'}`,
      result.dropbox ? `📁 Dossier: ${result.dropbox.name}` : `📁 Aucun dossier Dropbox`,
      result.pdfSent ? `📧 Docs envoyés: ${result.pdfName}` : `📄 Docs non envoyés`,
    ].join('\n');
  }
  break;
}
```

---

### MODIFICATION 4 — Intégration dans le Gmail Poller (automatique)
**Dans la fonction `processLeadEmail` ou `gmailPoller`** (chercher `processLeadEmail` ou `LEAD_EMAIL_PATTERNS`),
**Remplacer l'appel actuel de création de deal par:**

```js
// Au lieu de construire le deal manuellement dans le poller,
// déléguer à emailLeadTool pour le flow complet:
const sendTg = async (msg) => bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' }).catch(()=>{});
await emailLeadTool.traiterLeadEmail({
  messageId: msg.id,  // L'ID du message Gmail déjà trouvé par le poller
  gmailTokens: currentGmailTokens,
  dbxToken: await getDropboxToken().catch(()=>null),
  pdKey: PD_KEY,
  apiKey: API_KEY,
  pdConfig: {
    pipelineId: AGENT.pipeline_id,
    fieldType: PD_FIELD_TYPE,
    fieldSource: PD_FIELD_SOURCE,
    fieldCentris: PD_FIELD_CENTRIS,
    fieldSeq: PD_FIELD_SEQ,
    typeMap: PD_TYPE_MAP,
  },
  log,
  sendTelegram: sendTg,
});
// → Plus besoin de créer le deal manuellement dans le poller
```

---

## TESTS À FAIRE avant deploy

```bash
# 1. Vérifier syntax
node -c bot.js
node -c email_lead_tool.js

# 2. Test unitaire email_lead_tool seul
node -e "
const t = require('./email_lead_tool');
// Test parseLeadEmail simulé (déjà dans lead_parser mais tester le flow complet)
console.log('email_lead_tool chargé OK');
"

# 3. Test avec un email réel (Centris)
# Dans Telegram: "traite le dernier email Centris"
```

---

## RÉSULTAT ATTENDU dans Telegram

```
🔔 *Nouveau lead entrant*

👤 Jean Tremblay
📞 4501234567
📧 jean.tremblay@gmail.com
🏡 Centris# 12345678 | terrain
📍 123 Rue Sarine, Rawdon
📬 Source: Centris.ca

🗂️ Pipedrive: ✅ Deal créé (ID 456)
📄 Docs: ✅ Docs envoyés: Fiche_terrain_Rue_Sarine.pdf

*
```
