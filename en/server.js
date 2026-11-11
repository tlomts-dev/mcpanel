/**
 * MC Panel - server.js (v5 - Player Intelligence Edition)
 */

require('dotenv').config();

const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const { WebSocketServer } = require('ws');
const { spawn, execSync, exec } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const fsp        = require('fs/promises');
const http       = require('http');
const crypto     = require('crypto');
const archiver   = require('archiver');
const unzipper   = require('unzipper');
const os         = require('os');
const zlib       = require('zlib');

let nbt = null;
try { nbt = require('prismarine-nbt'); }
catch { console.warn('[Panel] prismarine-nbt not installed — Reading saved NBT files will be disabled until you run npm install'); }

const PANEL_HTTP_PORT = parseInt(process.env.PANEL_HTTP_PORT || '28281', 10);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '8080', 10);
const SERVER_DIR  = path.resolve(process.env.MC_DIR || '/opt/minecraft');
const SERVER_JAR  = process.env.MC_JAR || 'spigot-26.3.jar';
const BACKUPS_DIR = path.join(SERVER_DIR, 'backups');
const STARTUP_CFG = path.join(SERVER_DIR, '.panel-startup.json');
const PLAYERS_DB_FILE = path.join(SERVER_DIR, '.panel-players.json');
const SESSION_SEC = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ── tmux config ───────────────────────────────────────────
const TMUX_SESSION = process.env.TMUX_SESSION || 'mcserver';
const MC_LOG_FILE  = path.join(SERVER_DIR, '.mc-panel.log');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_HASH = process.env.ADMIN_HASH || bcrypt.hashSync(process.env.ADMIN_PASS, 12);
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
const { createAuth, levelFor } = require('../lib/auth');
const auth = createAuth({ dir: SERVER_DIR, ownerUser: ADMIN_USER, ownerHash: ADMIN_HASH, t: {
  badUser: 'Username must be 3-32 characters (letters, digits, _ . -)',
  reservedUser: 'That name is reserved for the owner',
  badRole: 'Invalid role',
  badPassword: 'Password must be at least 8 characters',
  userExists: 'User already exists',
  tooMany: 'User limit reached',
  userNotFound: 'User not found',
  badCode: 'Invalid verification code',
  ownerPwEnv: 'The owner password is changed in the .env file',
  wrongPassword: 'Current password is wrong',
} });

// ── Validation ────────────────────────────────────────────────────────────────
const PLAYER_RE     = /^\.?[a-zA-Z0-9_]{1,16}$/;
const CMD_BLACKLIST = /[;&|`$(){}[\]<>\\]/;

function sanitizeCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const t = cmd.trim();
  if (!t || t.length > 256 || CMD_BLACKLIST.test(t)) return null;
  return t;
}
const sanitizePlayer = n => (typeof n === 'string' && PLAYER_RE.test(n.trim())) ? n.trim() : null;

function safePath(rel, baseDir = SERVER_DIR) {
  const target = path.resolve(baseDir, rel || '');
  const base   = path.resolve(baseDir);
  if (!target.startsWith(base + path.sep) && target !== base) return null;
  return target;
}

const EDITABLE_EXT = new Set([
  '.properties', '.yml', '.yaml', '.json', '.txt', '.log',
  '.cfg', '.conf', '.toml', '.md', '.sh', '.bat', '.html', '.js', '.css'
]);
const MAX_EDIT_SIZE = 2 * 1024 * 1024;

// ── Rate limit ────────────────────────────────────────────────────────────────
const loginAttempts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip, now = Date.now();
  let e = loginAttempts.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + 15*60*1000 }; loginAttempts.set(ip, e); }
  if (e.count >= 10)
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((e.resetAt-now)/1000)} seconds.` });
  e.count++;
  next();
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));
const sessionMw = session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000, httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true' ? true : process.env.COOKIE_SECURE === 'auto' ? 'auto' : false },
});
app.use(sessionMw);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session?.user && auth.roleOf(req.session.user)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── State ─────────────────────────────────────────────────────────────────────
let restartPending  = false;
let intentionalStop = false;
let serverVersion   = null;
let serverStartTime = null;
let lastTps         = null;
let mcPid           = null;
let logTailer       = null;
let tmuxMonitor     = null;
let lastCpu         = null;
let cpuSample       = null;
const CPU_CORES     = os.cpus().length || 1;
let clkTck = 100;
try { clkTck = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10) || 100; } catch {}

const HIDDEN_COMMANDS = new Set(['tps', 'list']);

const LOG_MAX   = 500;
const logBuffer = [];

function pushLog(line) { logBuffer.push(line); if (logBuffer.length > LOG_MAX) logBuffer.shift(); }

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
let playersDB   = {};
let playersDirty = false;

function loadPlayersDB() {
  try { playersDB = JSON.parse(fs.readFileSync(PLAYERS_DB_FILE, 'utf8')); }
  catch { playersDB = {}; }
}
function savePlayersDBNow() {
  try { fs.writeFileSync(PLAYERS_DB_FILE, JSON.stringify(playersDB), 'utf8'); playersDirty = false; }
  catch (e) { console.error('[Panel] Failed to save the player database:', e.message); }
}
setInterval(() => { if (playersDirty) savePlayersDBNow(); }, 5000);

function getPlayerRecord(name) {
  const key = name.toLowerCase();
  if (!playersDB[key]) {
    playersDB[key] = {
      name, uuid: null,
      firstSeen: Date.now(), lastSeen: Date.now(), lastLeft: null,
      joinCount: 0, online: false,
      deaths: [], teleports: [],
    };
  }
  playersDB[key].name = name;
  return playersDB[key];
}

function markJoin(name) {
  const p = getPlayerRecord(name);
  if (!p.online) p.joinCount = (p.joinCount || 0) + 1;
  p.online = true;
  p.lastSeen = Date.now();
  playersDirty = true;
}
function markLeave(name) {
  const key = name.toLowerCase();
  if (!playersDB[key]) return;
  playersDB[key].online = false;
  playersDB[key].lastLeft = Date.now();
  playersDirty = true;
}
function syncOnlineFromList(names) {
  const nowOnline = new Set(names.map(n => n.toLowerCase()));
  for (const key of Object.keys(playersDB)) {
    if (playersDB[key].online && !nowOnline.has(key)) {
      playersDB[key].online = false;
      playersDB[key].lastLeft = Date.now();
      playersDirty = true;
    }
  }
  names.forEach(n => markJoin(n));
}
const MAX_EVENTS_PER_PLAYER = 60;
function addDeath(name, entry) {
  const p = getPlayerRecord(name);
  p.deaths.push(entry);
  if (p.deaths.length > MAX_EVENTS_PER_PLAYER) p.deaths.shift();
  playersDirty = true;
  broadcast({ type: 'playerevent', kind: 'death', player: name, entry });
}
function addTeleport(name, entry) {
  const p = getPlayerRecord(name);
  p.teleports.push(entry);
  if (p.teleports.length > MAX_EVENTS_PER_PLAYER) p.teleports.shift();
  playersDirty = true;
  broadcast({ type: 'playerevent', kind: 'teleport', player: name, entry });
}
loadPlayersDB();

function offlineUuidFor(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function resolveUuid(name) {
  const rec = getPlayerRecord(name);
  if (rec.uuid) return { uuid: rec.uuid, guessed: false };
  try {
    const p = path.join(SERVER_DIR, 'usercache.json');
    if (fs.existsSync(p)) {
      const cache = JSON.parse(await fsp.readFile(p, 'utf8'));
      const hit = cache.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
      if (hit?.uuid) { rec.uuid = hit.uuid; playersDirty = true; return { uuid: hit.uuid, guessed: false }; }
    }
  } catch {}
  for (const file of ['ops.json', 'whitelist.json', 'banned-players.json']) {
    try {
      const p = path.join(SERVER_DIR, file);
      if (!fs.existsSync(p)) continue;
      const list = JSON.parse(await fsp.readFile(p, 'utf8'));
      const hit = list.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
      if (hit?.uuid) { rec.uuid = hit.uuid; playersDirty = true; return { uuid: hit.uuid, guessed: false }; }
    } catch {}
  }
  const off = offlineUuidFor(name);
  return { uuid: off, guessed: true };
}

function getWorldName() {
  try {
    const txt = fs.readFileSync(PROPS_FILE, 'utf8');
    const m = txt.match(/^level-name=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return 'world';
}

// Minecraft 26.1+ moved per-player files into <world>/players/{data,stats,advancements}/.
// Older versions keep them in <world>/{playerdata,stats,advancements}/. Support both layouts.
function playerFilePath(world, kind, uuid) {
  const ext = kind === 'playerdata' ? '.dat' : '.json';
  const modern = path.join(SERVER_DIR, world, 'players', kind === 'playerdata' ? 'data' : kind, uuid + ext);
  const legacy = path.join(SERVER_DIR, world, kind, uuid + ext);
  if (fs.existsSync(modern)) return modern;
  if (fs.existsSync(legacy)) return legacy;
  return fs.existsSync(path.join(SERVER_DIR, world, 'players')) ? modern : legacy;
}

async function readPlayerStats(uuid) {
  try {
    const p = playerFilePath(getWorldName(), 'stats', uuid);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(await fsp.readFile(p, 'utf8'));
    // Minecraft 1.12 and older use a flat "stat.xxx" file instead of the nested namespaced format
    if (!j.stats && Object.keys(j).some(k => k.startsWith('stat.'))) {
      const lm = k => (j['stat.' + k] || 0) / 100;
      return {
        deaths: j['stat.deaths'] ?? 0, playerKills: j['stat.playerKills'] ?? 0, mobKills: j['stat.mobKills'] ?? 0,
        playTimeTicks: j['stat.playOneMinute'] ?? 0,
        distances: {
          walk: lm('walkOneCm'), sprint: lm('sprintOneCm'), swim: lm('swimOneCm'), fall: lm('fallOneCm'),
          climb: lm('climbOneCm'), boat: lm('boatOneCm'), elytra: lm('aviateOneCm'), horse: lm('horseOneCm'),
        },
        topMined: [],
      };
    }
    const custom = j.stats?.['minecraft:custom'] || {};
    const mined  = j.stats?.['minecraft:mined']  || {};
    const cm = k => (custom[`minecraft:${k}`] || 0) / 100;
    const topMined = Object.entries(mined)
      .map(([k, v]) => ({ block: k.replace('minecraft:', ''), count: v }))
      .sort((a, b) => b.count - a.count).slice(0, 8);
    return {
      deaths:      custom['minecraft:deaths'] ?? 0,
      playerKills: custom['minecraft:player_kills'] ?? 0,
      mobKills:    custom['minecraft:mob_kills'] ?? 0,
      playTimeTicks: custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute'] ?? 0,
      distances: {
        walk: cm('walk_one_cm'), sprint: cm('sprint_one_cm'), swim: cm('swim_one_cm'),
        fall: cm('fall_one_cm'), climb: cm('climb_one_cm'), boat: cm('boat_one_cm'),
        elytra: cm('aviate_one_cm'), horse: cm('horse_one_cm'),
      },
      topMined,
    };
  } catch { return null; }
}

function normalizeLiveStats(s) {
  if (!s) return null;
  return {
    deaths: s.deaths ?? 0, playerKills: s.playerKills ?? 0, mobKills: s.mobKills ?? 0,
    playTimeTicks: s.playTimeTicks ?? 0,
    distances: s.distances || {},
    topMined: [],
  };
}

const ARMOR_SLOT_NAME = { 100: 'boots', 101: 'leggings', 102: 'chestplate', 103: 'helmet' };

const MAX_DURABILITY = {
  wooden_sword:59, wooden_pickaxe:59, wooden_axe:59, wooden_shovel:59, wooden_hoe:59,
  stone_sword:131, stone_pickaxe:131, stone_axe:131, stone_shovel:131, stone_hoe:131,
  iron_sword:250, iron_pickaxe:250, iron_axe:250, iron_shovel:250, iron_hoe:250,
  golden_sword:32, golden_pickaxe:32, golden_axe:32, golden_shovel:32, golden_hoe:32,
  diamond_sword:1561, diamond_pickaxe:1561, diamond_axe:1561, diamond_shovel:1561, diamond_hoe:1561,
  netherite_sword:2031, netherite_pickaxe:2031, netherite_axe:2031, netherite_shovel:2031, netherite_hoe:2031,
  bow:384, crossbow:465, trident:250, shield:336, fishing_rod:64, flint_and_steel:64,
  shears:238, carrot_on_a_stick:25, warped_fungus_on_a_stick:100, elytra:432, brush:64,
  leather_helmet:55, leather_chestplate:80, leather_leggings:75, leather_boots:65,
  golden_helmet:77, golden_chestplate:112, golden_leggings:105, golden_boots:91,
  chainmail_helmet:165, chainmail_chestplate:240, chainmail_leggings:225, chainmail_boots:195,
  iron_helmet:165, iron_chestplate:240, iron_leggings:225, iron_boots:195,
  diamond_helmet:363, diamond_chestplate:528, diamond_leggings:495, diamond_boots:429,
  netherite_helmet:407, netherite_chestplate:592, netherite_leggings:555, netherite_boots:481,
  turtle_helmet:275,
};

function extractEnchantmentsNbt(it) {
  const list = [];
  const comp = it.components?.['minecraft:enchantments'] || it.components?.['minecraft:stored_enchantments'];
  if (comp) {
    const levels = comp.levels || comp;
    if (levels && typeof levels === 'object') {
      Object.entries(levels).forEach(([k, v]) => { if (typeof v === 'number') list.push({ id: k.replace('minecraft:', ''), level: v }); });
    }
  }
  const legacy = it.tag?.Enchantments || it.tag?.ench;
  if (Array.isArray(legacy)) {
    legacy.forEach(e => {
      const id = e?.id != null ? String(e.id).replace('minecraft:', '') : null;
      const lvl = e?.lvl ?? e?.Level;
      if (id != null && lvl != null) list.push({ id, level: lvl });
    });
  }
  return list;
}

function buildPlayerDataResult(d, live) {
  const pos = Array.isArray(d.Pos) ? d.Pos : null;
  const mkItem = it => {
    const id = String(it.id || '').replace('minecraft:', '');
    const enchantments = extractEnchantmentsNbt(it);
    const result = {
      id, count: it.count ?? it.Count ?? 1,
      enchanted: enchantments.length > 0,
      enchantments,
    };
    const maxDur = MAX_DURABILITY[id];
    if (maxDur) {
      const dmg = it.components?.['minecraft:damage'] ?? it.tag?.Damage ?? 0;
      result.durability = { current: Math.max(0, maxDur - dmg), max: maxDur };
    }
    try {
      const trim = it.components?.['minecraft:trim'] || it.tag?.Trim; // 1.20.5+ component, or the older item tag
      if (trim) {
        const pattern  = (typeof trim.pattern  === 'string' ? trim.pattern  : trim.pattern?.key  || trim.pattern?.id  || '').replace('minecraft:', '');
        const material = (typeof trim.material === 'string' ? trim.material : trim.material?.key || trim.material?.id || '').replace('minecraft:', '');
        if (pattern && material) result.trim = { pattern, material };
      }
    } catch {}
    try {
      const container = it.components?.['minecraft:container'];
      if (Array.isArray(container)) {
        result.contents = container.filter(e => e?.item?.id).map(e => ({ slot: e.slot ?? 0, ...mkItem(e.item) }));
      }
    } catch {}
    return result;
  };

  const main = [];
  const armor = { helmet: null, chestplate: null, leggings: null, boots: null };
  let offhand = null;
  (Array.isArray(d.Inventory) ? d.Inventory : []).forEach(it => {
    if (!it || !it.id) return;
    const slot = it.Slot ?? it.slot;
    if (slot === -106) { offhand = mkItem(it); return; }
    if (ARMOR_SLOT_NAME[slot]) { armor[ARMOR_SLOT_NAME[slot]] = mkItem(it); return; }
    if (slot >= 0 && slot <= 35) main.push({ slot, ...mkItem(it) });
  });
  const enderChest = (Array.isArray(d.EnderItems) ? d.EnderItems : [])
    .filter(it => it && it.id)
    .map(it => ({ slot: it.Slot ?? it.slot ?? 0, ...mkItem(it) }));

  return {
    available: true,
    live: !!live,
    dimension: d.Dimension || d.World || null,
    pos: pos ? { x: pos[0], y: pos[1], z: pos[2] } : null,
    health: d.Health ?? null,
    maxHealth: 20,
    food: d.foodLevel ?? d.FoodLevel ?? null,
    xpLevel: d.XpLevel ?? null,
    xpTotal: d.XpTotal ?? null,
    gameMode: d.playerGameType ?? d.PlayerGameType ?? null,
    inventory: main,
    armor,
    offhand,
    enderChest,
  };
}

function normalizeHttpPlayerData(j) {
  if (!j || j.online === false) return null;
  const gmMap  = { SURVIVAL: 0, CREATIVE: 1, ADVENTURE: 2, SPECTATOR: 3 };
  const dimMap = { NORMAL: 'minecraft:overworld', NETHER: 'minecraft:the_nether', THE_END: 'minecraft:the_end' };
  const mkItem = it => it ? {
    id: String(it.id || ''), count: it.count ?? 1,
    enchanted: !!it.enchanted,
    enchantments: Array.isArray(it.enchantments) ? it.enchantments : [],
    durability: it.durability || null,
    trim: it.trim || null,
    contents: Array.isArray(it.contents) ? it.contents.map(mkSlotItem).filter(Boolean) : undefined,
  } : null;
  const mkSlotItem = it => it ? { slot: it.slot ?? 0, ...mkItem(it) } : null;
  return {
    available: true,
    live: true,
    dimension: dimMap[j.dimension] || j.world || null,
    pos: j.pos || null,
    health: j.health ?? null,
    maxHealth: j.maxHealth ?? 20,
    food: j.food ?? null,
    xpLevel: j.xpLevel ?? null,
    xpTotal: j.xpTotal ?? null,
    gameMode: gmMap[j.gameMode] ?? null,
    inventory: Array.isArray(j.inventory) ? j.inventory.map(mkSlotItem) : [],
    armor: {
      helmet: mkItem(j.armor?.helmet), chestplate: mkItem(j.armor?.chestplate),
      leggings: mkItem(j.armor?.leggings), boots: mkItem(j.armor?.boots),
    },
    offhand: mkItem(j.offhand),
    enderChest: Array.isArray(j.enderChest) ? j.enderChest.map(mkSlotItem) : [],
  };
}

async function queryPluginHttp(name) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${PANEL_HTTP_PORT}/player/${encodeURIComponent(name)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function readPlayerDataFromFile(uuid) {
  if (!nbt) return { available: false, reason: 'The prismarine-nbt library is not installed on the server (npm install)' };
  try {
    const p = playerFilePath(getWorldName(), 'playerdata', uuid);
    if (!fs.existsSync(p)) return { available: false, reason: 'No data file at path: ' + p };
    const buf = await fsp.readFile(p);
    const { parsed } = await nbt.parse(buf);
    const d = nbt.simplify(parsed);
    return buildPlayerDataResult(d, false);
  } catch (e) {
    return { available: false, reason: 'Could not read/parse file NBT: ' + e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════

function isRunning() {
  try {
    execSync(`TMUX= tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function getMcPid() {
  try {
    const out = execSync("pgrep -f '" + SERVER_JAR + "'").toString().trim();
    if (!out) return null;
    const pids = out.split('\n').filter(Boolean);
    let best = null, bestRss = 0;
    for (const pid of pids) {
      try {
        const comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim();
        if (comm !== 'java') continue;
        const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
        const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
        const rss = m ? parseInt(m[1]) : 0;
        if (rss > bestRss) { bestRss = rss; best = parseInt(pid); }
      } catch {}
    }
    return best;
  } catch { return null; }
}

function sendCommand(cmd) {
  if (!isRunning()) return;
  const hidden = HIDDEN_COMMANDS.has(cmd.trim().toLowerCase());
  try {
    const safe = cmd.replace(/'/g, "'\\''");
    execSync(`TMUX= tmux send-keys -t ${TMUX_SESSION} '${safe}' Enter`);
    if (!hidden) {
      const echo = `> ${cmd}\n`;
      pushLog(echo);
      broadcast({ type: 'log', data: echo });
    }
  } catch (e) {
    console.error('[Panel] Failed to send tmux command:', e.message);
  }
}

// ── ANSI escape code stripper ─────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]|\x1b\][^\x07]*\x07|\x1b[()][AB0-9]/g;
function stripAnsi(str) { return str.replace(ANSI_RE, ''); }

function extractPlayerName(segment) {
  const bracket = segment.match(/<([a-zA-Z0-9_.]{1,16})>/);
  if (bracket) return bracket[1];
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function parseLogLine(line) {
  const vm = line.match(/Starting minecraft server version (.+)/i);
  if (vm) { serverVersion = vm[1].trim(); broadcast({ type: 'info', version: serverVersion }); }

  const tpsMatch = line.match(/TPS from last[^:]*:\s*\*?([\d.]+)/i);
  if (tpsMatch) {
    lastTps = parseFloat(tpsMatch[1]);
    broadcast({ type: 'stats', tps: lastTps });
    return true;
  }

  const listMatch = line.match(/players online:\s*(.*)/i);
  if (listMatch) {
    const players = listMatch[1].split(',').map(s => {
      const name = extractPlayerName(s);
      return { name, display: name };
    }).filter(p => p.name && PLAYER_RE.test(p.name));
    syncOnlineFromList(players.map(p => p.name));
    live.players = players.length;
    broadcast({ type: 'players', list: players });
    return true;
  }

  const joinMatch = line.match(/]: (\S{1,16}) joined the game/i) || line.match(/]: (\S{1,16})\[.*?logged in/i);
  if (joinMatch && PLAYER_RE.test(joinMatch[1])) markJoin(joinMatch[1]);
  const leftMatch = line.match(/]: (\S{1,16}) left the game/i);
  if (leftMatch && PLAYER_RE.test(leftMatch[1])) markLeave(leftMatch[1]);

  //                     [PanelData] TELEPORT|player|cause|fromWorld|fx|fy|fz|toWorld|tx|ty|tz
  const pd = line.match(/\[PanelData\]\s*(DEATH|TELEPORT)\|([^\r\n]*)/);
  if (pd) {
    const parts = pd[2].split('|');
    try {
      if (pd[1] === 'DEATH') {
        const [player, world, x, y, z, ...causeParts] = parts;
        if (player && PLAYER_RE.test(player)) {
          addDeath(player, {
            t: Date.now(), world,
            x: parseFloat(x), y: parseFloat(y), z: parseFloat(z),
            cause: causeParts.join('|') || 'Unknown',
          });
        }
      } else {
        const [player, cause, fromWorld, fx, fy, fz, toWorld, tx, ty, tz] = parts;
        if (player && PLAYER_RE.test(player)) {
          addTeleport(player, {
            t: Date.now(), cause: cause || 'UNKNOWN',
            from: { world: fromWorld, x: parseFloat(fx), y: parseFloat(fy), z: parseFloat(fz) },
            to:   { world: toWorld,   x: parseFloat(tx), y: parseFloat(ty), z: parseFloat(tz) },
          });
        }
      }
    } catch (e) { console.error('[Panel] Failed to parse line PanelData:', e.message); }
    return true;
  }

  return false;
}

function startLogTailer() {
  if (logTailer) {
    try { logTailer.kill(); } catch {}
    logTailer = null;
  }

  setTimeout(() => {
    if (!fs.existsSync(MC_LOG_FILE)) {
      fs.writeFileSync(MC_LOG_FILE, '');
    }

    logTailer = spawn('tail', ['-f', '-n', '0', MC_LOG_FILE]);

    logTailer.stdout.on('data', d => {
      const raw  = d.toString();
      const line = stripAnsi(raw);
      const hidden = parseLogLine(line);
      if (!hidden) {
        pushLog(line);
        broadcast({ type: 'log', data: line });
      }
      checkServerReady(line);
    });

    logTailer.on('close', () => {
      logTailer = null;
    });
  }, 1500);
}

function startTmuxMonitor() {
  if (tmuxMonitor) { clearInterval(tmuxMonitor); tmuxMonitor = null; }

  tmuxMonitor = setInterval(() => {
    if (isRunning()) {
      const pid = getMcPid();
      if (pid) mcPid = pid;
      return;
    }

    clearInterval(tmuxMonitor);
    tmuxMonitor = null;

    setTimeout(() => {
      if (logTailer) { try { logTailer.kill(); } catch {} logTailer = null; }
    }, 2000);

    const msg = `\n[Panel] Server stopped\n`;
    pushLog(msg);
    broadcast({ type: 'log',    data: msg });
    broadcast({ type: 'status', running: false });

    serverStartTime = null;
    lastTps         = null;
    mcPid           = null;
    lastCpu         = null;
    cpuSample       = null;
    serverReady     = false;
    if (!intentionalStop && !restartPending) monitor.event('crash', 'Server stopped unexpectedly. Restarting automatically.');

    if (restartPending || !intentionalStop) {
      restartPending = false;
      const restartMsg = '[Panel] Auto-restarting in 5 seconds...\n';
      pushLog(restartMsg);
      broadcast({ type: 'log', data: restartMsg });
      setTimeout(() => {
        if (!intentionalStop) startMC();
      }, 5000);
    }
  }, 3000);
}

// ── Startup JVM config ────────────────────────────────────────────────────────
function loadStartupCfg() {
  try { return JSON.parse(fs.readFileSync(STARTUP_CFG, 'utf8')); }
  catch { return { xms: '1G', xmx: '2G', g1gc: true, extraFlags: '' }; }
}

function buildJvmArgs(cfg) {
  const args = [`-Xms${cfg.xms}`, `-Xmx${cfg.xmx}`];
  if (cfg.g1gc) args.push(
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
    '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1'
  );
  if (cfg.extraFlags) args.push(...cfg.extraFlags.split(/\s+/).filter(Boolean));
  return args;
}

function startMC() {
  if (isRunning()) return false;

  intentionalStop = false;

  const cfg  = loadStartupCfg();
  const args = buildJvmArgs(cfg);

  serverVersion   = null;
  serverStartTime = Date.now();
  lastTps         = null;
  mcPid           = null;
  lastCpu         = null;
  cpuSample       = null;

  try { fs.writeFileSync(MC_LOG_FILE, ''); } catch {}

  const javaCmd = `java ${args.join(' ')} -jar ${SERVER_JAR} nogui`;

  const tmuxCmd = [
    'tmux', 'new-session', '-d',
    '-s', TMUX_SESSION,
    '-c', SERVER_DIR,
    `sh -c "${javaCmd.replace(/"/g, '\\"')} 2>&1 | tee -a '${MC_LOG_FILE}'; echo '[MCSERVER_EXIT]' >> '${MC_LOG_FILE}'"`
  ];

  try {
    const cmdStr = 'TMUX= ' + tmuxCmd.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    execSync(cmdStr);
  } catch (e) {
    console.error('[Panel] Failed to start tmux session:', e.message);
    serverStartTime = null;
    return false;
  }

  console.log(`[Panel] Started MC server in tmux session: ${TMUX_SESSION}`);
  console.log(`[Panel] Log file: ${MC_LOG_FILE}`);

  startLogTailer();
  startTmuxMonitor();

  broadcast({ type: 'status', running: true });
  monitor.event('started', 'Server started.');
  return true;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const who = auth.verify(username, password);
  if (!who) {
    auth.audit(String(username || '').slice(0, 32), req.ip, 'LOGIN_FAILED', '');
    return res.status(401).json({ error: 'Wrong credentials' });
  }
  if (auth.twoFa.enabled(who.username) && !auth.twoFa.check(who.username, (req.body || {}).code)) {
    auth.audit(who.username, req.ip, 'LOGIN_2FA_FAILED', '');
    return res.status(401).json({ error: (req.body || {}).code ? 'Invalid verification code' : 'Enter your two-factor code', needCode: true });
  }
  loginAttempts.delete(req.ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.user = who.username;
    auth.audit(who.username, req.ip, 'LOGIN', who.role);
    res.json({ success: true, role: who.role });
  });
});

app.post('/api/logout', (req, res) => { auth.audit(req.session && req.session.user, req.ip, 'LOGOUT', ''); req.session.destroy(() => res.json({ success: true })); });

// ── Roles: every /api route below needs a minimum role (see lib/auth.js) ──────
app.use('/api', (req, res, next) => {
  const user = req.session && req.session.user, role = user && auth.roleOf(user);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  if (auth.ROLES[role] < levelFor(req.method, req.path)) {
    auth.audit(user, req.ip, 'DENIED ' + req.method + ' ' + req.path, '');
    return res.status(403).json({ error: 'You do not have permission for this action' });
  }
  req.user = user; req.role = role;
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) auth.audit(user, req.ip, req.method + ' ' + req.originalUrl.split('?')[0], auth.describeBody(req.body));
    });
  }
  next();
});

app.get('/api/me', (req, res) => res.json({ username: req.user, role: req.role, level: auth.ROLES[req.role], twoFa: auth.twoFa.enabled(req.user) }));
app.post('/api/me/password', (req, res) => {
  const r = auth.changeOwnPassword(req.user, (req.body || {}).current, (req.body || {}).newPassword);
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.post('/api/me/2fa/begin', (req, res) => res.json(auth.twoFa.begin(req.user)));
app.post('/api/me/2fa/confirm', (req, res) => {
  const r = auth.twoFa.confirm(req.user, (req.body || {}).code);
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.post('/api/me/2fa/disable', (req, res) => {
  const b = req.body || {}, r = auth.twoFa.disable(req.user, b.password, b.code);
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.get('/api/users', (_req, res) => res.json({ users: auth.list() }));
app.post('/api/users', (req, res) => {
  const b = req.body || {}, r = auth.add(String(b.username || ''), b.password, b.role);
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.post('/api/users/update', (req, res) => {
  const b = req.body || {}, r = auth.update(String(b.username || ''), { role: b.role, password: b.password });
  if (!r.error && b.resetTotp) auth.twoFa.reset(String(b.username));
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.post('/api/users/delete', (req, res) => {
  const r = auth.remove(String((req.body || {}).username || ''));
  r.error ? res.status(404).json({ error: r.error }) : res.json({ success: true });
});
app.get('/api/audit', (_req, res) => res.json({ entries: auth.readAudit(200) }));

app.get('/api/status', requireAuth, (_req, res) => res.json({
  running: isRunning(),
  version: serverVersion,
  uptime:  serverStartTime ? Date.now() - serverStartTime : null,
  tps:     lastTps,
  pid:     mcPid || null,
}));

// ── Server control ────────────────────────────────────────────────────────────
app.post('/api/start', requireAuth, (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'Already running' });
  intentionalStop = false;
  const ok = startMC();
  if (!ok) return res.status(500).json({ error: 'Failed to start the server' });
  res.json({ success: true });
});

app.post('/api/stop', requireAuth, (_req, res) => {
  if (!isRunning()) return res.status(409).json({ error: 'Stopped' });
  restartPending  = false;
  intentionalStop = true;
  sendCommand('stop');
  res.json({ success: true });
});

app.post('/api/restart', requireAuth, (_req, res) => {
  if (!isRunning()) {
    intentionalStop = false;
    const ok = startMC();
    if (!ok) return res.status(500).json({ error: 'Failed to start the server' });
    return res.json({ success: true });
  }
  restartPending  = true;
  intentionalStop = false;
  sendCommand('stop');
  res.json({ success: true });
});

app.post('/api/command', requireAuth, (req, res) => {
  const cmd = sanitizeCommand(req.body.command);
  if (cmd && !auth.commandAllowed(req.role, cmd)) return res.status(403).json({ error: 'This command is not allowed for your role' });
  if (!cmd)         return res.status(400).json({ error: 'Invalid command' });
  if (!isRunning()) return res.status(409).json({ error: 'Server is stopped' });
  sendCommand(cmd);
  res.json({ success: true });
});

// ── Server info ───────────────────────────────────────────────────────────────
app.get('/api/info', requireAuth, async (_req, res) => {
  let diskFree = null, diskTotal = null;
  try {
    const df = execSync(`df -k "${SERVER_DIR}" 2>/dev/null`).toString().split('\n')[1];
    if (df) {
      const p = df.trim().split(/\s+/);
      diskTotal = parseInt(p[1]) * 1024;
      diskFree  = parseInt(p[3]) * 1024;
    }
  } catch {}

  res.json({
    running:   isRunning(),
    version:   serverVersion,
    jar:       SERVER_JAR,
    serverDir: SERVER_DIR,
    pid:       mcPid || null,
    uptime:    serverStartTime ? Date.now() - serverStartTime : null,
    tps:       lastTps,
    diskFree,
    diskTotal,
  });
});

// ── Timed bans ───────────────────────────────────────────────────────────────
const { createTempBans } = require('../lib/tempbans');
const tempBans = createTempBans({ dir: SERVER_DIR, isRunning, pardon: n => sendCommand(`pardon ${n}`) });
app.post('/api/player/tempban', (req, res) => {
  const b = req.body || {}, p = sanitizePlayer(b.player);
  if (!p) return res.status(400).json({ error: 'Invalid player name' });
  const minutes = parseInt(b.minutes, 10) || 0;
  if (minutes < 0 || minutes > 525600) return res.status(400).json({ error: 'Invalid duration' });
  const raw = String(b.reason || '').trim().slice(0, 100), reason = raw ? sanitizeCommand(raw) : '';
  if (raw && !reason) return res.status(400).json({ error: 'Invalid reason' });
  if (!isRunning()) return res.status(409).json({ error: 'Server is stopped' });
  sendCommand('ban ' + p + (reason ? ' ' + reason : ''));
  minutes > 0 ? tempBans.add(p, minutes) : tempBans.remove(p);
  res.json({ success: true });
});

// ── Player actions ────────────────────────────────────────────────────────────
const PLAYER_ACTIONS = {
  op:    p => `op ${p}`,
  deop:  p => `deop ${p}`,
  ban:   p => `ban ${p}`,
  kick:  p => `kick ${p}`,
  unban: p => `pardon ${p}`,
  heal:  p => `effect give ${p} minecraft:instant_health 1 9`,
  feed:  p => `effect give ${p} minecraft:saturation 1 9`,
  kill:  p => `kill ${p}`,
};
Object.entries(PLAYER_ACTIONS).forEach(([action, fn]) => {
  app.post(`/api/player/${action}`, requireAuth, (req, res) => {
    const p = sanitizePlayer(req.body.player);
    if (!p)           return res.status(400).json({ error: 'Invalid player name' });
    if (!isRunning()) return res.status(409).json({ error: 'Server is stopped' });
    sendCommand(fn(p));
    if (action === 'ban' || action === 'pardon') tempBans.remove(p);
    res.json({ success: true });
  });
});

// ── Player lists ──────────────────────────────────────────────────────────────
async function readJsonFile(filename) {
  try {
    const p = path.join(SERVER_DIR, filename);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch { return []; }
}

app.get('/api/ops',       requireAuth, async (_req, res) => {
  const ops = await readJsonFile('ops.json');
  res.json({ ops: ops.map(o => ({ name: o.name || o, uuid: o.uuid, level: o.level })) });
});
app.get('/api/bans',      requireAuth, async (_req, res) => {
  const bans = await readJsonFile('banned-players.json');
  const timed = tempBans.list();
  res.json({ bans: bans.map(b => ({ name: b.name, reason: b.reason, created: b.created, expires: timed[b.name] || null })) });
});
app.get('/api/whitelist', requireAuth, async (_req, res) => {
  const list = await readJsonFile('whitelist.json');
  res.json({ whitelist: list.map(w => ({ name: w.name || w, uuid: w.uuid })) });
});

app.get('/api/players/all', requireAuth, (_req, res) => {
  const list = Object.values(playersDB).map(p => ({
    name: p.name, online: !!p.online,
    firstSeen: p.firstSeen, lastSeen: p.lastSeen, lastLeft: p.lastLeft,
    joinCount: p.joinCount || 0,
    deathCount: (p.deaths || []).length, teleportCount: (p.teleports || []).length,
  })).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
  res.json({ players: list, total: list.length });
});

app.get('/api/players/detail', requireAuth, async (req, res) => {
  const name = sanitizePlayer(req.query.name);
  if (!name) return res.status(400).json({ error: 'Invalid player name' });
  const rec = getPlayerRecord(name);
  const { uuid, guessed } = await resolveUuid(name);
  const worldName = getWorldName();

  const liveJson = rec.online ? await queryPluginHttp(rec.name) : null;

  let data = normalizeHttpPlayerData(liveJson);
  if (!data) data = await readPlayerDataFromFile(uuid);

  let stats = (liveJson && liveJson.online) ? normalizeLiveStats(liveJson.stats) : null;
  if (!stats) stats = await readPlayerStats(uuid);

  res.json({
    name: rec.name, online: !!rec.online,
    firstSeen: rec.firstSeen, lastSeen: rec.lastSeen, lastLeft: rec.lastLeft,
    joinCount: rec.joinCount || 0, uuid,
    deaths: (rec.deaths || []).slice().reverse(),
    teleports: (rec.teleports || []).slice().reverse(),
    stats, data,
    debug: {
      worldName, uuidGuessed: guessed,
      statsPath: playerFilePath(worldName, 'stats', uuid),
      playerDataPath: playerFilePath(worldName, 'playerdata', uuid),
    },
  });
});

app.post('/api/players/delete-data', requireAuth, async (req, res) => {
  const name = sanitizePlayer(req.body.name);
  if (!name) return res.status(400).json({ error: 'Invalid player name' });
  const parts = req.body.parts || {};
  const rec = getPlayerRecord(name);
  if (rec.online) return res.status(409).json({ error: 'Cannot delete data of a player who is online — Remove them from the server first' });

  const { uuid } = await resolveUuid(name);
  const worldName = getWorldName();
  const results = {};

  if ((parts.inventory || parts.enderChest || parts.xp)) {
    if (!nbt) return res.status(500).json({ error: 'The prismarine-nbt library is not installed on the server (npm install)' });
    try {
      const p = playerFilePath(worldName, 'playerdata', uuid);
      if (fs.existsSync(p)) {
        const buf = await fsp.readFile(p);
        const { parsed } = await nbt.parse(buf);
        const root = parsed.value;
        if (parts.inventory && root.Inventory) {
          root.Inventory.value.value = [];
          results.inventory = true;
        }
        if (parts.enderChest && root.EnderItems) {
          root.EnderItems.value.value = [];
          results.enderChest = true;
        }
        if (parts.xp) {
          if (root.XpLevel) root.XpLevel.value = 0;
          if (root.XpTotal) root.XpTotal.value = 0;
          if (root.XpP) root.XpP.value = 0;
          results.xp = true;
        }
        const outBuf = nbt.writeUncompressed(parsed, 'big');
        await fsp.writeFile(p, zlib.gzipSync(outBuf));
      } else {
        results.fileNotFound = true;
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to modify the player file: ' + e.message });
    }
  }

  if (parts.stats) {
    try {
      const p = playerFilePath(worldName, 'stats', uuid);
      if (fs.existsSync(p)) await fsp.unlink(p);
      results.stats = true;
    } catch {}
  }
  if (parts.advancements) {
    try {
      const p = playerFilePath(worldName, 'advancements', uuid);
      if (fs.existsSync(p)) await fsp.unlink(p);
      results.advancements = true;
    } catch {}
  }
  if (parts.panelHistory) {
    const key = name.toLowerCase();
    if (playersDB[key]) {
      playersDB[key].deaths = [];
      playersDB[key].teleports = [];
      playersDirty = true;
    }
    results.panelHistory = true;
  }

  res.json({ success: true, results });
});

// ── Files API ─────────────────────────────────────────────────────────────────
app.get('/api/files', requireAuth, async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  try {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter(e => !e.name.startsWith('.'))
      .map(async e => {
        const full = path.join(abs, e.name);
        let size = 0, mtime = null;
        try { const st = await fsp.stat(full); if (e.isFile()) size = st.size; mtime = st.mtime.getTime(); } catch {}
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, mtime };
      }));
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ files });
  } catch { res.status(500).json({ error: 'Failed to read the folder' }); }
});

app.get('/api/files/read', requireAuth, async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile())            return res.status(400).json({ error: 'Not a file' });
    if (stat.size > MAX_EDIT_SIZE) return res.status(413).json({ error: 'File is too large (>2MB)' });
    const ext = path.extname(abs).toLowerCase();
    if (!EDITABLE_EXT.has(ext))    return res.status(415).json({ error: 'File type cannot be edited' });
    const content = await fsp.readFile(abs, 'utf8');
    res.json({ content });
  } catch { res.status(500).json({ error: 'Failed to read the file' }); }
});

app.post('/api/files/write', requireAuth, async (req, res) => {
  const rel = String(req.body.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  const content = String(req.body.content ?? '');
  if (content.length > MAX_EDIT_SIZE) return res.status(413).json({ error: 'Content is too large' });
  const ext = path.extname(abs).toLowerCase();
  if (!EDITABLE_EXT.has(ext)) return res.status(415).json({ error: 'File type cannot be edited' });
  try {
    await fsp.writeFile(abs, content, 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Write failed' }); }
});

app.post('/api/files/upload', requireAuth, (req, res) => {
  const relPath = decodeURIComponent(req.headers['x-path'] || '');
  const fileName = decodeURIComponent(req.headers['x-filename'] || '');
  const absDir = safePath(relPath);
  if (!absDir) return res.status(400).json({ error: 'Invalid path' });
  const absFile = path.join(absDir, fileName);
  if (!absFile.startsWith(SERVER_DIR)) return res.status(400).json({ error: 'Invalid path' });

  const writeStream = fs.createWriteStream(absFile);
  req.pipe(writeStream);
  req.on('end', () => res.json({ success: true }));
  req.on('error', () => res.status(500).json({ error: 'Upload failed' }));
});

app.get('/api/files/download', requireAuth, async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'Folders cannot be downloaded directly' });
    res.download(abs, path.basename(abs));
  } catch { res.status(404).json({ error: 'File not found' }); }
});

app.post('/api/files/delete', requireAuth, async (req, res) => {
  const rel = String(req.body.path || '');
  const abs = safePath(rel);
  if (!abs)               return res.status(400).json({ error: 'Invalid path' });
  if (abs === SERVER_DIR) return res.status(400).json({ error: 'Cannot delete the root' });
  try {
    await fsp.rm(abs, { recursive: true, force: true });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Delete failed' }); }
});

app.post('/api/files/rename', requireAuth, async (req, res) => {
  const relFrom = String(req.body.path || '');
  const newName = String(req.body.newName || '').trim();
  const absFrom = safePath(relFrom);
  if (!absFrom)  return res.status(400).json({ error: 'Invalid path' });
  if (!newName || /[\\/]/.test(newName) || newName === '.' || newName === '..')
    return res.status(400).json({ error: 'Invalid name' });
  const absTo = path.join(path.dirname(absFrom), newName);
  if (!safePath(path.relative(SERVER_DIR, absTo))) return res.status(400).json({ error: 'Invalid target path' });
  try {
    if (fs.existsSync(absTo)) return res.status(409).json({ error: 'A file/folder with that name already exists' });
    await fsp.rename(absFrom, absTo);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Rename failed' }); }
});

// ── Monitoring history + alerts ──────────────────────────────────────────────
const { createMonitor } = require('../lib/monitor');
const monitor = createMonitor({
  dir: SERVER_DIR,
  serverName: process.env.SERVER_NAME || path.basename(SERVER_DIR) || 'Minecraft',
  log: line => broadcast({ type: 'log', data: line }),
});
const live = { ram: null, ramMax: null, players: 0 };
const diskCache = { at: 0, freeGB: null };
function diskFreeGB() {
  if (Date.now() - diskCache.at > 5 * 60000) {
    diskCache.at = Date.now();
    try {
      const df = execSync(`df -k "${SERVER_DIR}" 2>/dev/null`).toString().split('\n')[1];
      if (df) diskCache.freeGB = monitor.diskFreeGB(parseInt(df.trim().split(/\s+/)[3]) * 1024);
    } catch {}
  }
  return diskCache.freeGB;
}
setInterval(() => {
  const running = isRunning();
  monitor.sample({ running, tps: running ? lastTps : null, ram: running ? live.ram : null, ramMax: live.ramMax,
    cpu: running ? lastCpu : null, players: running ? live.players : 0, disk: diskFreeGB() });
}, 60000).unref();
setInterval(() => monitor.flush(), 5 * 60000).unref();

app.get('/api/monitor/history', (_req, res) => res.json(monitor.history()));
app.get('/api/alerts', (_req, res) => res.json(monitor.getConfig()));
app.post('/api/alerts', (req, res) => {
  const r = monitor.setConfig(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error === 'discord' ? 'Invalid Discord webhook URL' : 'Invalid Telegram details' });
  res.json({ success: true });
});
app.post('/api/alerts/test', async (_req, res) => {
  const c = monitor.getConfig();
  if (!c.hasDiscord && !c.hasTelegram) return res.status(400).json({ error: 'No alert channel (Discord or Telegram) is configured yet' });
  const failed = await monitor.test();
  failed.length ? res.status(502).json({ error: 'Delivery failed' + ': ' + failed.join('; ') }) : res.json({ success: true });
});

// ── Off-site backup copies (rclone) ──────────────────────────────────────────
const { createOffsite } = require('../lib/offsite');
const offsite = createOffsite({ dir: SERVER_DIR });
app.get('/api/backups/offsite', (_req, res) => res.json(offsite.get()));
app.post('/api/backups/offsite', (req, res) => {
  const r = offsite.set(req.body || {});
  r.error ? res.status(400).json({ error: 'Invalid remote format (example: myremote:minecraft)' }) : res.json({ success: true });
});
app.post('/api/backups/offsite/test', async (_req, res) => {
  if (!offsite.get().remote) return res.status(400).json({ error: 'Enter a remote first' });
  try { await offsite.test(); res.json({ success: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Plugin manager (Modrinth) and Paper jar download ─────────────────────────
const downloads = require('../lib/downloads').createDownloads();
const PLUGINS_DIR = path.join(SERVER_DIR, 'plugins');
const PLUGIN_FILE_RE = /^[\w.+ -]{1,120}\.jar(\.disabled)?$/;
const DL_ERRORS = {};
const dlError = e => DL_ERRORS[e && e.message] || (e && e.message) || 'Operation failed';
const mcVersionOnly = () => ((serverVersion || '').match(/\d+\.\d+(?:\.\d+)?/) || [null])[0];

async function pluginMeta(full) {
  try {
    const dir = await unzipper.Open.file(full);
    const e = dir.files.find(x => x.path === 'paper-plugin.yml') || dir.files.find(x => x.path === 'plugin.yml');
    if (!e) return {};
    const txt = (await e.buffer()).toString('utf8');
    const g = k => { const m = new RegExp('^' + k + ':\\s*[\'"]?([^\'"\\r\\n]+)', 'm').exec(txt); return m ? m[1].trim() : null; };
    return { name: g('name'), version: g('version') };
  } catch { return {}; }
}

app.get('/api/plugins', async (_req, res) => {
  try {
    const files = (await fsp.readdir(PLUGINS_DIR)).filter(f => PLUGIN_FILE_RE.test(f)).slice(0, 300);
    const out = [];
    for (const f of files) {
      const full = path.join(PLUGINS_DIR, f), st = await fsp.stat(full);
      out.push({ file: f, enabled: !f.endsWith('.disabled'), size: st.size, date: st.mtimeMs, ...(await pluginMeta(full)) });
    }
    out.sort((a, b) => (a.name || a.file).toLowerCase().localeCompare((b.name || b.file).toLowerCase()));
    res.json({ plugins: out, mcVersion: mcVersionOnly() });
  } catch { res.json({ plugins: [], mcVersion: mcVersionOnly() }); }
});

function pluginPath(name) {
  const f = String(name || '');
  return PLUGIN_FILE_RE.test(f) ? path.join(PLUGINS_DIR, f) : null;
}
app.post('/api/plugins/toggle', async (req, res) => {
  const p = pluginPath((req.body || {}).file);
  if (!p) return res.status(400).json({ error: 'Invalid file name' });
  try {
    const to = p.endsWith('.disabled') ? p.slice(0, -'.disabled'.length) : p + '.disabled';
    await fsp.rename(p, to);
    res.json({ success: true });
  } catch { res.status(404).json({ error: 'File not found' }); }
});
app.post('/api/plugins/delete', async (req, res) => {
  const p = pluginPath((req.body || {}).file);
  if (!p) return res.status(400).json({ error: 'Invalid file name' });
  try { await fsp.unlink(p); res.json({ success: true }); }
  catch { res.status(404).json({ error: 'File not found' }); }
});
app.get('/api/plugins/search', async (req, res) => {
  try { res.json({ results: await downloads.searchPlugins(req.query.q, mcVersionOnly()) }); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
app.post('/api/plugins/install', async (req, res) => {
  try { res.json({ success: true, ...(await downloads.installPlugin((req.body || {}).id, mcVersionOnly(), PLUGINS_DIR)) }); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
app.get('/api/jars/paper', async (_req, res) => {
  try { res.json({ versions: await downloads.paperVersions(), current: SERVER_JAR }); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
app.post('/api/jars/paper', async (req, res) => {
  const b = req.body || {};
  try {
    const r = await downloads.downloadPaper(b.version, SERVER_DIR);
    if (b.eula === true) {
      await fsp.writeFile(path.join(SERVER_DIR, 'eula.txt'), '# Accepted by the panel user (https://aka.ms/MinecraftEULA)\neula=true\n');
      broadcast({ type: 'log', data: '[Panel] EULA accepted at your request' + '\n' });
    }
    res.json({ success: true, ...r });
  } catch (e) { res.status(502).json({ error: dlError(e) }); }
});

// ── Backup helper (used by the API and by the scheduler) ─────────────────────
let backupBusy = false;
async function pruneBackups(keep) {
  if (!keep) return 0;
  const files = (await fsp.readdir(BACKUPS_DIR)).filter(f => /^backup-.*\.zip$/.test(f));
  const withTime = await Promise.all(files.map(async f => ({ f, m: (await fsp.stat(path.join(BACKUPS_DIR, f))).mtimeMs })));
  withTime.sort((a, b) => b.m - a.m);
  const old = withTime.slice(keep);
  for (const o of old) await fsp.unlink(path.join(BACKUPS_DIR, o.f)).catch(() => {});
  return old.length;
}

async function createBackup(keep = 0) {
  if (backupBusy) throw new Error('__BUSY__');
  backupBusy = true;
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const name  = `backup-${stamp}.zip`;
  const out   = path.join(BACKUPS_DIR, name);
  const wasRunning = isRunning();
  try {
    // flush the world to disk and pause autosave so the archive is consistent
    if (wasRunning) { sendCommand('save-off'); sendCommand('save-all flush'); await new Promise(r => setTimeout(r, 3000)); }
    const output  = fs.createWriteStream(out);
    const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
    archive.pipe(output);
    for (const w of ['world', 'world_nether', 'world_the_end']) {
      const p = path.join(SERVER_DIR, w);
      if (fs.existsSync(p)) archive.directory(p, w);
    }
    for (const c of ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json']) {
      const p = path.join(SERVER_DIR, c);
      if (fs.existsSync(p)) archive.file(p, { name: c });
    }
    await new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); archive.finalize(); });
    const removed = await pruneBackups(keep);
    let uploaded = false;
    if (offsite.enabled()) {
      try { await offsite.upload(out); uploaded = true; broadcast({ type: 'log', data: '[Panel] Backup copied off-site: ' + name + '\n' }); }
      catch (e) { broadcast({ type: 'log', data: '[Panel] Off-site copy failed: ' + e.message + '\n' }); }
    }
    return { name, removed, uploaded };
  } finally {
    if (wasRunning && isRunning()) sendCommand('save-on');
    backupBusy = false;
  }
}

// ── Restart with an in-game countdown ────────────────────────────────────────
let countdownActive = false;
function restartWithCountdown(warn) {
  return new Promise(resolve => {
    if (!isRunning()) { intentionalStop = false; startMC(); return resolve(true); }
    if (countdownActive) return resolve(false);
    countdownActive = true;
    const marks = [...new Set([warn, 30, 10, 5, 3, 2, 1])].filter(s => s > 0 && s <= warn);
    for (const s of marks) {
      setTimeout(() => { if (isRunning()) sendCommand(`say Server restarting in ${s} second${s === 1 ? '' : 's'}`); }, (warn - s) * 1000);
    }
    setTimeout(() => {
      countdownActive = false;
      if (isRunning()) { restartPending = true; intentionalStop = false; sendCommand('stop'); }
    }, warn * 1000);
    resolve(true); // the countdown continues in the background; don't hold the HTTP request open
  });
}

// ── Scheduler ────────────────────────────────────────────────────────────────
const { createScheduler } = require('../lib/scheduler');
const scheduler = createScheduler({
  file: path.join(SERVER_DIR, '.panel-schedule.json'),
  sanitizeCommand,
  log: line => broadcast({ type: 'log', data: line }),
  actions: {
    isRunning,
    command: sendCommand,
    backup: keep => createBackup(keep),
    restart: warn => restartWithCountdown(warn),
  },
  t: {
    badType: 'Invalid task type', badCron: 'Invalid cron schedule', badArg: 'Invalid text or command', tooMany: 'Task limit reached (50)', notFound: 'Task not found',
    alreadyRunning: 'Task is already running', skippedBusy: 'skipped: restart already in progress', skippedStopped: 'skipped: server is stopped',
    ranBackup: (n, b, r) => `[Panel] Scheduled task "${n}": backup ${b}${r ? ` (${r} old removed)` : ''}\n`,
    ranRestart: (n, w) => `[Panel] Scheduled task "${n}": restarting in ${w}s\n`,
    ranGeneric: n => `[Panel] Scheduled task "${n}" ran\n`,
    failed: (n, e) => `[Panel] Task "${n}" failed: ${e}\n`,
  },
});

app.get('/api/schedule', requireAuth, (_req, res) => res.json({ tasks: scheduler.list() }));
app.post('/api/schedule', requireAuth, (req, res) => {
  const r = scheduler.add(req.body || {});
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true, task: r.task });
});
app.post('/api/schedule/update', requireAuth, (req, res) => {
  const r = scheduler.update(String((req.body || {}).id || ''), req.body || {});
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true, task: r.task });
});
app.post('/api/schedule/delete', requireAuth, (req, res) => {
  scheduler.remove(String((req.body || {}).id || '')) ? res.json({ success: true }) : res.status(404).json({ error: 'Task not found' });
});
app.post('/api/schedule/run', requireAuth, async (req, res) => {
  const status = await scheduler.runNow(String((req.body || {}).id || ''));
  status === null ? res.status(404).json({ error: 'Task not found' }) : res.json({ success: true, status });
});

// ── Backups API ───────────────────────────────────────────────────────────────
app.get('/api/backups', requireAuth, async (_req, res) => {
  try {
    const entries = await fsp.readdir(BACKUPS_DIR, { withFileTypes: true });
    const backups = await Promise.all(entries
      .filter(e => e.isFile() && e.name.endsWith('.zip'))
      .map(async e => {
        const full = path.join(BACKUPS_DIR, e.name);
        const s = await fsp.stat(full);
        return { name: e.name, size: s.size, date: s.mtime.toISOString().replace('T',' ').slice(0,16) };
      }));
    backups.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ backups });
  } catch { res.json({ backups: [] }); }
});

app.post('/api/backups/create', requireAuth, async (_req, res) => {
  try {
    const { name } = await createBackup(0);
    res.json({ success: true, name });
  } catch (e) {
    res.status(e.message === '__BUSY__' ? 409 : 500).json({ error: 'Backup failed' });
  }
});

app.post('/api/backups/restore', requireAuth, async (req, res) => {
  const name = String(req.body.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file))         return res.status(404).json({ error: 'Backup not found' });

  if (isRunning()) {
    intentionalStop = true;
    sendCommand('stop');
  }

  const restore = async () => {
    try {
      await new Promise((resolve, reject) => {
        fs.createReadStream(file).pipe(unzipper.Extract({ path: SERVER_DIR }))
          .on('close', resolve).on('error', reject);
      });
      broadcast({ type: 'log', data: `[Panel] Restored from ${name}\n` });
    } catch (e) {
      broadcast({ type: 'log', data: `[Panel] Restore failed: ${e.message}\n` });
    }
  };

  if (isRunning()) {
    const wait = setInterval(() => { if (!isRunning()) { clearInterval(wait); restore(); } }, 1000);
    setTimeout(() => clearInterval(wait), 30000);
  } else {
    restore();
  }
  res.json({ success: true });
});

app.post('/api/backups/delete', requireAuth, async (req, res) => {
  const name = String(req.body.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try { await fsp.unlink(path.join(BACKUPS_DIR, name)); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Delete failed' }); }
});

app.get('/api/backups/download', requireAuth, (req, res) => {
  const name = String(req.query.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.download(file);
});

// ── Settings: server.properties ───────────────────────────────────────────────
const PROPS_FILE = path.join(SERVER_DIR, 'server.properties');

app.get('/api/settings/properties', requireAuth, async (_req, res) => {
  try {
    if (!fs.existsSync(PROPS_FILE)) return res.json({ props: {} });
    const txt   = await fsp.readFile(PROPS_FILE, 'utf8');
    const props = {};
    txt.split('\n').forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) props[m[1].trim()] = m[2].trim();
    });
    res.json({ props });
  } catch { res.status(500).json({ error: 'Read failed' }); }
});

app.post('/api/settings/properties', requireAuth, async (req, res) => {
  const incoming = req.body.props || {};
  try {
    let existing = {};
    if (fs.existsSync(PROPS_FILE)) {
      const txt = await fsp.readFile(PROPS_FILE, 'utf8');
      txt.split('\n').forEach(line => {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) existing[m[1].trim()] = m[2].trim();
      });
    }
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof k !== 'string' || k.length > 64) continue;
      if (!/^[a-z][a-z0-9.-]*$/i.test(k)) continue;
      existing[k] = String(v ?? '').replace(/[\r\n]/g, '');
    }
    const out = '# Minecraft server properties (managed by MC Panel)\n# ' +
                new Date().toISOString() + '\n' +
                Object.entries(existing).map(([k,v]) => `${k}=${v}`).join('\n') + '\n';
    await fsp.writeFile(PROPS_FILE, out, 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Save failed' }); }
});

// ── Settings: startup (JVM) ───────────────────────────────────────────────────
app.get('/api/settings/startup', requireAuth, (_req, res) => {
  res.json({ ...loadStartupCfg(), totalRamGB: Math.round(os.totalmem() / (1024 ** 3)) });
});

app.post('/api/settings/startup', requireAuth, async (req, res) => {
  const { xms, xmx, g1gc, extraFlags } = req.body;
  const memRe = /^\d+[MG]$/;
  if (!memRe.test(xms) || !memRe.test(xmx)) return res.status(400).json({ error: 'Invalid memory values' });
  const cfg = { xms, xmx, g1gc: !!g1gc, extraFlags: String(extraFlags || '') };
  try {
    await fsp.writeFile(STARTUP_CFG, JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Save failed' }); }
});

// ── WebSocket (session required) ─────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  sessionMw(req, {}, () => {
    if (!req.session || !auth.roleOf(req.session.user)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
});
wss.on('connection', ws => {
  if (logBuffer.length) ws.send(JSON.stringify({ type: 'log', data: logBuffer.join('') }));

  ws.send(JSON.stringify({
    type:    'status',
    running: isRunning(),
    version: serverVersion,
    uptime:  serverStartTime ? Date.now() - serverStartTime : null,
    tps:     lastTps,
  }));

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (isRunning() && serverReady) sendCommand('list');
});

const wsPing = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(wsPing));

// ── Stats: CPU calculation ──────────────────────────────────────────────────
async function readCpuUsagePct(pid) {
  const statPath = `/proc/${pid}/stat`;
  if (!fs.existsSync(statPath)) return null;
  const txt = await fsp.readFile(statPath, 'utf8');
  const afterComm = txt.slice(txt.lastIndexOf(')') + 2).trim().split(/\s+/);
  const utime = parseInt(afterComm[11], 10);
  const stime = parseInt(afterComm[12], 10);
  if (Number.isNaN(utime) || Number.isNaN(stime)) return null;

  const now = Date.now();
  const prev = cpuSample;
  cpuSample = { utime, stime, time: now };
  if (!prev) return null;

  const deltaTicks = (utime + stime) - (prev.utime + prev.stime);
  const deltaMs    = now - prev.time;
  if (deltaMs <= 0 || deltaTicks < 0) return null;

  const cpuSeconds = deltaTicks / clkTck;
  const pct = (cpuSeconds / (deltaMs / 1000)) * 100 / CPU_CORES;
  return Math.max(0, Math.min(100, pct));
}

// ── Stats: RAM + CPU polling ─────────────────────────────────────────────────
setInterval(async () => {
  if (!isRunning()) return;

  const pid = getMcPid();
  if (!pid) return;
  mcPid = pid;

  let cpuPct = null;
  try { cpuPct = await readCpuUsagePct(pid); } catch {}
  if (cpuPct != null) lastCpu = cpuPct;

  try {
    const statusPath = `/proc/${pid}/status`;
    if (fs.existsSync(statusPath)) {
      const txt      = await fsp.readFile(statusPath, 'utf8');
      const rssMatch = txt.match(/VmRSS:\s+(\d+)\s+kB/);
      if (rssMatch) {
        const ramUsedMB = Math.round(parseInt(rssMatch[1]) / 1024);
        const cfg       = loadStartupCfg();
        const ramMaxMB  = cfg.xmx.endsWith('G') ? parseInt(cfg.xmx) * 1024 : parseInt(cfg.xmx);
        live.ram = ramUsedMB; live.ramMax = ramMaxMB;
        broadcast({ type: 'stats', ramUsed: ramUsedMB, ramMax: ramMaxMB, tps: lastTps, cpu: lastCpu, cores: CPU_CORES });
      }
    }
  } catch {}
}, 1000);

// ── TPS polling ─────────────────────
let serverReady    = false;
let tpsInterval    = null;

function startTpsPolling() {
  if (tpsInterval) return;
  tpsInterval = setInterval(() => {
    if (isRunning() && serverReady) sendCommand('tps');
    else if (!isRunning()) {
      clearInterval(tpsInterval); tpsInterval = null;
      serverReady = false;
    }
  }, 30_000);
}

function checkServerReady(line) {
  if (!serverReady && /Done \(\d+\.\d+s\)! For help/.test(line)) {
    serverReady = true;
    const msg = '[Panel] Server is ready — Started monitoring TPS\n';
    pushLog(msg); broadcast({ type: 'log', data: msg });
    startTpsPolling();
  }
}

if (isRunning()) {
  console.log(`[Panel] Detected existing tmux session: ${TMUX_SESSION}`);
  serverStartTime = Date.now();
  mcPid = getMcPid();
  serverReady = true;

  if (fs.existsSync(MC_LOG_FILE)) {
    try {
      const existing = fs.readFileSync(MC_LOG_FILE, 'utf8');
      const lines = existing.split('\n').slice(-100).join('\n');
      pushLog(stripAnsi(lines));
    } catch {}
  }

  startLogTailer();
  startTmuxMonitor();
  startTpsPolling();
  console.log(`[Panel] Attached to existing server (PID: ${mcPid || 'unknown'})`);
}

// ── Listen ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Panel] http://localhost:${PORT}`);
  console.log(`[Panel] MC dir: ${SERVER_DIR} | Jar: ${SERVER_JAR}`);
  console.log(`[Panel] tmux session: ${TMUX_SESSION} | Log: ${MC_LOG_FILE}`);
});

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  console.log(`[Panel] ${signal} — stopping panel (NOT the MC server)...`);
  if (playersDirty) savePlayersDBNow();
  if (logTailer)    { try { logTailer.kill(); } catch {} }
  if (tmuxMonitor)  clearInterval(tmuxMonitor);
  process.exit(0);
}
