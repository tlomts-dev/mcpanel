'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'locales');
const langs = Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
const base = langs.en;
const placeholders = s => (String(s).match(/\{\w+\}/g) || []).sort().join(',');

test('every language has the same keys as en.json', () => {
  for (const [code, d] of Object.entries(langs)) {
    const missing = Object.keys(base).filter(k => !(k in d));
    const extra = Object.keys(d).filter(k => !(k in base));
    assert.deepStrictEqual({ code, missing, extra }, { code, missing: [], extra: [] });
  }
});

test('placeholders match across languages', () => {
  for (const [code, d] of Object.entries(langs)) {
    for (const k of Object.keys(base)) assert.strictEqual(placeholders(d[k]), placeholders(base[k]), `${code}:${k}`);
  }
});

test('meta fields exist and dir is valid', () => {
  for (const [code, d] of Object.entries(langs)) {
    for (const k of ['meta.name', 'meta.dir', 'meta.font', 'meta.font_query']) assert.ok(d[k], `${code} missing ${k}`);
    assert.ok(['ltr', 'rtl'].includes(d['meta.dir']), code);
  }
});

test('every key used in the code and the page exists', () => {
  const files = ['server.js', 'public/index.html', ...fs.readdirSync(path.join(root, 'lib')).map(f => 'lib/' + f)];
  const used = new Set();
  for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of s.matchAll(/\bT?t?\(\s*'((?:srv|ui)\.[a-z0-9_]*[a-z0-9])'/g)) used.add(m[1]);
    for (const m of s.matchAll(/@@((?:ui|meta)\.\w+)@@/g)) used.add(m[1]);
  }
  assert.ok(used.size > 400);
  for (const k of used) assert.ok(k in base, 'unknown key ' + k);
});

test('values placed into HTML attributes or text contain no quotes or tags', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const m of html.matchAll(/@@((?:ui|meta)\.\w+)@@/g)) {
    for (const [code, d] of Object.entries(langs)) assert.ok(!/["<>]/.test(d[m[1]]), `${code}:${m[1]}`);
  }
});

test('renderPage fills every marker', () => {
  const i18n = require('../lib/i18n');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const code of Object.keys(langs)) {
    const out = i18n.renderPage(html, code);
    assert.ok(!/@@(ui|meta)\./.test(out) && !/__LANG__|__DIR__|"__I18N__"|"__LANGS__"/.test(out), code);
    assert.ok(out.includes(`lang="${code}" dir="${langs[code]['meta.dir']}"`));
  }
});

test('t() interpolates and falls back', () => {
  const i18n = require('../lib/i18n');
  const k = Object.keys(base).find(x => x.startsWith('srv.') && /\{v0\}/.test(base[x]));
  assert.ok(k);
  assert.ok(i18n.run('en', () => i18n.t(k, { v0: 'XYZ' })).includes('XYZ'));
  assert.strictEqual(i18n.t('srv.__missing__'), 'srv.__missing__');
});
