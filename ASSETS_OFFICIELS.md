# ASSETS OFFICIELS SIGNATURE SB — Source de vérité

> **RÈGLE ABSOLUE:** Tous les emails clients utilisent OBLIGATOIREMENT le master template Dropbox.
> Jamais de recréation manuelle des logos ou du design.

---

## 🎨 Master template email (UNIQUE source)

**Emplacement Dropbox:**
```
/Liste de contact/email_templates/master_template_signature_sb.html
```

**Brevo template ID:** `43` (production, utilisé par mailing-masse)

**Taille:** ~63 KB (contient 2 logos base64)

### Contenu garanti

- **Logo Signature SB** (base64 PNG) — header
- **Logo RE/MAX PRESTIGE** (base64 PNG) — footer
- **Barre rouge** #aa0721 — haut et bas
- **Fond noir** #0a0a0a
- **Texte** #f5f5f7 (clair) et #cccccc (gris)
- **Sections** fond #111111, border #1e1e1e

**NE JAMAIS MODIFIER** les logos base64 dans ce fichier.

### Placeholders disponibles (25)

```
{{ params.TITRE_EMAIL }}           — titre en-tête
{{ params.LABEL_SECTION }}         — label catégorie
{{ params.DATE_MOIS }}             — date format "avril 2026"
{{ params.TERRITOIRES }}           — ville/secteur
{{ params.SOUS_TITRE_ANALYSE }}    — sous-titre hero
{{ params.HERO_TITRE }}            — titre principal (avec <br> si besoin)
{{ params.INTRO_TEXTE }}           — contenu principal (HTML accepté)
{{ params.TITRE_SECTION_1 }}       — section 1
{{ params.MARCHE_LABEL }}          — label stat
{{ params.PRIX_MEDIAN }}           — grande stat affichée
{{ params.VARIATION_PRIX }}        — sous-texte stat
{{ params.SOURCE_STAT }}           — source
{{ params.LABEL_TABLEAU }}         — label tableau
{{ params.TABLEAU_STATS_HTML }}    — tableau/contenu HTML libre
{{ params.TITRE_SECTION_2 }}       — section 2
{{ params.CITATION }}              — citation en italique rouge
{{ params.CONTENU_STRATEGIE }}     — contenu stratégie
{{ params.CTA_TITRE }}             — titre bouton appel
{{ params.CTA_SOUS_TITRE }}        — sous-titre CTA
{{ params.CTA_URL }}               — lien CTA (tel: ou https:)
{{ params.CTA_BOUTON }}            — texte bouton
{{ params.CTA_NOTE }}              — note sous bouton
{{ params.REFERENCE_URL }}         — URL référence
{{ params.SOURCES }}               — sources footer
{{ params.DESINSCRIPTION_URL }}    — unsubscribe
```

**Placeholder contact.FIRSTNAME** = Brevo le remplace à l'envoi (pas nous)

---

## 🏢 Identité officielle Signature SB

| Élément | Valeur |
|---|---|
| Courtier | Shawn Barrette |
| Compagnie | **RE/MAX PRESTIGE** (sans Rawdon) |
| Téléphone | 514-927-1340 |
| Email | shawn@signaturesb.com |
| Site | signatureSB.com |
| Assistante | Julie (julie@signaturesb.com) |
| Code agent Centris | 110509 |
| Couleur principale | `#aa0721` (rouge Signature SB) |
| Région | Lanaudière · Rive-Nord |

**Partenaire construction:** ProFab — Jordan Brouillette 514-291-3018  
**Avantage unique:** 0$ comptant via Desjardins (aucun autre courtier n'offre ça)

**Toutes ces valeurs sont dans Render env vars (AGENT_NOM, AGENT_COMPAGNIE, etc.) — le bot y accède dynamiquement.**

---

## 💰 Programme référencement (toujours mentionner dans emails)

**Bonus:** 500 $ à 1 000 $ en argent  
**Condition:** Transaction conclue (achat/vente/construction)  
**Processus:** Envoyer nom + numéro à Shawn, aucune paperasse

**Bloc HTML réutilisable** (inclus dans envoyerDocsProspect):
```html
<div style="background:#0d0d0d;border:2px solid #aa0721;border-radius:8px;padding:18px 22px;margin:24px 0;">
<div style="color:#aa0721;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">💰 Programme de référencement</div>
<div style="color:#f5f5f7;font-size:14px;font-weight:600;">Vous connaissez quelqu'un qui pense à acheter, vendre ou construire?</div>
<div style="color:#cccccc;font-size:13px;">Envoyez-moi son nom et son numéro — si la transaction se conclut, vous recevez <strong style="color:#aa0721;">500 $ à 1 000 $</strong> en argent.</div>
</div>
```

---

## 📋 Checklist avant tout envoi email client

Quand bot construit un email, il DOIT:

- [x] Lire le master template depuis Dropbox `/Liste de contact/email_templates/master_template_signature_sb.html`
- [x] Remplir les placeholders (fill function)
- [x] Inclure le bloc programme référencement
- [x] Signer avec `AGENT.nom` + `AGENT.compagnie` (pas hardcodé)
- [x] Téléphone cliquable `tel:${AGENT.telephone.replace(/\D/g,'')}`
- [x] Email cliquable `mailto:${AGENT.email}`
- [x] Site cliquable `https://${AGENT.site}`
- [x] Fallback inline HTML si Dropbox indispo (mais logos textes seulement en fallback)

---

## 🎨 Campagnes mailing-masse

5 campagnes Brevo qui utilisent ce même template:

1. **VENDEURS** — mensuelle, listes 3,4,5,6,7 (~1029 contacts)
2. **ACHETEURS** — mensuelle, liste 5 (~75 contacts)  
3. **PROSPECTS** — mensuelle, liste 4 (~284 contacts)
4. **TERRAINS** — aux 14 jours, liste 8 (~104 entrepreneurs)
5. **RÉFÉRENCEMENT** — mensuelle, listes 3,6,7 (~105 contacts)

Code: `/Users/signaturesb/Documents/github/mailing-masse/campaigns_library.js`

---

## 🚨 RÈGLES ABSOLUES

1. ❌ Ne JAMAIS créer ses propres logos textuels (`<span>RE/MAX</span>`)
2. ❌ Ne JAMAIS modifier les logos base64 dans le master template
3. ❌ Ne JAMAIS hardcoder "RE/MAX PRESTIGE Rawdon" (c'est "RE/MAX PRESTIGE")
4. ✅ TOUJOURS passer par le master template Dropbox
5. ✅ TOUJOURS lire AGENT.compagnie / AGENT.nom / AGENT.telephone dynamiquement
6. ✅ TOUJOURS tester en preview avant envoi réel

---

*Dernière mise à jour: 2026-04-22 — Compagnie = "RE/MAX PRESTIGE" (Rawdon retiré)*
