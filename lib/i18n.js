'use strict';
/**
 * Language files (locales/<code>.json) shared by the server and the browser UI.
 *  - keys "srv.*"  : server messages, used with t(key, vars)
 *  - keys "ui.*"   : browser UI strings (sent to the page)
 *  - keys "meta.*" : language name, text direction
 * Placeholders look like {v0}. The current language is carried per request
 * through AsyncLocalStorage; outside a request the default language is used.
 * Adding a language = adding one JSON file with the same keys.
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const DIR = path.join(__dirname, '..', 'locales');
const dicts = {};
for (const f of fs.readdirSync(DIR)) {
  if (/^[a-z]{2,3}(-[A-Za-z]+)?\.json$/.test(f)) dicts[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
}
const FALLBACK = dicts.en ? 'en' : Object.keys(dicts)[0];
let defaultLang = dicts[process.env.PANEL_LANG] ? process.env.PANEL_LANG : (dicts.ar ? 'ar' : FALLBACK);

const als = new AsyncLocalStorage();
const available = () => Object.keys(dicts);
const run = (lang, fn) => als.run(dicts[lang] ? lang : defaultLang, fn);
const current = () => als.getStore() || defaultLang;

function t(key, vars) {
  const d = dicts[current()] || dicts[FALLBACK];
  let s = d[key];
  if (s === undefined) s = (dicts[FALLBACK] || {})[key];
  if (s === undefined) return key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

function langFromCookie(header) {
  const m = /(?:^|;\s*)panel_lang=([A-Za-z-]+)/.exec(header || '');
  return m && dicts[m[1]] ? m[1] : defaultLang;
}

const uiCache = {};
function uiDict(lang) {
  if (!uiCache[lang]) {
    const out = {};
    for (const [k, v] of Object.entries(dicts[lang])) if (k.startsWith('ui.') || k.startsWith('meta.')) out[k] = v;
    uiCache[lang] = JSON.stringify(out).replace(/</g, '\\u003c');
  }
  return uiCache[lang];
}

/** Fill the page template: __LANG__, __DIR__ and the dictionary. */
function renderPage(html, lang) {
  const l = dicts[lang] ? lang : defaultLang;
  const d = dicts[l], fb = dicts[FALLBACK];
  return html
    .replace(/@@((?:ui|meta)\.\w+)@@/g, (m, k) => (d[k] !== undefined ? d[k] : fb[k] !== undefined ? fb[k] : k))
    .replace(/__LANG__/g, l)
    .replace(/__DIR__/g, dicts[l]['meta.dir'] || 'ltr')
    .replace('"__I18N__"', () => uiDict(l))
    .replace('"__LANGS__"', () => JSON.stringify(available().map(c => [c, dicts[c]['meta.name'] || c])));
}

module.exports = { t, run, available, langFromCookie, renderPage, setDefault: l => { if (dicts[l]) defaultLang = l; }, _dicts: dicts };
