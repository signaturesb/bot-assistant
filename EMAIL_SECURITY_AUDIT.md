# 🔒 Audit Sécurité Email — Source de Vérité Unique

> **Règle absolue (Shawn 2026-04-25):** AUCUN courriel ne s'envoie au CLIENT sans consent explicite via Telegram. Les rapports/alertes INTERNES à shawn@ sont OK.

---

## ✅ État actuel — VÉRIFIÉ ET CENTRALISÉ

### Bot Telegram (bot.js sur Render)
| Voie d'envoi | Destinataire | Garde-fou | État |
|---|---|---|---|
| `envoyerDocsAuto()` | Client | `CONSENT_REQUIRED + _shawnConsent: true` | ✅ Bloqué sans consent |
| Branche auto-send score ≥75 | Client | **SUPPRIMÉE** | ✅ N'existe plus |
| `envoyer_email` tool | Client | `pendingEmails + Shawn dit "envoie"` | ✅ Toujours via confirmation |
| `traiterNouveauLead` | Client | Preview shawn@ + pending | ✅ Jamais auto |
| Webhooks (Centris, SMS, reply) | Client | Notifs shawn@ + brouillon Pipedrive | ✅ Pas d'envoi auto |

### LaunchAgents macOS (`~/Library/LaunchAgents/`)

#### 🔴 DÉSACTIVÉS (envoyaient au client sans consent)
| Plist | Script | Désactivé le | Backup |
|---|---|---|---|
| `com.signaturesb.j0sender` | `chat bot automatisation/.../j0-sender.js` | 2026-04-25 | `.disabled-2026-04-25` |
| `com.signaturesb.reengagement` | `mailing-masse/reengagement.js` | 2026-04-25 | `.disabled-2026-04-25` |
| `com.signaturesb.referral` | `mailing-masse/referral_followup.js` | 2026-04-25 | `.disabled-2026-04-25` |
| `com.signaturesb.replyconfirm` | `mailing-masse/reply_to_confirm.js` | 2026-04-25 | `.disabled-2026-04-25` |

**Pour réactiver un agent:**
```bash
cd ~/Library/LaunchAgents
mv com.signaturesb.X.plist.disabled-2026-04-25 com.signaturesb.X.plist
launchctl load com.signaturesb.X.plist
```

#### 🟢 ACTIFS — envois confirmés vers SHAWN_EMAIL uniquement

| Plist | Envois | Destinataire | Fréquence |
|---|---|---|---|
| `com.signaturesb.campaignmonitor` | Alertes campagne | shawn@ | Continu |
| `com.signaturesb.cleanup` | Rapport contacts inactifs | shawn@ | 1×/mois |
| `com.signaturesb.sendstats` | Stats campagne hier | shawn@ | Quotidien |
| `com.signaturesb.weekly` | Rapport hebdo | shawn@ | Hebdo |
| `com.signaturesb.scheduler` | Email "veille" CONFIRMER/ANNULER | shawn@ | Quotidien 9h |

#### 🟢 ACTIFS — zéro envoi email
`bot-watchdog`, `caffeinate`, `chatbot`, `claudebot`, `cleanup` (above), `deal_monitor`, `dropbox-rappel-julie` (Telegram), `gmail_reply_watcher` (lit seulement), `gitpull`, `intake-videos`, `julie` (digest Brevo interne), `logrotate`, `monthly_review` (lit), `pipedrive_sync`, `publication.*`, `stats_scraper`, `telegram-bot`, `tunnel`, `watchdog.*`

### Brevo
- API key utilisée par bot.js (fallback) + scripts mailing-masse
- Templates HTML stockés dans Brevo dashboard
- **Aucune séquence/automation Brevo configurée pour envoi auto au client** (à vérifier dans dashboard Brevo périodiquement)

### Gmail
- OAuth2 refresh token shawn@signaturesb.com
- Bot envoie via Gmail API
- Pour audit: `https://mail.google.com/mail/u/0/#sent` → vérifier dossier "Envoyés" pour anomalies

---

## 🧪 Comment vérifier en 30 secondes que rien n'envoie sans consent

```bash
# 1. Bot.js — confirme CONSENT_REQUIRED actif
grep "CONSENT_REQUIRED = true" ~/Documents/github/Claude\,\ code\ Telegram/bot.js

# 2. LaunchAgents — confirme les 4 dangereux désactivés
ls ~/Library/LaunchAgents/com.signaturesb.{j0sender,reengagement,referral,replyconfirm}.plist 2>/dev/null
# → si "No such file" affiché = désactivés ✅

# 3. Liste TOUS les LaunchAgents actifs
launchctl list | grep com.signaturesb

# 4. Vérifie qu'aucun nouvel envoi auto n'a été ajouté
cd ~/Documents/github && grep -rE "smtp/email|sendmail|sendGmail|messages/send" \
  --include="*.js" -l | grep -v node_modules
# → liste les fichiers qui PEUVENT envoyer (pas qu'ils envoient sans consent)
```

---

## 🆘 Procédure d'urgence — kill switch global

Si jamais un email part par erreur:

```bash
# 1. Désactiver TOUS les LaunchAgents en 1 commande
for plist in ~/Library/LaunchAgents/com.signaturesb.*.plist; do
  launchctl unload "$plist" 2>/dev/null
  mv "$plist" "${plist}.PANIC-OFF"
done

# 2. Désactiver le bot Telegram lui-même
# (sur dashboard Render → Suspend service)
```

Pour réactiver après:
```bash
for plist in ~/Library/LaunchAgents/com.signaturesb.*.PANIC-OFF; do
  newname="${plist%.PANIC-OFF}"
  mv "$plist" "$newname"
  launchctl load "$newname"
done
```

---

## 📋 Checklist mensuelle (1 minute)

À faire le 1er de chaque mois:
- [ ] Vérifier dossier Gmail "Envoyés" → aucun email mystérieux
- [ ] `launchctl list | grep signaturesb` → rien de nouveau apparu
- [ ] Brevo dashboard → aucune automation activée sans consent
- [ ] `/quota` Telegram → tokens consommés cohérents avec activité

---

*Maintenu par l'assistant Claude Code. Toute modification d'un script/agent qui envoie des emails DOIT être documentée ici avant deploy.*
