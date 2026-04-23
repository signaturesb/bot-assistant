# 🎯 DEMANDES SHAWN — URGENT

**Dernière mise à jour:** 2026-04-22 PM

---

## 🔴 URGENT #1 — Désactiver Gmail Poller IMAP

**Problème:** Le poller IMAP garde des connexions persistantes ouvertes sur shawn@signaturesb.com → bloque iPhone Mail ("trop de connexions simultanées").

**Aussi:** gmail_poller.json dans /data (volatil) → à chaque redémarrage, re-notifie tous les vieux emails comme si nouveaux leads.

**Solution demandée:**
1. Désactiver immédiatement le Gmail Poller IMAP dans bot.js
2. Remplacer par **Gmail API** (OAuth, zéro connexion persistante)
3. État persistant dans GitHub (pas /data)

---

## 🔴 URGENT #2 — Flow auto envoi docs sur lead

**Ce que Shawn veut:**

```
1. Lead arrive sur shawn@signaturesb.com (demande visite/appel terrain Centris)
2. Bot extrait numéro Centris de l'email
3. Bot cherche dossier Dropbox correspondant
4. Bot trouve "Fiche_Detaillee_Client.pdf" (priorité)
5. Bot envoie Telegram à Shawn:
   🔔 NOUVEAU LEAD — Terrain Centris #XXX
   👤 Nom + tel + email
   🏡 Adresse terrain
   📄 PDF trouvé
   "Réponds 'envoie' pour confirmer"
6. Shawn répond "envoie"
7. Bot envoie PDF au prospect avec template Signature SB
8. Bot crée deal Pipedrive + active séquence J+0
```

**Template email au prospect:**
- Sujet: "Documents — Terrain [Adresse] | Centris #XXX"
- Corps: vouvoiement, 3 paragraphes max
- Logos Signature SB + RE/MAX (base64)
- Fond #0a0a0a, rouge #aa0721
- PDF Fiche_Detaillee_Client en pièce jointe

**Signature fixe:**
```
Au plaisir,
Shawn Barrette
Courtier immobilier | RE/MAX PRESTIGE
📞 514-927-1340
shawn@signaturesb.com
```

---

## ⚠️ RÈGLE — Email de test

Quand Shawn demande un "preview" ou "exemple email" → **TOUJOURS** envoyer à **shawn@signaturesb.com**.
Jamais à julie@signaturesb.com par défaut. Erreur commise aujourd'hui — ne pas répéter.

---

## 📋 État des demandes

| # | Demande | Status |
|---|---------|--------|
| 1 | Désactiver Gmail Poller IMAP | ⏳ À faire |
| 2 | Migration Gmail API | ⏳ À faire |
| 3 | Flow auto envoi docs | ⏳ À faire |
| 4 | État poller persistant (GitHub au lieu de /data) | ⏳ À faire |

---

## 🔧 Instructions techniques pour Claude Code

Quand tu reprends cette tâche:

1. **Lire bot.js entièrement** (4000+ lignes)
2. **Identifier** les appels IMAP (imap, imapflow, node-imap)
3. **Trouver** la fonction gmail_poller / scan emails
4. **Commenter** l'init IMAP pour arrêter le saignement immédiat
5. **Implémenter** Gmail API via googleapis (déjà dans package.json?)
6. **Tester** sur boîte locale avant push prod
7. **Migrer** état de /data/gmail_poller.json vers GitHub ou base légère

Credentials Gmail API:
- GMAIL_CLIENT_ID (Render)
- GMAIL_CLIENT_SECRET (Render)
- GMAIL_REFRESH_TOKEN (Render)
- Scope: https://www.googleapis.com/auth/gmail.readonly + gmail.send

**⚠️ NE PAS force-push sur bot-assistant/main (= prod Render). Travailler sur une branche, tester, merger propre.**
