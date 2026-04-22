# 🔒 PROTOCOLE ANTI-DOUBLONS — Pipedrive + Gmail + Brevo

**Demandé par Shawn — 2026-04-22**
**Règle absolue:** Zéro doublon. Jamais. CRM 100% propre.

---

## 🎯 PIPEDRIVE — Avant tout `creer_deal`

### Étape 1 — Vérifier email exact
```javascript
if (email) {
  const existing = await searchPersonByEmail(email);
  if (existing) return { action: "UPDATE", personId: existing.id };
}
```

### Étape 2 — Vérifier téléphone normalisé
```javascript
const phoneNorm = phone.replace(/[\s\-\+\(\)]/g, "").slice(-10);
const existing = await searchPersonByPhone(phoneNorm);
if (existing) return { action: "UPDATE", personId: existing.id };
```

### Étape 3 — Vérifier nom fuzzy
```javascript
const candidates = await searchPersonByName(`${prenom} ${nom}`);
if (candidates.length > 0) {
  // Demander confirmation à Shawn avec liste
  return { action: "CONFIRM_NEEDED", candidates };
}
```

### Étape 4 — Règle email OU tel obligatoire
```javascript
if (!email && !phone) {
  return { 
    action: "MANUAL_REQUIRED", 
    message: "Appelle pour obtenir email ou tel — je crée rien sans ça" 
  };
}
```

---

## 📧 GMAIL — Avant tout `envoyer_email`

### Étape 1 — Scan conversation 30j
```javascript
const conversation = await getGmailThread(email);
const lastEmail = conversation[conversation.length - 1];
const hoursSince = (now - lastEmail.date) / 3600000;

if (hoursSince < 48) {
  // Alerter Shawn: dernier envoi il y a X heures
  return {
    warning: `⚠️ Dernier email à ${email} envoyé il y a ${hoursSince}h`,
    requireConfirmation: true
  };
}
```

### Étape 2 — Détection contenu similaire
```javascript
const similarity = cosineSimilarity(newEmail.body, lastEmail.body);
if (similarity > 0.8) {
  return {
    warning: "⚠️ Contenu 80%+ similaire à dernier email envoyé",
    requireConfirmation: true
  };
}
```

---

## 📬 BREVO — Avant tout `ajouter_brevo`

### Étape 1 — Brevo API dédoublonnage natif
Brevo refuse déjà les emails duplicates → on utilise `UPDATE_ENABLED`.

### Étape 2 — Check listes conflictuelles
```javascript
// Si prospect ajouté dans L5 (Acheteurs), vérifier qu'il n'est pas dans L8 (Entrepreneurs)
// Un contact peut être dans plusieurs listes légitimes, mais certaines combinaisons sont incohérentes
```

---

## ⚠️ EN CAS DE DOUTE

**Toujours demander à Shawn AVANT de créer.**

Message type Telegram:
```
🤔 Doublon possible détecté:
• Jean Tremblay déjà dans Pipedrive (créé le 12 avril)
  → Email: jean.t@email.com | Tel: 514-555-1234 | Stage: Contacté

Nouveau lead:
  → Email: j.tremblay@email.com | Tel: 514-555-1234 | Source: Centris

Même numéro de tel — c'est le même?
[Update existant / Nouveau deal / Annuler]
```

---

## 🔄 IMPLÉMENTATION DANS `creer_deal`

Pseudo-code:
```javascript
async function creer_deal(params) {
  // 1. Règle email OU tel
  if (!params.email && !params.telephone) {
    return "❌ Email ou téléphone requis. Appelle le prospect.";
  }
  
  // 2. Check doublons
  const duplicates = await checkDuplicates(params);
  if (duplicates.length > 0) {
    return requestConfirmation(duplicates, params);
  }
  
  // 3. Créer
  return await createPipedriveDeal(params);
}
```

---

## 📊 MÉTRIQUE SUCCÈS

Objectif: **0 doublon créé par mois**.
Tracking: compter chaque mois les personnes avec même email/tel différent.
Alerte si taux > 0%.
