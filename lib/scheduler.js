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

function createScheduler({ file, actions, sanitizeCommand, log, t }) {
  let tasks = [];
  let saveTimer = null;
  const parsed = new Map();   // id -> parsed cron
  const running = new Set();  // ids currently executing (no overlapping runs of the same task)

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) tasks = raw.filter(x => x && TYPES.includes(x.type) && parseCron(x.cron)).slice(0, MAX_TASKS);
    } catch { tasks = []; }
    parsed.clear();
    for (const x of tasks) parsed.set(x.id, parseCron(x.cron));
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(tasks, null, 1)); } catch {} }, 300);
  }

  // Validates and normalises user input; returns { task } or { error }.
  function normalise(input, old) {
    const type = String(input.type || '');
    if (!TYPES.includes(type)) return { error: t.badType };
    const cron = String(input.cron || '').trim();
    if (!parseCron(cron)) return { error: t.badCron };
    const name = String(input.name || '').trim().slice(0, 40) || type;
    const task = {
      id: old ? old.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, type, cron, enabled: input.enabled !== false,
      lastRun: old ? old.lastRun : null, lastStatus: old ? old.lastStatus : null,
    };
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
      task.lastRun = Date.now(); task.lastStatus = status; save();
    }
    return status;
  }

  // One timer for everything: wakes every 20 s, fires tasks whose minute just changed.
  let lastKey = '';
  function tick() {
    const d = new Date();
    const key = `${d.getFullYear()}${d.getMonth()}${d.getDate()}${d.getHours()}${d.getMinutes()}`;
    if (key === lastKey) return;
    lastKey = key;
    for (const task of tasks) {
      if (task.enabled && parsed.get(task.id) && cronMatches(parsed.get(task.id), d)) execute(task, false);
    }
  }

  load();
  const timer = setInterval(tick, 20000);
  timer.unref();

  return {
    list: () => tasks.map(x => ({ ...x, running: running.has(x.id) })),
    add(input) {
      if (tasks.length >= MAX_TASKS) return { error: t.tooMany };
      const r = normalise(input);
      if (r.error) return r;
      tasks.push(r.task); parsed.set(r.task.id, parseCron(r.task.cron)); save();
      return { task: r.task };
    },
    update(id, input) {
      const i = tasks.findIndex(x => x.id === id);
      if (i < 0) return { error: t.notFound };
      const r = normalise({ ...tasks[i], ...input }, tasks[i]);
      if (r.error) return r;
      tasks[i] = r.task; parsed.set(id, parseCron(r.task.cron)); save();
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

module.exports = { createScheduler, parseCron, cronMatches };
