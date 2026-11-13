'use strict';
// Lightweight task scheduler for MC Panel (no dependencies, one timer for all tasks).
// User-facing strings are injected via `t` (see locales/ and lib/i18n.js).
const fs = require('fs');

const TYPES = ['backup', 'restart', 'command', 'broadcast'];
const MAX_TASKS = 50;

// Parses one cron field ("*", "*/5", "1,15", "9-17", "9-17/2") into a Set of numbers, or null if invalid.
function parseField(src, min, max) {
  const out = new Set();
  for (const part of String(src).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); }
    else { lo = Number(m[1]); hi = m[2] ? max : lo; }
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

// 5-field cron: minute hour day-of-month month day-of-week (0-7, 0 and 7 = Sunday)
function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const c = [parseField(f[0], 0, 59), parseField(f[1], 0, 23), parseField(f[2], 1, 31),
             parseField(f[3], 1, 12), parseField(f[4], 0, 7)];
  if (c.some(x => !x)) return null;
  if (c[4].has(7)) c[4].add(0);
  c.domStar = f[2].startsWith('*'); c.dowStar = f[4].startsWith('*');
  return c;
}

function cronMatches(c, d) {
  if (!c[0].has(d.getMinutes()) || !c[1].has(d.getHours()) || !c[3].has(d.getMonth() + 1)) return false;
  const dom = c[2].has(d.getDate()), dow = c[4].has(d.getDay());
  // standard cron: when both day fields are restricted, either one may match
  return (c.domStar || c.dowStar) ? (dom && dow) : (dom || dow);
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const KINDS = ['once', 'interval', 'daily', 'weekly', 'monthly', 'cron'];

// Turns the friendly schedule the UI sends (kind + time/days/...) into a cron string, or a one-time timestamp.
// Returns { cron } | { at } | { error: true }.
function compileSchedule(sc, now = Date.now()) {
  if (!sc || !KINDS.includes(sc.kind)) return { error: true };
  const tm = TIME_RE.exec(String(sc.time || ''));
  const hm = tm ? `${Number(tm[2])} ${Number(tm[1])}` : null;
  switch (sc.kind) {
    case 'once': {
      const at = Number(sc.at);
      if (!Number.isFinite(at) || at < now - 60000 || at > now + 5 * 365 * 86400000) return { error: true };
      return { at: Math.round(at / 60000) * 60000 };
    }
    case 'interval': {
      const n = parseInt(sc.every, 10);
      if (sc.unit === 'hour' && n >= 1 && n <= 23) return { cron: `0 */${n} * * *` };
      if (sc.unit === 'min' && n >= 1 && n <= 59) return { cron: `*/${n} * * * *` };
      return { error: true };
    }
    case 'daily': return hm ? { cron: `${hm} * * *` } : { error: true };
    case 'weekly': {
      const days = [...new Set((Array.isArray(sc.days) ? sc.days : []).map(Number))].filter(d => d >= 0 && d <= 6).sort();
      return hm && days.length ? { cron: `${hm} * * ${days.join(',')}` } : { error: true };
    }
    case 'monthly': {
      const dom = parseInt(sc.dom, 10);
      return hm && dom >= 1 && dom <= 31 ? { cron: `${hm} ${dom} * *` } : { error: true };
    }
    default: return parseCron(sc.cron) ? { cron: String(sc.cron).trim() } : { error: true };
  }
}

// Next time (ms) a cron schedule fires after `from`, or null if none within a year.
function nextCron(c, from = Date.now()) {
  const start = new Date(from); start.setSeconds(0, 0);
  const hours = [...c[1]].sort((a, b) => a - b), mins = [...c[0]].sort((a, b) => a - b);
  for (let off = 0; off <= 366; off++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + off);
    if (!c[3].has(day.getMonth() + 1)) continue;
    const dom = c[2].has(day.getDate()), dow = c[4].has(day.getDay());
    if (!((c.domStar || c.dowStar) ? (dom && dow) : (dom || dow))) continue;
    for (const h of hours) for (const m of mins) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
      if (t > from) return t;
    }
  }
  return null;
}

const LATE_GRACE = 15 * 60000;   // a one-time task still runs if the panel was down for less than this at its time

function createScheduler({ file, actions, sanitizeCommand, log, t }) {
  let tasks = [];
  let saveTimer = null;
  const parsed = new Map();   // id -> parsed cron
  const running = new Set();  // ids currently executing (no overlapping runs of the same task)

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) tasks = raw.filter(x => x && TYPES.includes(x.type) && (parseCron(x.cron) || Number.isFinite(x.at))).slice(0, MAX_TASKS);
    } catch { tasks = []; }
    parsed.clear();
    for (const x of tasks) if (x.cron) parsed.set(x.id, parseCron(x.cron));
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(tasks, null, 1)); } catch {} }, 300);
  }

  // Validates and normalises user input; returns { task } or { error }.
  function normalise(input, old) {
    const type = String(input.type || '');
    if (!TYPES.includes(type)) return { error: t.badType };
    // Either a friendly `sched` object (kind/time/days/...) or, for older clients and the advanced mode, a bare cron string.
    const sched = input.sched && typeof input.sched === 'object' ? input.sched : { kind: 'cron', cron: input.cron };
    const comp = compileSchedule(sched);
    if (comp.error) return { error: sched.kind === 'cron' || !input.sched ? t.badCron : (t.badSchedule || t.badCron) };
    const name = String(input.name || '').trim().slice(0, 40) || type;
    const task = {
      id: old ? old.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, type, enabled: input.enabled !== false,
      sched: { kind: sched.kind },
      lastRun: old ? old.lastRun : null, lastStatus: old ? old.lastStatus : null,
    };
    if (comp.at) { task.at = comp.at; task.sched.at = comp.at; task.autoDelete = !!input.autoDelete; task.done = old && old.at === comp.at ? !!old.done : false; if (!task.done && input.enabled !== false) task.enabled = true; }
    else {
      task.cron = comp.cron;
      if (sched.kind === 'interval') Object.assign(task.sched, { every: parseInt(sched.every, 10), unit: sched.unit });
      else if (sched.kind === 'cron') task.sched.cron = comp.cron;
      else { task.sched.time = String(sched.time); if (sched.kind === 'weekly') task.sched.days = [...new Set(sched.days.map(Number))].sort(); if (sched.kind === 'monthly') task.sched.dom = parseInt(sched.dom, 10); }
    }
    if (type === 'backup') {
      const keep = parseInt(input.keep, 10);
      task.keep = keep >= 1 && keep <= 1000 ? keep : 0; // 0 = keep everything
      // Destinations: undefined = the "auto" ones (how tasks created before destinations existed behave), [] = local only.
      if (Array.isArray(input.dests)) task.dests = input.dests.map(String).filter(x => /^[\w-]{1,20}$/.test(x)).slice(0, 10);
      task.keepLocal = input.keepLocal !== false;
    } else if (type === 'restart') {
      const warn = parseInt(input.warn, 10);
      task.warn = warn >= 0 && warn <= 600 ? warn : 60;
    } else {
      const text = sanitizeCommand(input.arg);
      if (!text) return { error: t.badArg };
      task.arg = text;
    }
    return { task };
  }

  async function execute(task, manual) {
    if (running.has(task.id)) return t.alreadyRunning;
    running.add(task.id);
    let status = 'ok';
    try {
      if (task.type === 'backup') {
        const r = await actions.backup({ keep: task.keep || 0, dests: task.dests, keepLocal: task.keepLocal });
        log(t.ranBackup(task.name, r.name, r.removed));
      } else if (task.type === 'restart') {
        const ok = await actions.restart(task.warn);
        if (!ok) status = t.skippedBusy;
        log(t.ranRestart(task.name, task.warn));
      } else if (task.type === 'broadcast') {
        if (!actions.isRunning()) status = t.skippedStopped;
        else actions.command('say ' + task.arg);
        log(t.ranGeneric(task.name));
      } else {
        if (!actions.isRunning()) status = t.skippedStopped;
        else actions.command(task.arg);
        log(t.ranGeneric(task.name));
      }
    } catch (e) {
      status = 'error: ' + (e && e.message ? e.message : e);
      log(t.failed(task.name, status));
    } finally {
      running.delete(task.id);
      task.lastRun = Date.now(); task.lastStatus = status;
      if (task.at && !manual) { task.done = true; task.enabled = false; if (task.autoDelete) { const i = tasks.indexOf(task); if (i >= 0) tasks.splice(i, 1); parsed.delete(task.id); } }
      save();
    }
    return status;
  }

  // One timer for everything: wakes every 20 s, fires tasks whose minute just changed.
  let lastKey = '';
  function tick() {
    const d = new Date(), nowMs = d.getTime();
    for (const task of tasks.slice()) {
      if (!task.at || task.done || !task.enabled || nowMs < task.at) continue;
      if (nowMs - task.at > LATE_GRACE) { task.done = true; task.enabled = false; task.lastStatus = t.missed || 'missed'; task.lastRun = nowMs; save(); continue; }
      execute(task, false);
    }
    const key = `${d.getFullYear()}${d.getMonth()}${d.getDate()}${d.getHours()}${d.getMinutes()}`;
    if (key === lastKey) return;
    lastKey = key;
    for (const task of tasks) {
      if (task.enabled && !task.at && parsed.get(task.id) && cronMatches(parsed.get(task.id), d)) execute(task, false);
    }
  }

  load();
  const timer = setInterval(tick, 20000);
  timer.unref();

  return {
    list: () => tasks.map(x => ({ ...x, running: running.has(x.id), nextRun: !x.enabled ? null : x.at ? (x.done ? null : x.at) : nextCron(parsed.get(x.id)) })),
    add(input) {
      if (tasks.length >= MAX_TASKS) return { error: t.tooMany };
      const r = normalise(input);
      if (r.error) return r;
      tasks.push(r.task); if (r.task.cron) parsed.set(r.task.id, parseCron(r.task.cron)); save();
      return { task: r.task };
    },
    update(id, input) {
      const i = tasks.findIndex(x => x.id === id);
      if (i < 0) return { error: t.notFound };
      const r = normalise({ ...tasks[i], ...input }, tasks[i]);
      if (r.error) return r;
      tasks[i] = r.task; if (r.task.cron) parsed.set(id, parseCron(r.task.cron)); else parsed.delete(id); save();
      return { task: r.task };
    },
    remove(id) {
      const i = tasks.findIndex(x => x.id === id);
      if (i < 0) return false;
      tasks.splice(i, 1); parsed.delete(id); save();
      return true;
    },
    async runNow(id) {
      const task = tasks.find(x => x.id === id);
      if (!task) return null;
      return execute(task, true);
    },
    parseCron,
  };
}

module.exports = { createScheduler, parseCron, cronMatches, compileSchedule, nextCron };
