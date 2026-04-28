// build_fiche_template.js — Génère le template fiche depuis le master SB
// pour garantir brand identique (fond noir, rouge, 2 logos exacts)
const fs = require('fs');
const path = require('path');

const MASTER = '/Users/signaturesb/Dropbox/Liste de contact/email_templates/master_template_signature_sb.html';
const OUT = path.join(__dirname, 'centris_fiche_email_template.html');

const master = fs.readFileSync(MASTER, 'utf8');
const imgs = [...master.matchAll(/<img[^>]+src="(data:image\/[^"]+)"[^>]*>/g)];
const LOGO_SB = imgs[0]?.[1] || '';
const LOGO_REMAX = imgs[1]?.[1] || '';

const tpl = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>Fiche propriété — Signature SB</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 0; background-color: #060606 !important;
         font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
         -webkit-text-size-adjust: 100%; }
  table { border-collapse: collapse; }
  img { border: 0; outline: none; text-decoration: none; }
  a { text-decoration: none; }
  .container { max-width: 620px; margin: 0 auto; background-color: #0a0a0a !important; }
  @media only screen and (max-width: 640px) {
    .container { width: 100% !important; }
    .mobile-pad { padding: 24px 20px !important; }
  }
</style>
</head>
<body bgcolor="#060606" style="background:#060606;">

<div style="width:100%; background-color:#060606;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#060606">
<tbody><tr><td align="center" bgcolor="#060606">

<table class="container" width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a">

  <!-- ══ BARRE ROUGE TOP ══ -->
  <tbody><tr>
    <td style="background-color:#aa0721; padding:10px 28px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tbody><tr>
          <td style="color:#ffffff; font-size:11px; font-weight:600; letter-spacing:2px; text-transform:uppercase;">FICHE PROPRIÉTÉ</td>
          <td style="color:#ffffff; font-size:11px; text-align:right; opacity:0.9;">{DATE_ENVOI}</td>
        </tbody></tr>
      </table>
    </td>
  </tr>

  <!-- ══ LOGOS ══ -->
  <tr>
    <td style="background-color:#0a0a0a; padding:32px 28px 24px;" align="center">
      <table cellpadding="0" cellspacing="0" border="0">
        <tbody><tr>
          <td style="padding-right:24px;">
            <img src="${LOGO_SB}" alt="Signature SB" width="100" style="display:block; max-width:100px; height:auto;"/>
          </td>
          <td style="border-left:1px solid #2a2a2a; padding-left:24px;">
            <img src="${LOGO_REMAX}" alt="RE/MAX PRESTIGE" width="90" style="display:block; max-width:90px; height:auto;"/>
          </td>
        </tbody></tr>
      </table>
    </td>
  </tr>

  <!-- ══ TITRE ══ -->
  <tr>
    <td class="mobile-pad" style="background-color:#0a0a0a; padding:20px 36px 8px;" align="center">
      <div style="color:#ffffff; font-size:24px; font-weight:700; letter-spacing:0.5px;">Fiche détaillée</div>
      <div style="color:#aa0721; font-size:13px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; margin-top:6px;">Centris #{CENTRIS_NUM}</div>
    </td>
  </tr>

  <!-- ══ MESSAGE ══ -->
  <tr>
    <td class="mobile-pad" style="background-color:#0a0a0a; padding:24px 36px 8px;">
      <p style="color:#e5e5e5; font-size:15px; line-height:1.7; margin:0 0 16px;">Bonjour,</p>
      <p style="color:#cfcfcf; font-size:14px; line-height:1.7; margin:0 0 20px;">{MESSAGE_HTML}</p>
    </td>
  </tr>

  <!-- ══ BLOC DOCUMENT ══ -->
  <tr>
    <td class="mobile-pad" style="padding:8px 36px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#1a0a0c; border:1px solid #aa0721; border-radius:6px;">
        <tbody><tr><td style="padding:22px 26px;">
          <div style="color:#aa0721; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; margin-bottom:10px;">📎 Document joint</div>
          <div style="color:#ffffff; font-size:16px; font-weight:600;">Fiche descriptive — Centris #{CENTRIS_NUM}</div>
          <div style="color:#999; font-size:13px; margin-top:8px; line-height:1.5;">Toutes les caractéristiques, photos, plans et informations détaillées de la propriété.</div>
        </td></tr>
      </table>
    </td>
  </tr>

  <!-- ══ FERMETURE ══ -->
  <tr>
    <td class="mobile-pad" style="padding:0 36px 24px;">
      <p style="color:#cfcfcf; font-size:14px; line-height:1.7; margin:0 0 12px;">N'hésitez pas à me contacter pour toute question ou pour planifier une visite.</p>
      <p style="color:#cfcfcf; font-size:14px; line-height:1.7; margin:0;">Au plaisir,</p>
    </td>
  </tr>

  <!-- ══ SIGNATURE ══ -->
  <tr>
    <td class="mobile-pad" style="padding:24px 36px 32px; border-top:1px solid #1a1a1a;">
      <div style="color:#ffffff; font-size:18px; font-weight:700;">Shawn Barrette</div>
      <div style="color:#aa0721; font-size:13px; font-weight:600; letter-spacing:0.5px; margin-top:3px;">Courtier immobilier résidentiel</div>
      <div style="margin-top:14px; color:#cfcfcf; font-size:13px; line-height:1.7;">
        <a href="tel:5149271340" style="color:#aa0721; font-weight:600;">514 927-1340</a><br/>
        <a href="mailto:shawn@signaturesb.com" style="color:#cfcfcf;">shawn@signaturesb.com</a><br/>
        <a href="https://signaturesb.com" style="color:#cfcfcf;">signaturesb.com</a>
      </div>
      <div style="color:#888; font-size:11px; margin-top:14px; letter-spacing:0.5px;">
        RE/MAX PRESTIGE Rawdon · Signature SB Groupe immobilier
      </div>
    </td>
  </tr>

  <!-- ══ FOOTER ══ -->
  <tr>
    <td style="padding:14px 36px; background-color:#060606; border-top:1px solid #1a1a1a; text-align:center;">
      <div style="color:#666; font-size:11px; letter-spacing:0.5px;">
        Signature SB · RE/MAX PRESTIGE Rawdon · Lanaudière, QC
      </div>
    </td>
  </tr>

</tbody></table>

</td></tr></tbody></table>
</div>

</body>
</html>`;

fs.writeFileSync(OUT, tpl);
console.log('✓ Template SB brand généré: ' + OUT);
console.log('  Size: ' + (tpl.length / 1024).toFixed(1) + ' KB');
console.log('  Logo SB: ' + LOGO_SB.length + ' chars');
console.log('  Logo RE/MAX: ' + LOGO_REMAX.length + ' chars');
