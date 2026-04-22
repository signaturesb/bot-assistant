# PLAYBOOK VENTES — Signature SB

> **Objectif:** Devenir #1 courtier Lanaudière. Le bot utilise ce playbook comme référence stratégique pour chaque interaction prospect.

---

## 🎯 PRINCIPES DIRECTEURS

### 1. Vitesse d'exécution
**Règle:** répondre à un lead dans les 5 minutes multiplie les chances de closer par 9×  
Le Gmail Poller du bot scan aux 5min → Shawn est averti instantanément avec brouillon J+0 prêt.

### 2. Chaque interaction = une étape vers la décision
Jamais de "suivi vide". Toujours une info nouvelle : chiffre marché, comparable vendu, opportunité.

### 3. Qualification avant présentation
Savoir AVANT de présenter :
- Motivation réelle (urgence vs curiosité)
- Capacité financière (pré-approbation ?)
- Timeline (mois, année, quand ?)
- Décideur unique ou couple ?

### 4. Valeur AVANT prix
Jamais de discussion de commission/prix de liste avant d'avoir démontré l'expertise + les résultats.

---

## 🔥 LE CYCLE IDÉAL (42 jours)

```
Jour 0  — Lead arrive      → bot crée deal + J+0 prêt → Shawn envoie
Jour 0-1 — Premier contact  → Appel dans 5 min, qualification
Jour 1  — Envoi info ciblée → Docs Dropbox pertinents
Jour 3  — Relance valeur    → Nouveau comparable, stat marché
Jour 5-7 — Visite proposée  → Créneau fermé, pas "quand ça vous convient"
Jour 10 — Visite effectuée  → Écoute active, reformulation besoins
Jour 12 — Post-visite       → Synthèse + proposition concrète
Jour 15-20 — Offre/décision → Accompagnement négociation
Jour 30-42 — Closing        → Suivi notaire, livraison, référence demandée
```

---

## 💬 SCRIPTS STRATÉGIQUES

### A. Premier contact (5 min après lead)
> "Bonjour [Prénom], Shawn Barrette de RE/MAX Prestige. Je viens de voir votre demande pour [propriété/secteur]. Avez-vous 2 minutes, je voulais juste m'assurer que vous avez les bonnes infos."

**Pas de pitch.** Juste écouter. 80% écoute, 20% parole.

### B. Qualification (questions clés)
1. "Qu'est-ce qui vous a attiré vers cette propriété spécifiquement ?"
2. "Vous cherchez pour habiter ou comme investissement ?"
3. "Votre timeline idéale serait quoi — semaines, mois ?"
4. "Avez-vous déjà parlé à une banque pour le financement ?"
5. "Y a-t-il quelqu'un d'autre impliqué dans la décision ?"

### C. Offre de valeur Signature SB
> "Ce que je fais différemment : je vends 2-3 terrains par semaine en Lanaudière. Je connais les prix au pied carré par secteur. Je peux vous dire dans 10 minutes si ce que vous cherchez existe à votre budget, ou si faut ajuster."

### D. Objection : "C'est trop cher"
> "Je comprends. Juste pour bien placer : savez-vous combien se sont vendus les 3 derniers terrains similaires à [secteur] dans les 60 derniers jours ? Je vous envoie les comparables réels — vous déciderez après."  
→ Bot: `envoyer_rapport_comparables type=terrain ville=[X] jours=60`

### E. Objection : "Je vais réfléchir"
> "Parfait. Qu'est-ce qui vous bloque concrètement — le prix, le financement, le timing, l'emplacement ? Je peux adresser ce point précis."

### F. Objection : "Je compare avec d'autres agents"
> "Très bonne approche. Une question : est-ce que les autres agents vous ont envoyé les vrais comparables vendus Centris avec les $/pi² par secteur ? Je peux vous les envoyer dans 10 minutes — vous jugerez ensuite."

### G. Closing — la question qui ferme
> "Si je vous trouve exactement ça — [secteur] + [budget] + [superficie] — dans les 30 jours, vous êtes prêt à signer une offre ?"

Si OUI → mandat d'achat  
Si "ça dépend" → creuser sur QUOI ça dépend (financement ? conjoint ? timing ?)

---

## 📊 ARGUMENTS FACTUELS (à utiliser systématiquement)

### Terrains Lanaudière
- **2-3 terrains vendus/semaine** par Shawn en Lanaudière
- **180-240 $/pi² clé en main** (nivelé, services, accès)
- **ProFab 0$ comptant** via Desjardins — programme unique
- **Exonération TPS** sur première maison neuve (fédéral)
- **Permis de construction: 2 mois** en moyenne

### Argument marché
- Inventaire historiquement bas
- Demande forte printemps/été
- Taux hypothécaire ~4.5% (effectif BdC - 1.65%)
- Prix médian Lanaudière: 515 000 $

### Argument urgence (SANS pression)
> "Pas de pression, juste de l'info : les terrains qui partent le plus vite à [secteur] sont entre [X]$ et [Y]$. Si c'est votre budget, on devrait bouger cette semaine."

---

## 🏡 PAR TYPE DE PROPRIÉTÉ

### Terrain (le plus fréquent — 2-3/semaine)
**Points clés à couvrir:**
1. Services (hydro, eau, fosse, champ d'épuration)
2. Pente (excavation coûte 30-50k si pentu)
3. Fibre optique (important pour télétravail)
4. Orientation du terrain (cour arrière sud = +10-15%)
5. Lot cadastral (vérifier permis et contraintes MRC)

**Documents à envoyer:**
- Fiche Centris du terrain (Dropbox: `/Terrain en ligne/{adresse}_NoCentris_{num}/`)
- Certificat de localisation si disponible
- Règlement municipal si zone contrainte

### Maison usagée
**Qualifiants rapides:**
- Année construction (pyrite avant 1995 ? UFFI avant 1982 ?)
- Fondation (dalle / vide sanitaire / sous-sol)
- Toiture (âge + matériau)
- Fenêtres (si > 20 ans → budget 20k)
- Plancher thermopompe (économie énergie)

### Plex (2-4 logements)
**Ratios critiques:**
- Multiplicateur revenu brut (RPR) = prix / revenu annuel
- TGA (taux global d'actualisation) = revenu net / prix
- Cash-flow après hypothèque positif ?
- Historique vacance / rénovations

### Construction neuve (ProFab partenariat)
**Avantage compétitif unique:**
- 0$ comptant via Desjardins
- GCR garantie résidentielle
- Jordan Brouillette: 514-291-3018
- Exonération TPS premier acheteur

---

## 📧 TEMPLATES EMAIL ÉPROUVÉS

### J+0 (réception lead)
```
Bonjour,

Merci de votre intérêt pour [propriété / Centris #XXX].

J'aimerais vous contacter pour vous donner plus d'informations et répondre à vos questions. Quand seriez-vous disponible pour qu'on se parle ?

Au plaisir,
Shawn
514-927-1340
```

### J+3 (si pas de réponse)
```
Bonjour,

Je voulais juste m'assurer que vous avez bien reçu mon message. 

Je vends 2-3 terrains par semaine en Lanaudière — si jamais vos besoins ont évolué ou que vous voulez voir d'autres options, je suis là.

Au plaisir,
Shawn
```

### Post-visite (J+1 après visite)
```
Bonjour,

Merci pour votre visite [hier/aujourd'hui] à [adresse].

Pour faire avancer les choses, j'ai quelques questions : 
- Est-ce que la propriété correspond à ce que vous cherchiez ?
- Y a-t-il des éléments qui vous font hésiter ?
- Voulez-vous qu'on regarde le financement ?

Au plaisir d'échanger,
Shawn
```

### Cause perdue (avant d'ajouter au Brevo nurture)
```
Bonjour,

Je comprends que vous ayez trouvé autre chose ou que ce n'est pas le bon moment.

Je garde votre profil et si une belle opportunité surgit dans [secteur], je vous ferai signe. Sinon, pas de souci — je suis là quand vous serez prêt.

Au plaisir,
Shawn
```

---

## 🎯 STRATÉGIES MARKET

### Différenciateurs à marteler
1. **2-3 terrains/semaine** = preuve de volume
2. **Partenariat ProFab** = 0$ comptant, unique
3. **Connaissance $/pi² par secteur** = précision pricing
4. **Accès Centris agent** = comparables réels en temps réel
5. **Bot IA 24/7** = réactivité hors normes

### Territoires prioritaires (par vélocité)
1. Rawdon — terrains chalets
2. Sainte-Julienne — banlieue active
3. Chertsey — lacs
4. Saint-Didace — niche
5. Saint-Jean-de-Matha — ski Val Saint-Côme

### Moments chauds (anticiper)
- **Février-mars:** acheteurs préparent printemps, mandats d'achat
- **Mai-juillet:** haute saison, closing rapides
- **Septembre-octobre:** dernière fenêtre avant gel
- **Novembre-janvier:** terrains dormants, prospection vendeurs

---

## 📈 KPIS QUI COMPTENT

### Par semaine (objectif)
- 5-10 nouveaux leads traités
- 3-5 appels de qualification
- 2-3 visites planifiées
- 1-2 offres déposées
- **2-3 ventes closées**

### Par prospect
- Temps lead → premier contact: < 5 min
- Temps lead → visite: < 14 jours
- Temps visite → offre: < 7 jours
- Temps offre → closing: < 30 jours

### Métriques conversion
- Lead → Contact: > 80%
- Contact → Visite: > 40%
- Visite → Offre: > 30%
- Offre → Closing: > 70%

---

## 🤖 COMMENT LE BOT UTILISE CE PLAYBOOK

Le bot (Opus 4.7) référence ce playbook dans son system prompt. Quand Shawn dit :
- "relance Jean" → bot suit template J+3
- "post-visite Marie" → bot suit template post-visite
- "objection sur le prix" → bot propose le script D
- "créer deal X 25 ans terrain 50k" → bot crée + J+0 auto
- "stats marché Rawdon" → bot scrape Centris + formate

**Mise à jour continue:** chaque fois qu'une tactique marche (close rapide, objection bien répondue), on l'ajoute ici. C'est notre intelligence collective.

---

## 🏆 VISION: Devenir #1 Lanaudière

**Métriques cibles 12 mois:**
- 100+ ventes/an
- 2M$+ de commissions
- 500+ prospects actifs CRM
- Taux conversion lead→vente: > 15%
- Notoriété: top 3 courtiers recherches "terrain Lanaudière"

**Tactiques en cours:**
- Mailing masse Brevo mensuel (5 campagnes segmentées)
- Partenariats: ProFab, constructeurs locaux, notaires
- SaaS: louer le bot à d'autres courtiers RE/MAX (revenu passif 150-300$/mois/agent)

**Prochaines étapes:**
- SEO local signaturesb.com (Rawdon, Sainte-Julienne)
- YouTube: vidéos terrains vedette chaque semaine
- Instagram: 3 posts/semaine
- LinkedIn: positionnement expert Lanaudière

---

*Dernière mise à jour: 2026-04-22 — Version 1.0*
