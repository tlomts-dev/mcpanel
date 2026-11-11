'use strict';
// Metrics history + alerts (Discord / Telegram) for MC Panel. Dependency-free, a few KB of RAM.
const fs = require('fs');
const path = require('path');

const POINTS = 1440;            // 24 h at one sample per minute
const FIELDS = ['tps', 'ram', 'cpu', 'players', 'disk'];

const DEFAULTS = {
  discord: '', telegramToken: '', telegramChat: '',
  crash: true, started: false,
  lowTps: { on: false, below: 15, forMin: 3 },
  highRam: { on: false, abovePct: 92, forMin: 3 },
  lowDisk: { on: false, belowGB: 5 },
  cooldownMin: 30,
};

const DISCORD_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function createMonitor({ dir, serverName, log }) {
  const histFile = path.join(dir, '.panel-history.json');
  const cfgFile = path.join(dir, '.panel-alerts.json');
  const hist = { t: [], tps: [], ram: [], cpu: [], players: [], disk: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    for (const k of ['t', ...FIELDS]) if (Array.isArray(raw[k])) hist[k] = raw[k].slice(-POINTS);
  } catch {}

  let cfg = { ...DEFAULTS };
  try { cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch {}

  function merge(base, over) {
    const out = { ...base };
    for (const k of Object.keys(base)) {
      if (over && over[k] !== undefined) out[k] = (base[k] && typeof base[k] === 'object') ? { ...base[k], ...over[k] } : over[k];
    }
    return out;
  }

  const num = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : null;
  let dirty = false;

  function sample(s) {
    hist.t.push(Date.now());
    for (const k of FIELDS) hist[k].push(num(s[k]));
    for (const k of ['t', ...FIELDS]) if (hist[k].length > POINTS) hist[k].shift();
    dirty = true;
    checkThresholds(s);
  }
  function flush() {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(histFile, JSON.stringify(hist), () => {});
  }

  // ── alerts ──────────────────────────────────────────────────────────────────
  const lastSent = {};
  const streak = { lowTps: 0, highRam: 0 };

  async function post(url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } finally { clearTimeout(timer); }
  }

  // Sends to every configured channel. Returns the list of channels that failed.
  async function deliver(text) {
    const failed = [];
    if (cfg.discord) { try { await post(cfg.discord, { content: text.slice(0, 1900) }); } catch (e) { failed.push('discord: ' + e.message); } }
    if (cfg.telegramToken && cfg.telegramChat) {
      try { await post(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, { chat_id: cfg.telegramChat, text: text.slice(0, 3900) }); }
      catch (e) { failed.push('telegram: ' + e.message.replace(cfg.telegramToken, '***')); }
    }
    return failed;
  }

  function alert(kind, text, force) {
    if (!cfg.discord && !(cfg.telegramToken && cfg.telegramChat)) return;
    const now = Date.now();
    if (!force && lastSent[kind] && now - lastSent[kind] < cfg.cooldownMin * 60000) return;
    lastSent[kind] = now;
    deliver(`[${serverName}] ${text}`).then(f => { if (f.length && log) log(`[Panel] Alert delivery failed: ${f.join('; ')}\n`); });
  }

  function checkThresholds(s) {
    if (!s.running) { streak.lowTps = streak.highRam = 0; return; }
    if (cfg.lowTps.on && s.tps != null) {
      streak.lowTps = s.tps < cfg.lowTps.below ? streak.lowTps + 1 : 0;
      if (streak.lowTps >= cfg.lowTps.forMin) alert('lowTps', `TPS has been below ${cfg.lowTps.below} for ${streak.lowTps} min (now ${s.tps}).`);
    }
    if (cfg.highRam.on && s.ram != null && s.ramMax) {
      const pct = s.ram / s.ramMax * 100;
      streak.highRam = pct > cfg.highRam.abovePct ? streak.highRam + 1 : 0;
      if (streak.highRam >= cfg.highRam.forMin) alert('highRam', `Memory use is ${pct.toFixed(0)}% of the limit for ${streak.highRam} min.`);
    }
    if (cfg.lowDisk.on && s.disk != null && s.disk < cfg.lowDisk.belowGB) alert('lowDisk', `Only ${s.disk} GB of disk space left.`);
  }

  function sanitizeCfg(input) {
    const i = input || {};
    const out = { ...cfg };
    if (i.discord !== undefined) {
      const d = String(i.discord).trim();
      if (d && !DISCORD_RE.test(d)) return { error: 'discord' };
      out.discord = d;
    }
    if (i.telegramToken !== undefined) {
      const tk = String(i.telegramToken).trim();
      if (tk && !/^\d{5,12}:[\w-]{20,60}$/.test(tk)) return { error: 'telegram' };
      out.telegramToken = tk;
    }
    if (i.telegramChat !== undefined) {
      const c = String(i.telegramChat).trim();
      if (c && !/^-?\d{3,20}$|^@[\w]{4,32}$/.test(c)) return { error: 'telegram' };
      out.telegramChat = c;
    }
    for (const k of ['crash', 'started']) if (i[k] !== undefined) out[k] = !!i[k];
    const clamp = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    if (i.lowTps) out.lowTps = { on: !!i.lowTps.on, below: clamp(i.lowTps.below, 1, 20, 15), forMin: clamp(i.lowTps.forMin, 1, 60, 3) };
    if (i.highRam) out.highRam = { on: !!i.highRam.on, abovePct: clamp(i.highRam.abovePct, 50, 100, 92), forMin: clamp(i.highRam.forMin, 1, 60, 3) };
    if (i.lowDisk) out.lowDisk = { on: !!i.lowDisk.on, belowGB: clamp(i.lowDisk.belowGB, 0.1, 100000, 5) };
    if (i.cooldownMin !== undefined) out.cooldownMin = clamp(i.cooldownMin, 1, 1440, 30);
    return { cfg: out };
  }

  const mask = s => s ? s.slice(0, 6) + '…' + s.slice(-4) : '';
  return {
    sample, flush, alert, deliver,
    event: (kind, text) => { if (cfg[kind]) alert(kind, text, true); },
    history: () => hist,
    getConfig: () => ({ ...cfg, discord: cfg.discord ? mask(cfg.discord) : '', telegramToken: cfg.telegramToken ? mask(cfg.telegramToken) : '',
      hasDiscord: !!cfg.discord, hasTelegram: !!(cfg.telegramToken && cfg.telegramChat) }),
    setConfig(input) {
      // masked values echoed back by the UI mean "unchanged"
      const i = { ...input };
      if (typeof i.discord === 'string' && i.discord.includes('…')) delete i.discord;
      if (typeof i.telegramToken === 'string' && i.telegramToken.includes('…')) delete i.telegramToken;
      const r = sanitizeCfg(i);
      if (r.error) return r;
      cfg = r.cfg;
      try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1), { mode: 0o600 }); } catch {}
      return { ok: true };
    },
    test: () => deliver(`[${serverName}] Test alert from MC Panel`),
    diskFreeGB: s => s == null ? null : Math.round(s / 1073741824 * 10) / 10,
  };
}

module.exports = { createMonitor, DISCORD_RE };
