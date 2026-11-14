#!/usr/bin/env node
/**
 * Génère les trois documentations, chacune en HTML autonome et en Word (.docx).
 *
 *   npm install            (une seule fois, dans ce dossier)
 *   node generer.mjs                                   → utilise variables.json, écrit dans le dossier parent
 *   node generer.mjs --variables client-x.json --sortie ../client-x
 *
 * Pour une nouvelle société : copier variables.json, changer le nom, le site, le contact et le chemin du logo, relancer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from 'docx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const VARS = JSON.parse(fs.readFileSync(path.resolve(HERE, arg('variables', 'variables.json')), 'utf8'));
const OUT = path.resolve(HERE, arg('sortie', '..'));
fs.mkdirSync(OUT, { recursive: true });
const IMG = n => path.join(HERE, 'images', n + '.jpg');
const logoPath = VARS.LOGO ? path.resolve(HERE, VARS.LOGO) : '';
const logoBuf = logoPath && fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : null;
const logoType = logoPath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

// ── Utilitaires ──────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const VAR_RE = /\{\{(SOCIETE|SITE|EMAIL|TELEPHONE)\}\}/g;
const fill = s => String(s).replace(VAR_RE, (_, k) => VARS[k] ?? '');
/** Découpe « texte **gras** `code` » en segments. */
function segments(text) {
  const out = []; const re = /\*\*(.+?)\*\*|`(.+?)`/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { t: m[1], b: true } : { t: m[2], c: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}
const inlineHtml = text => segments(text).map(s => {
  const h = esc(s.t).replace(VAR_RE, (_, k) => `<span data-var="${k}">${esc(VARS[k] ?? '')}</span>`);
  return s.b ? `<strong>${h}</strong>` : s.c ? `<code>${h}</code>` : h;
}).join('');
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 800, h: 600 };
}

// ── HTML ─────────────────────────────────────────────────────────────────────
function toHtml(doc) {
  const toc = []; let fig = 0; const body = [];
  for (const b of doc.blocks) {
    const [k, a, c, d] = b;
    if (k === 'h1' || k === 'h2') { const id = slug(a) + '-' + toc.length; toc.push({ k, a, id }); body.push(`<${k} id="${id}">${inlineHtml(a)}</${k}>`); }
    else if (k === 'h3') body.push(`<h3>${inlineHtml(a)}</h3>`);
    else if (k === 'p') body.push(`<p>${inlineHtml(a)}</p>`);
    else if (k === 'ul' || k === 'ol') body.push(`<${k}>${a.map(x => `<li>${inlineHtml(x)}</li>`).join('')}</${k}>`);
    else if (k === 'note' || k === 'warn') body.push(`<div class="box ${k}"><strong>${k === 'warn' ? 'Attention' : 'À savoir'}</strong> — ${inlineHtml(a)}</div>`);
    else if (k === 'code') body.push(`<pre>${esc(fill(a))}</pre>`);
    else if (k === 'table') body.push(`<table><thead><tr>${a.map(x => `<th>${inlineHtml(x)}</th>`).join('')}</tr></thead><tbody>${c.map(r => `<tr>${r.map(x => `<td>${inlineHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    else if (k === 'img') { fig++; body.push(`<figure class="${d || 'desktop'}"><img alt="${esc(fill(c))}" src="data:image/jpeg;base64,${fs.readFileSync(IMG(a)).toString('base64')}"><figcaption>Figure ${fig} — ${inlineHtml(c)}</figcaption></figure>`); }
    else if (k === 'imgs') { fig++; body.push(`<figure class="row">${a.map(n => `<img alt="" src="data:image/jpeg;base64,${fs.readFileSync(IMG(n)).toString('base64')}">`).join('')}<figcaption>Figure ${fig} — ${inlineHtml(c)}</figcaption></figure>`); }
  }
  const tocHtml = toc.map(t => `<li class="${t.k}"><a href="#${t.id}">${inlineHtml(t.a)}</a></li>`).join('');
  const logoData = logoBuf ? `data:image/${logoType === 'png' ? 'png' : 'jpeg'};base64,${logoBuf.toString('base64')}` : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} — ${esc(VARS.SOCIETE)}</title>
<!--
  ════════════════════════════════════════════════════════════════════════
  VARIABLES DU DOCUMENT — à adapter pour chaque société cliente.
  Modifiez les valeurs ci-dessous (ou utilisez le bandeau « Société » en haut de la page,
  puis « Enregistrer une copie »). LOGO : adresse d'une image, ou laisser vide.
  ════════════════════════════════════════════════════════════════════════
-->
<script id="variables">
window.DOC_VARIABLES = {
  SOCIETE:   ${JSON.stringify(VARS.SOCIETE)},
  SITE:      ${JSON.stringify(VARS.SITE)},
  EMAIL:     ${JSON.stringify(VARS.EMAIL)},
  TELEPHONE: ${JSON.stringify(VARS.TELEPHONE)},
  LOGO:      ${JSON.stringify(logoData)}
};
</script>
<style>
:root { --brand: #1d4ed8; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --soft: #f1f5f9; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink); background: #f8fafc; }
.bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px; background: #0f172a; color: #fff; font-size: 14px; }
.bar b { margin-right: auto; }
.bar button, .bar label.btn { font: inherit; cursor: pointer; border: 1px solid #334155; background: #1e293b; color: #fff; padding: 7px 12px; border-radius: 8px; }
.bar button.primary { background: var(--brand); border-color: var(--brand); }
.bar button[aria-pressed="true"] { background: #f59e0b; border-color: #f59e0b; color: #111; }
.vars { display: none; width: 100%; gap: 10px; flex-wrap: wrap; padding-top: 8px; }
.vars.open { display: flex; }
.vars label { display: flex; flex-direction: column; font-size: 12px; gap: 3px; color: #cbd5e1; }
.vars input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; min-width: 210px; }
main { max-width: 900px; margin: 0 auto; padding: 16px; background: #fff; }
.cover { min-height: 60vh; display: flex; flex-direction: column; justify-content: center; padding: 48px 8px; border-bottom: 4px solid var(--brand); margin-bottom: 32px; }
.cover .logo { height: 72px; max-width: 260px; object-fit: contain; object-position: left; margin-bottom: 28px; }
.cover .badge { width: 72px; height: 72px; border-radius: 16px; background: var(--brand); color: #fff; font-weight: 700; font-size: 28px; display: flex; align-items: center; justify-content: center; margin-bottom: 28px; }
.cover .kicker { text-transform: uppercase; letter-spacing: .12em; font-size: 13px; color: var(--brand); font-weight: 700; }
.cover h1.title { font-size: clamp(30px, 6vw, 46px); line-height: 1.1; margin: 8px 0 12px; border: 0; padding: 0; }
.cover p { color: var(--muted); margin: 2px 0; }
nav.toc { background: var(--soft); border-radius: 12px; padding: 18px 22px; margin-bottom: 32px; }
nav.toc h2 { margin: 0 0 8px; font-size: 18px; border: 0; padding: 0; }
nav.toc ol { margin: 0; padding-left: 0; list-style: none; }
nav.toc li.h1 { font-weight: 700; margin-top: 8px; }
nav.toc li.h2 { padding-left: 18px; font-size: 15px; }
nav.toc a { color: inherit; text-decoration: none; } nav.toc a:hover { color: var(--brand); text-decoration: underline; }
h1 { font-size: 28px; margin: 48px 0 12px; padding-top: 16px; border-top: 2px solid var(--line); line-height: 1.2; }
h2 { font-size: 21px; margin: 32px 0 8px; line-height: 1.25; }
h3 { font-size: 17px; margin: 22px 0 6px; }
p, li { overflow-wrap: anywhere; }
code { background: var(--soft); padding: 1px 5px; border-radius: 4px; font: 13.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 10px; overflow-x: auto; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14.5px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 700; }
.box { border-left: 4px solid var(--brand); background: #eff6ff; padding: 10px 14px; border-radius: 0 8px 8px 0; margin: 14px 0; }
.box.warn { border-color: #d97706; background: #fffbeb; }
figure { margin: 20px 0; text-align: center; }
figure img { max-width: 100%; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 2px 10px rgba(15,23,42,.08); }
figure.mobile img { max-width: 300px; }
figure.row { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; align-items: flex-start; }
figure.row img { width: 30%; min-width: 150px; max-width: 260px; }
figure.row figcaption { width: 100%; }
figcaption { font-size: 13px; color: var(--muted); margin-top: 6px; }
[contenteditable="true"] { outline: 2px dashed #f59e0b; outline-offset: 6px; }
footer.end { margin-top: 48px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media print {
  @page { size: A4; margin: 18mm 16mm; }
  body { background: #fff; font-size: 11pt; }
  .bar { display: none !important; }
  main { max-width: none; padding: 0; }
  .cover { min-height: 240mm; page-break-after: always; }
  nav.toc { page-break-after: always; background: none; padding: 0; }
  h1:not(.title) { page-break-before: always; border-top: 0; margin-top: 0; }
  h1, h2, h3 { page-break-after: avoid; }
  figure, table, .box, pre, tr { page-break-inside: avoid; }
  table { display: table; }
  a { color: inherit; text-decoration: none; }
  figure img { box-shadow: none; max-height: 150mm; }
  [contenteditable="true"] { outline: 0; }
}
</style>
</head>
<body>
<div class="bar" role="toolbar" aria-label="Outils du document">
  <b>${esc(doc.title)}</b>
  <button type="button" id="b-vars" aria-expanded="false">Société</button>
  <button type="button" id="b-edit" aria-pressed="false">Modifier le texte</button>
  <button type="button" id="b-save">Enregistrer une copie</button>
  <button type="button" id="b-pdf" class="primary">Exporter en PDF</button>
  <div class="vars" id="vars">
    <label>Nom de la société <input id="v-SOCIETE"></label>
    <label>Adresse du site <input id="v-SITE"></label>
    <label>E-mail de contact <input id="v-EMAIL"></label>
    <label>Téléphone <input id="v-TELEPHONE"></label>
    <label class="btn">Logo… <input id="v-LOGO" type="file" accept="image/*" hidden></label>
  </div>
</div>
<main id="doc">
  <section class="cover">
    <img class="logo" id="logo" alt="" hidden>
    <div class="badge" id="badge" aria-hidden="true"></div>
    <div class="kicker">${esc(doc.kicker)}</div>
    <h1 class="title">${esc(doc.title)}</h1>
    <p><strong data-var="SOCIETE">${esc(VARS.SOCIETE)}</strong></p>
    <p>${esc(doc.subtitle)}</p>
    <p>Version 1.0 — ${today}</p>
  </section>
  <nav class="toc" aria-label="Sommaire"><h2>Sommaire</h2><ol>${tocHtml}</ol></nav>
  ${body.join('\n  ')}
  <footer class="end"><span data-var="SOCIETE">${esc(VARS.SOCIETE)}</span> — ${esc(doc.title)} — version 1.0, ${today}</footer>
</main>
<script>
(function () {
  var V = window.DOC_VARIABLES, KEYS = ['SOCIETE', 'SITE', 'EMAIL', 'TELEPHONE'];
  function apply() {
    KEYS.forEach(function (k) { document.querySelectorAll('[data-var="' + k + '"]').forEach(function (e) { e.textContent = V[k]; }); });
    document.title = ${JSON.stringify(doc.title)} + ' — ' + V.SOCIETE;
    var logo = document.getElementById('logo'), badge = document.getElementById('badge');
    if (V.LOGO) { logo.src = V.LOGO; logo.hidden = false; badge.style.display = 'none'; }
    else { logo.hidden = true; badge.style.display = ''; badge.textContent = V.SOCIETE.split(/\\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase(); }
  }
  KEYS.forEach(function (k) { var i = document.getElementById('v-' + k); i.value = V[k]; i.addEventListener('input', function () { V[k] = i.value; apply(); }); });
  document.getElementById('v-LOGO').addEventListener('change', function (e) { var f = e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { V.LOGO = r.result; apply(); }; r.readAsDataURL(f); });
  document.getElementById('b-vars').addEventListener('click', function () { var o = document.getElementById('vars').classList.toggle('open'); this.setAttribute('aria-expanded', o); });
  document.getElementById('b-edit').addEventListener('click', function () { var d = document.getElementById('doc'), on = d.getAttribute('contenteditable') !== 'true'; d.setAttribute('contenteditable', on); this.setAttribute('aria-pressed', on); this.textContent = on ? 'Terminer la modification' : 'Modifier le texte'; });
  document.getElementById('b-pdf').addEventListener('click', function () { window.print(); });
  document.getElementById('b-save').addEventListener('click', function () {
    var d = document.getElementById('doc'), was = d.getAttribute('contenteditable'); d.removeAttribute('contenteditable');
    document.getElementById('variables').textContent = '\\nwindow.DOC_VARIABLES = ' + JSON.stringify(V, null, 2) + ';\\n';
    var html = '<!doctype html>\\n' + document.documentElement.outerHTML;
    if (was) d.setAttribute('contenteditable', was);
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = ${JSON.stringify(doc.file)} + '.html'; a.click();
  });
  apply();
})();
</script>
</body>
</html>`;
}

// ── Word ─────────────────────────────────────────────────────────────────────
const W = 9026; // largeur utile A4 avec marges de 2,54 cm, en DXA
const FONT = 'Arial';
function runs(text, base = {}) {
  return segments(fill(text)).map(s => new D.TextRun({ text: s.t, bold: s.b || base.bold, font: s.c ? 'Courier New' : FONT, size: s.c ? (base.size || 21) - 1 : base.size, color: base.color, shading: s.c ? { type: D.ShadingType.CLEAR, fill: 'F1F5F9' } : undefined }));
}
function image(name, maxW, maxH) {
  const buf = fs.readFileSync(IMG(name)); const { w, h } = jpegSize(buf);
  const r = Math.min(maxW / w, maxH / h, 1);
  return new D.ImageRun({ type: 'jpg', data: buf, transformation: { width: Math.round(w * r), height: Math.round(h * r) } });
}
const border = { style: D.BorderStyle.SINGLE, size: 4, color: 'CBD5E1' };
const borders = { top: border, bottom: border, left: border, right: border };
function table(headers, rows) {
  const n = headers.length;
  // largeur des colonnes proportionnelle à la longueur du contenu, bornée
  const len = headers.map((h, i) => Math.max(h.length, ...rows.map(r => Math.min(fill(r[i] || '').length, 60))));
  const tot = len.reduce((a, b) => a + Math.max(b, 8), 0);
  const cw = len.map(l => Math.max(1100, Math.round(W * Math.max(l, 8) / tot)));
  const k = W / cw.reduce((a, b) => a + b, 0); const widths = cw.map(x => Math.floor(x * k)); widths[n - 1] += W - widths.reduce((a, b) => a + b, 0);
  const cell = (t, i, head) => new D.TableCell({ width: { size: widths[i], type: D.WidthType.DXA }, borders, margins: { top: 70, bottom: 70, left: 110, right: 110 },
    shading: head ? { type: D.ShadingType.CLEAR, fill: 'E2E8F0' } : undefined, children: [new D.Paragraph({ children: runs(t, { bold: head, size: 19 }) })] });
  return new D.Table({ width: { size: W, type: D.WidthType.DXA }, columnWidths: widths, rows: [
    new D.TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true)) }),
    ...rows.map(r => new D.TableRow({ cantSplit: true, children: headers.map((_, i) => cell(r[i] || '', i, false)) })) ] });
}
async function toDocx(doc) {
  const kids = []; let fig = 0;
  const caption = t => new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { before: 60, after: 240 }, children: runs(t, { size: 18, color: '64748B' }) });
  // Page de garde
  kids.push(new D.Paragraph({ spacing: { before: 2400, after: 400 }, children: logoBuf ? [new D.ImageRun({ type: logoType, data: logoBuf, transformation: { width: 180, height: 72 } })] : [new D.TextRun({ text: VARS.SOCIETE, font: FONT, size: 40, bold: true, color: '1D4ED8' })] }));
  kids.push(new D.Paragraph({ children: [new D.TextRun({ text: doc.kicker.toUpperCase(), font: FONT, size: 22, bold: true, color: '1D4ED8' })] }));
  kids.push(new D.Paragraph({ spacing: { before: 120, after: 240 }, children: [new D.TextRun({ text: doc.title, font: FONT, size: 64, bold: true })] }));
  kids.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 18, color: '1D4ED8', space: 8 } }, children: [new D.TextRun({ text: VARS.SOCIETE, font: FONT, size: 28, bold: true })] }));
  kids.push(new D.Paragraph({ spacing: { before: 240 }, children: [new D.TextRun({ text: doc.subtitle, font: FONT, size: 22, color: '64748B' })] }));
  kids.push(new D.Paragraph({ children: [new D.TextRun({ text: `Version 1.0 — ${today}`, font: FONT, size: 22, color: '64748B' })] }));
  kids.push(new D.Paragraph({ children: [new D.PageBreak()] }));
  kids.push(new D.Paragraph({ spacing: { after: 200 }, children: [new D.TextRun({ text: 'Sommaire', font: FONT, size: 36, bold: true })] }));
  kids.push(new D.TableOfContents('Sommaire', { hyperlink: true, headingStyleRange: '1-2' }));
  kids.push(new D.Paragraph({ spacing: { before: 200 }, children: [new D.TextRun({ text: 'Si le sommaire est vide, cliquez dessus puis appuyez sur F9 (Word : « Mettre à jour la table »).', font: FONT, size: 17, italics: true, color: '64748B' })] }));
  let first = true;
  for (const b of doc.blocks) {
    const [k, a, c, d] = b;
    if (k === 'h1') { kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, pageBreakBefore: true, children: runs(a) })); first = false; }
    else if (k === 'h2') kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: runs(a) }));
    else if (k === 'h3') kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_3, children: runs(a) }));
    else if (k === 'p') kids.push(new D.Paragraph({ spacing: { after: 140 }, children: runs(a) }));
    else if (k === 'ul' || k === 'ol') { const ref = k === 'ul' ? 'puces' : 'num-' + (++toDocx.n); if (k === 'ol') doc._nums.push(ref); a.forEach(x => kids.push(new D.Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 70 }, children: runs(x) }))); kids.push(new D.Paragraph({ spacing: { after: 60 }, children: [] })); }
    else if (k === 'note' || k === 'warn') kids.push(new D.Paragraph({ spacing: { before: 120, after: 200 }, indent: { left: 160 }, shading: { type: D.ShadingType.CLEAR, fill: k === 'warn' ? 'FFFBEB' : 'EFF6FF' },
      border: { left: { style: D.BorderStyle.SINGLE, size: 24, color: k === 'warn' ? 'D97706' : '1D4ED8', space: 8 } }, children: [new D.TextRun({ text: (k === 'warn' ? 'Attention' : 'À savoir') + ' — ', bold: true, font: FONT }), ...runs(a)] }));
    else if (k === 'code') fill(a).split('\n').forEach((line, i, arr) => kids.push(new D.Paragraph({ shading: { type: D.ShadingType.CLEAR, fill: 'F1F5F9' }, spacing: { after: i === arr.length - 1 ? 200 : 0 }, children: [new D.TextRun({ text: line || ' ', font: 'Courier New', size: 18 })] })));
    else if (k === 'table') { kids.push(table(a, c)); kids.push(new D.Paragraph({ spacing: { after: 160 }, children: [] })); }
    else if (k === 'img') { fig++; kids.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, keepNext: true, spacing: { before: 160 }, children: [d === 'mobile' ? image(a, 230, 480) : image(a, 600, 420)] })); kids.push(caption(`Figure ${fig} — ${c}`)); }
    else if (k === 'imgs') { fig++; const w = Math.floor(W / a.length);
      kids.push(new D.Table({ width: { size: W, type: D.WidthType.DXA }, columnWidths: a.map(() => w), rows: [new D.TableRow({ cantSplit: true, children: a.map(n => new D.TableCell({ width: { size: w, type: D.WidthType.DXA },
        borders: { top: { style: D.BorderStyle.NONE }, bottom: { style: D.BorderStyle.NONE }, left: { style: D.BorderStyle.NONE }, right: { style: D.BorderStyle.NONE } },
        children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [image(n, Math.floor(560 / a.length), 400)] })] })) })] }));
      kids.push(caption(`Figure ${fig} — ${c}`)); }
  }
  const heading = (size, before, color) => ({ run: { font: FONT, size, bold: true, color }, paragraph: { spacing: { before, after: 140 }, keepNext: true } });
  const document = new D.Document({
    creator: VARS.SOCIETE, title: `${doc.title} — ${VARS.SOCIETE}`, features: { updateFields: true },
    styles: { default: { document: { run: { font: FONT, size: 21 }, paragraph: { spacing: { line: 300, lineRule: D.LineRuleType.AUTO } } }, heading1: heading(34, 0, '0F172A'), heading2: heading(26, 320, '1D4ED8'), heading3: heading(22, 240, '0F172A') } },
    numbering: { config: [
      { reference: 'puces', levels: [{ level: 0, format: D.LevelFormat.BULLET, text: '•', alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 500, hanging: 260 } } } }] },
      ...Array.from({ length: 80 }, (_, i) => ({ reference: 'num-' + (i + 1), levels: [{ level: 0, format: D.LevelFormat.DECIMAL, text: '%1.', alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 500, hanging: 320 } } } }] })) ] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1300, left: 1440, right: 1440 } } },
      headers: { default: new D.Header({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [new D.TextRun({ text: `${VARS.SOCIETE} — ${doc.title}`, font: FONT, size: 16, color: '64748B' })] })] }) },
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ['Page ', D.PageNumber.CURRENT, ' / ', D.PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: '64748B' })] })] }) },
      children: kids }],
  });
  return D.Packer.toBuffer(document);
}
toDocx.n = 0;

// ── Génération ───────────────────────────────────────────────────────────────
for (const f of ['contenu-technique.mjs', 'contenu-employes.mjs', 'contenu-voyageurs.mjs']) {
  const doc = (await import('./' + f)).default; doc._nums = [];
  fs.writeFileSync(path.join(OUT, doc.file + '.html'), toHtml(doc));
  fs.writeFileSync(path.join(OUT, doc.file + '.docx'), await toDocx(doc));
  console.log('✓', doc.file, '(.html, .docx) —', doc.blocks.length, 'blocs');
}
console.log('Documents générés pour « ' + VARS.SOCIETE + ' » dans', OUT);
