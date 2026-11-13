/**
 * MC Panel - server.js (v5 - Player Intelligence Edition)
 */

// A real environment variable (systemd, docker) wins over .env; remember it before dotenv fills in the rest.
const REAL_MC_JAR = process.env.MC_JAR;
const dotenv = require('dotenv');
dotenv.config();

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
const i18n       = require('./lib/i18n');
const { t }      = i18n;

// مكتبة قراءة NBT (لملفات playerdata) — اختيارية، لا تُسقط اللوحة إذا لم تُثبَّت
let nbt = null;
try { nbt = require('prismarine-nbt'); }
catch { console.warn(t('srv.panel_prismarine_nbt_not_installed_reading_s')); }

// منفذ خادم HTTP المدمج داخل إضافة PanelDataLogger — يُستخدم للاستعلام المباشر
// عن بيانات اللاعبين المتصلين (أدق وأسرع بكثير من قراءة كونسول أو ملف محفوظ)
const PANEL_HTTP_PORT = parseInt(process.env.PANEL_HTTP_PORT || '28281', 10);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '8080', 10);
const SERVER_DIR  = path.resolve(process.env.MC_DIR || '/opt/minecraft');
// MC_JAR is read from .env again every time it is needed (each server start, status, update), so editing the file
// takes effect on the next start without restarting the panel. A real environment variable still takes priority.
// The name goes into a shell command, so only a plain jar file name is accepted.
const JAR_NAME_RE = /^[\w.+-]{1,100}\.jar$/;
const DEFAULT_JAR = 'spigot-26.3.jar';
function readEnvFileValue(key) {
  try {
    const file = path.resolve(process.env.DOTENV_CONFIG_PATH || '.env');
    return dotenv.parse(fs.readFileSync(file))[key];
  } catch { return undefined; }
}
function serverJar() {
  for (const v of [REAL_MC_JAR, readEnvFileValue('MC_JAR'), process.env.MC_JAR]) {
    if (v && JAR_NAME_RE.test(String(v).trim())) return String(v).trim();
  }
  return DEFAULT_JAR;
}
const startedJars = new Set();   // jar names this panel has started; used to find the process even after MC_JAR changed
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
const { createAuth, permFor, PERM_GROUPS, COMMAND_PERMS, IMPLIES } = require('./lib/auth');
const auth = createAuth({ dir: SERVER_DIR, ownerUser: ADMIN_USER, ownerHash: ADMIN_HASH, t: {
  get badUser() { return t('srv.username_must_be_3_32_characters_letters_dig'); },
  get reservedUser() { return t('srv.that_name_is_reserved_for_the_owner'); },
  get badRole() { return t('srv.invalid_role'); },
  get badPassword() { return t('srv.password_must_be_at_least_8_characters'); },
  get userExists() { return t('srv.user_already_exists'); },
  get tooMany() { return t('srv.user_limit_reached'); },
  get userNotFound() { return t('srv.user_not_found'); },
  get badCode() { return t('srv.invalid_verification_code'); },
  get ownerPwEnv() { return t('srv.the_owner_password_is_changed_in_the_env_fil'); },
  get wrongPassword() { return t('srv.current_password_is_wrong'); },
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

// The file manager must never reach the panel's own data: hidden files and folders (.panel-users.json with password
// hashes and 2FA secrets, .panel-offsite.json with storage keys, .env, ...) and the panel's own code when it is
// installed inside the server folder (for example /opt/minecraft/panel). Symlinks are resolved so they cannot point out.
const PANEL_DIR = path.resolve(__dirname);
function filePath(rel) {
  if (typeof rel !== 'string') return null;
  const abs = safePath(rel);
  if (!abs) return null;
  const parts = path.relative(SERVER_DIR, abs).split(path.sep).filter(Boolean);
  if (parts.some(x => x.startsWith('.'))) return null;
  const inside = (a, dir) => a === dir || a.startsWith(dir + path.sep);
  if (PANEL_DIR !== SERVER_DIR && inside(abs, PANEL_DIR)) return null;
  try {
    const real = fs.realpathSync(abs), base = fs.realpathSync(SERVER_DIR);
    if (!inside(real, base) || (PANEL_DIR !== SERVER_DIR && inside(real, fs.realpathSync(PANEL_DIR)))) return null;
  } catch {}   // does not exist yet (new file): the checks above are enough
  return abs;
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
    return res.status(429).json({ error: t('srv.too_many_attempts_try_again_in_v0_seconds',{v0:Math.ceil((e.resetAt-now)/1000)}) });
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
// اللغة لكل طلب: كوكي panel_lang ثم PANEL_LANG
app.use((req, _res, next) => i18n.run(i18n.langFromCookie(req.headers.cookie), next));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function requireAuth(req, res, next) {
  if (req.session?.user && auth.roleOf(req.session.user)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── State ─────────────────────────────────────────────────────────────────────
let restartPending  = false;
let intentionalStop = false; // المتغير الجديد لمعرفة هل الإيقاف متعمد من اللوحة أم لا
let serverVersion   = null;
let serverBuild     = null;   // Paper build number, from the startup log line "This server is running Paper version 26.2-135-..."
let serverStartTime = null;
let lastTps         = null;
let mcPid           = null;
let logTailer       = null;
let tmuxMonitor     = null;
let lastCpu         = null;
let cpuSample       = null; // { utime, stime, time } من آخر قياس، لحساب الفرق
const CPU_CORES     = os.cpus().length || 1;
let clkTck = 100;
try { clkTck = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10) || 100; } catch {}

// أوامر تستخدمها اللوحة داخليًا (قياس TPS وتحديث قائمة اللاعبين)، نخفيها من الكونسول
// لأن ردّها مو مفيد للمستخدم هناك، والقيمة الفعلية توصل عن طريق بث WebSocket مخصص
const HIDDEN_COMMANDS = new Set(['tps', 'list']);

const LOG_MAX   = 500;
const logBuffer = [];

function pushLog(line) { logBuffer.push(line); if (logBuffer.length > LOG_MAX) logBuffer.shift(); }

function broadcast(data) {
  const msg = JSON.stringify(data);
  // console output only goes to users who may see the console (checked at send time, so a revoked permission takes effect at once)
  wss.clients.forEach(c => { if (c.readyState === 1 && (data.type !== 'log' || auth.has(c.user, 'console.view'))) c.send(msg); });
}

// ══════════════════════════════════════════════════════════════════════════════
//  قاعدة بيانات اللاعبين الدائمة (.panel-players.json)
//  تحل مشكلة "إجمالي اللاعبين = Whitelist فقط" وتضيف سجل كل من دخل السيرفر تاريخياً
// ══════════════════════════════════════════════════════════════════════════════
let playersDB   = {};
let playersDirty = false;

function loadPlayersDB() {
  try { playersDB = JSON.parse(fs.readFileSync(PLAYERS_DB_FILE, 'utf8')); }
  catch { playersDB = {}; }
}
function savePlayersDBNow() {
  try { fs.writeFileSync(PLAYERS_DB_FILE, JSON.stringify(playersDB), 'utf8'); playersDirty = false; }
  catch (e) { console.error(t('srv.panel_failed_to_save_the_player_database'), e.message); }
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
  playersDB[key].name = name; // نحدّث آخر تهجئة/حالة أحرف معروفة للاسم
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
// مزامنة كاملة من نتيجة أمر list: أي لاعب لم يعد ضمن القائمة الحالية يُعتبر خارج السيرفر
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

// ── UUID: قراءة usercache.json + خوارزمية UUID الخاصة بالوضع غير المتصل (Offline) ──
function offlineUuidFor(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // النسخة 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // المتغيّر
  const h = md5.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function resolveUuid(name) {
  const rec = getPlayerRecord(name);
  if (rec.uuid) return { uuid: rec.uuid, guessed: false };
  // 1) usercache.json — يعمل بغض النظر عن online-mode
  try {
    const p = path.join(SERVER_DIR, 'usercache.json');
    if (fs.existsSync(p)) {
      const cache = JSON.parse(await fsp.readFile(p, 'utf8'));
      const hit = cache.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
      if (hit?.uuid) { rec.uuid = hit.uuid; playersDirty = true; return { uuid: hit.uuid, guessed: false }; }
    }
  } catch {}
  // 2) ops.json / whitelist.json / banned-players.json كمصدر احتياطي
  for (const file of ['ops.json', 'whitelist.json', 'banned-players.json']) {
    try {
      const p = path.join(SERVER_DIR, file);
      if (!fs.existsSync(p)) continue;
      const list = JSON.parse(await fsp.readFile(p, 'utf8'));
      const hit = list.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
      if (hit?.uuid) { rec.uuid = hit.uuid; playersDirty = true; return { uuid: hit.uuid, guessed: false }; }
    } catch {}
  }
  // 3) احتياطي أخير: UUID المحسوب لوضع offline — يصح فقط إن كان السيرفر online-mode=false فعلياً
  // لا يُحفَظ في rec.uuid عمداً، حتى تُعاد المحاولة من مصدر حقيقي في كل استدعاء لاحق
  const off = offlineUuidFor(name);
  return { uuid: off, guessed: true };
}

function getWorldName() {
  try {
    const txt = fs.readFileSync(PROPS_FILE, 'utf8');
    const m = txt.match(/^level-name=(.*)$/m);
    const v = m && m[1].trim();
    // level-name becomes part of file paths: a plain folder name only
    if (v && /^[\w .-]{1,64}$/.test(v) && !v.startsWith('.')) return v;
  } catch {}
  return 'world';
}
// The world folders a backup contains: the configured world and its Nether and End.
const worldDirs = () => { const w = getWorldName(); return [w, w + '_nether', w + '_the_end']; };

// Minecraft 26.1+ moved per-player files into <world>/players/{data,stats,advancements}/.
// Older versions keep them in <world>/{playerdata,stats,advancements}/. Support both layouts.
function playerFilePath(world, kind, uuid) {
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(String(uuid || ''))) uuid = '00000000-0000-0000-0000-000000000000';
  const ext = kind === 'playerdata' ? '.dat' : '.json';
  const modern = path.join(SERVER_DIR, world, 'players', kind === 'playerdata' ? 'data' : kind, uuid + ext);
  const legacy = path.join(SERVER_DIR, world, kind, uuid + ext);
  if (fs.existsSync(modern)) return modern;
  if (fs.existsSync(legacy)) return legacy;
  return fs.existsSync(path.join(SERVER_DIR, world, 'players')) ? modern : legacy;
}

// قراءة إحصائيات اللاعب (JSON عادي، لا يحتاج مكتبة NBT) — world/stats/<uuid>.json
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
    const cm = k => (custom[`minecraft:${k}`] || 0) / 100; // سم → متر
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

// إحصائيات حية جاءت من خادم HTTP المدمج بالإضافة (بلا "أكثر الكتل تعديناً" — غير متاحة حياً بكفاءة)
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

// متانة قصوى لكل عنصر — NBT لا يخزّن الحد الأقصى إطلاقاً، فقط الضرر الحالي
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

// يستخرج قائمة السحر (اسم + مستوى) من مركّب NBT الحديث أو الصيغة القديمة، دفاعياً
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

// يبني نتيجة موحّدة (مخزون/دروع/يد ثانية/صندوق سحري/موقع/صحة...) من كائن NBT مبسَّط لملف .dat المحفوظ
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
    // زخرفة الدروع (Trim) — أفضل جهد فقط؛ شكل NBT الدقيق قد يختلف بين الإصدارات
    try {
      const trim = it.components?.['minecraft:trim'] || it.tag?.Trim; // 1.20.5+ component, or the older item tag
      if (trim) {
        const pattern  = (typeof trim.pattern  === 'string' ? trim.pattern  : trim.pattern?.key  || trim.pattern?.id  || '').replace('minecraft:', '');
        const material = (typeof trim.material === 'string' ? trim.material : trim.material?.key || trim.material?.id || '').replace('minecraft:', '');
        if (pattern && material) result.trim = { pattern, material };
      }
    } catch {}
    // محتويات صندوق شولكر متداخل — أفضل جهد فقط
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

// يطبّع رد خادم HTTP المدمج في إضافة PanelDataLogger إلى نفس شكل buildPlayerDataResult
// حتى لا يحتاج أي كود آخر (بما فيه الواجهة) لمعرفة مصدر البيانات
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

// استعلام مباشر عن خادم HTTP المدمج داخل إضافة PanelDataLogger على نفس الجهاز (localhost فقط)
// — لا يحتاج تحليل كونسول ولا انتظار حفظ ملف، ويقرأ بيانات اللاعب مباشرة من كائنه الحي في الذاكرة
async function queryPluginHttp(name) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${PANEL_HTTP_PORT}/player/${encodeURIComponent(name)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // الإضافة غير مركَّبة، أو خادمها غير مشغَّل، أو لا يوجد اتصال — ننتقل للاحتياطي بصمت
  }
}

// قراءة بيانات اللاعب من ملف NBT المحفوظ على القرص (يعمل للمتصلين وغير المتصلين، لكن بتأخر حسب آخر حفظ)
async function readPlayerDataFromFile(uuid) {
  if (!nbt) return { available: false, reason: t('srv.the_prismarine_nbt_library_is_not_installed') };
  try {
    const p = playerFilePath(getWorldName(), 'playerdata', uuid);
    if (!fs.existsSync(p)) return { available: false, reason: t('srv.no_data_file_at_path') + p };
    const buf = await fsp.readFile(p);
    const { parsed } = await nbt.parse(buf);
    const d = nbt.simplify(parsed);
    return buildPlayerDataResult(d, false);
  } catch (e) {
    return { available: false, reason: t('srv.could_not_read_parse_file_nbt') + e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  إدارة tmux
// ══════════════════════════════════════════════════════════════════════════════

function isRunning() {
  try {
    execSync(`TMUX= tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// The jar the running Java process was really started with (it can differ from MC_JAR after .env was edited).
function runningJarName() {
  try {
    if (!isRunning()) return null;
    const pid = getMcPid();
    if (!pid) return null;
    const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split(' ');
    const i = args.indexOf('-jar');
    return i >= 0 && args[i + 1] ? path.basename(args[i + 1]) : null;
  } catch { return null; }
}

function getMcPid() {
  try {
    const pids = [];
    for (const jar of new Set([...startedJars, serverJar()])) {
      try { for (const x of execSync("pgrep -f '" + jar + "'").toString().trim().split('\n')) if (x && !pids.includes(x)) pids.push(x); } catch {}
    }
    if (!pids.length) return null;
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

// يستخرج اسم اللاعب الحقيقي من مقطع نص واحد ضمن رد أمر list
// الأولوية: أي اسم داخل <> (تنسيق يستخدمه بعض إضافات الفرق/الرتب لعزل الاسم الحقيقي)
// وإلا: آخر كلمة في النص (سلوك احتياطي متوافق مع الإصدارات السابقة)
function extractPlayerName(segment) {
  const bracket = segment.match(/<([a-zA-Z0-9_.]{1,16})>/);
  if (bracket) return bracket[1];
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// The Minecraft version. Normally learned from the startup log line; when the panel was restarted while the
// server kept running that line was never seen, so fall back to the log file, Paper's version_history.json,
// and finally the version number in the jar's file name.
function detectVersion() {
  if (serverVersion) return serverVersion;
  const found = v => { serverVersion = v; return v; };
  try {
    const fd = fs.openSync(MC_LOG_FILE, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 400000), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const all = [...buf.toString('utf8').matchAll(/Starting minecraft server version (\S+)/gi)];
      if (all.length) return found(all[all.length - 1][1]);
    } finally { fs.closeSync(fd); }
  } catch {}
  try {
    const h = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'version_history.json'), 'utf8'));
    const m = /MC:\s*(\d+\.\d+(?:\.\d+)?)/.exec(String(h.currentVersion || ''));
    if (m) return found(m[1]);
  } catch {}
  const jm = /(\d+\.\d+(?:\.\d+)?)/.exec(serverJar() || '');
  return jm ? jm[1] : null;
}

function parseLogLine(line) {
  const bm = line.match(/running Paper version\s+\d+(?:\.\d+)*-(\d+)-/i);
  if (bm) { serverBuild = Number(bm[1]); updateCache = { at: 0, data: null }; }
  const vm = line.match(/Starting minecraft server version (.+)/i);
  if (vm) { serverVersion = vm[1].trim(); broadcast({ type: 'info', version: serverVersion }); }

  const tpsMatch = line.match(/TPS from last[^:]*:\s*\*?([\d.]+)/i);
  if (tpsMatch) {
    lastTps = parseFloat(tpsMatch[1]);
    broadcast({ type: 'stats', tps: lastTps });
    return true; // رد أمر tps الداخلي، يبقى مخفي عن الكونسول
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
    return true; // رد أمر list الداخلي، يبقى مخفي عن الكونسول
  }

  // انضمام/مغادرة — نسجّلها في قاعدة بيانات اللاعبين الدائمة (لا تُخفى من الكونسول)
  const joinMatch = line.match(/]: (\S{1,16}) joined the game/i) || line.match(/]: (\S{1,16})\[.*?logged in/i);
  if (joinMatch && PLAYER_RE.test(joinMatch[1])) markJoin(joinMatch[1]);
  const leftMatch = line.match(/]: (\S{1,16}) left the game/i);
  if (leftMatch && PLAYER_RE.test(leftMatch[1])) markLeave(leftMatch[1]);

  // بيانات من إضافة PanelDataLogger المرافقة (اختيارية) — الوفيات والانتقالات بإحداثيات دقيقة
  // شكل السطر المتوقع: [PanelData] DEATH|player|world|x|y|z|cause
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
            cause: causeParts.join('|') || t('srv.unknown'),
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
    } catch (e) { console.error(t('srv.panel_failed_to_parse_line_paneldata'), e.message); }
    return true; // مخفي عن الكونسول، مثل tps/list تماماً
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
    if (!intentionalStop && !restartPending) monitor.event('crash', t('srv.server_stopped_unexpectedly_restarting_autom'));
    else if (intentionalStop && !restartPending && !jarUpdateBusy) monitor.event('stopped', t('srv.server_was_stopped'));

    // نظام التشغيل التلقائي إذا كان الإيقاف غير متعمد أو أمر ريستارت
    if (restartPending || !intentionalStop) {
      restartPending = false;
      const restartMsg = t('srv.panel_auto_restarting_in_5_seconds');
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

// Extra JVM flags end up inside the shell command that starts the server, so each one must be a plain flag:
// no spaces, quotes, $, ;, |, & or backticks. Flags that make the JVM run other programs or load native/agent
// code are refused as well, so the "edit settings" permission cannot be turned into running commands on the machine.
const JVM_FLAG_RE = /^-[\w.:=+,/@%-]{1,200}$/;
const JVM_FLAG_BLOCKED = /^-(XX:[+-]?On(OutOfMemory)?Error|XX:Flags|XX:VMOptionsFile|XX:CompileCommandFile|javaagent|agentpath|agentlib)/i;
function parseJvmFlags(str) {
  const flags = String(str || '').split(/\s+/).filter(Boolean);
  const bad = flags.filter(f => !JVM_FLAG_RE.test(f) || JVM_FLAG_BLOCKED.test(f));
  return { flags: flags.filter(f => !bad.includes(f)).slice(0, 40), bad };
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
  if (cfg.extraFlags) args.push(...parseJvmFlags(cfg.extraFlags).flags);   // also filters files saved by older versions
  return args;
}

function startMC() {
  if (isRunning()) return false;

  intentionalStop = false; // تصفير المتغير عند التشغيل

  const cfg  = loadStartupCfg();
  const args = buildJvmArgs(cfg);

  serverVersion   = null;
  serverBuild     = null;
  serverStartTime = Date.now();
  lastTps         = null;
  mcPid           = null;
  lastCpu         = null;
  cpuSample       = null;

  try { fs.writeFileSync(MC_LOG_FILE, ''); } catch {}

  const jarName = serverJar();
  startedJars.add(jarName);
  const javaCmd = `java ${args.join(' ')} -jar ${jarName} nogui`;

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
  monitor.event('started', t('srv.server_started'));
  return true;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get('/', (req, res) => {
  const lang = i18n.langFromCookie(req.headers.cookie);
  res.type('html').send(i18n.renderPage(INDEX_HTML, lang));
});
app.post('/api/lang', (req, res) => {
  const lang = req.body && req.body.lang;
  if (!i18n.available().includes(lang)) return res.status(400).json({ error: 'bad language' });
  res.cookie('panel_lang', lang, { maxAge: 365 * 86400000, sameSite: 'strict', httpOnly: false, secure: process.env.COOKIE_SECURE === 'true' });
  res.json({ ok: true });
});

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const who = auth.verify(username, password);
  if (!who) {
    auth.audit(String(username || '').slice(0, 32), req.ip, 'LOGIN_FAILED', '');
    return res.status(401).json({ error: t('srv.wrong_credentials') });
  }
  if (auth.twoFa.enabled(who.username) && !auth.twoFa.check(who.username, (req.body || {}).code)) {
    auth.audit(who.username, req.ip, 'LOGIN_2FA_FAILED', '');
    return res.status(401).json({ error: (req.body || {}).code ? t('srv.invalid_verification_code') : t('srv.enter_your_two_factor_code'), needCode: true });
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

// ── Permissions: every /api route below needs one permission (see lib/auth.js) ─────
app.use('/api', (req, res, next) => {
  const user = req.session && req.session.user;
  if (!user || !auth.roleOf(user)) return res.status(401).json({ error: 'Unauthorized' });
  const need = permFor(req.method, req.path);
  const ok = need === null || (need === '#command' ? auth.canUseConsoleInput(user) : need === '#owner' ? auth.roleOf(user) === 'owner' : auth.has(user, need));
  if (!ok) {
    auth.audit(user, req.ip, 'DENIED ' + req.method + ' ' + req.path, '');
    return res.status(403).json({ error: t('srv.you_do_not_have_permission_for_this_action') });
  }
  req.user = user; req.role = auth.roleOf(user);
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) auth.audit(user, req.ip, req.method + ' ' + req.originalUrl.split('?')[0], auth.describeBody(req.body));
    });
  }
  next();
});

app.get('/api/me', (req, res) => res.json({ username: req.user, role: req.role, perms: auth.permsOf(req.user), console: auth.canUseConsoleInput(req.user), twoFa: auth.twoFa.enabled(req.user) }));
app.get('/api/perms', (_req, res) => res.json({ groups: PERM_GROUPS, presets: auth.PRESETS, commands: COMMAND_PERMS, implies: IMPLIES }));
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
// A user with "users" permission can only hand out permissions they hold themselves, and only touch users whose
// permissions are a subset of theirs (so nobody can raise themselves or others above their own level).
const subsetOf = (list, actor) => (list || []).every(p => auth.has(actor, p));
function userGuard(req, res, targetPerms, newPerms) {
  if (auth.roleOf(req.user) === 'owner') return true;
  if (!subsetOf(targetPerms, req.user) || !subsetOf(newPerms, req.user)) {
    res.status(403).json({ error: t('srv.you_cannot_grant_permissions_you_do_not_have') });
    return false;
  }
  return true;
}
const listedPerms = name => { const u = auth.list().find(x => x.username === name); return u ? u.perms : []; };
app.get('/api/users', (_req, res) => res.json({ users: auth.list() }));
app.post('/api/users', (req, res) => {
  const b = req.body || {};
  const want = Array.isArray(b.perms) ? b.perms : (auth.PRESETS[b.role] || []);
  if (!userGuard(req, res, [], want)) return;
  const r = auth.add(String(b.username || ''), b.password, b.role, Array.isArray(b.perms) ? b.perms : undefined);
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.post('/api/users/update', (req, res) => {
  const b = req.body || {}, name = String(b.username || '');
  const want = Array.isArray(b.perms) ? b.perms : (b.role ? (auth.PRESETS[b.role] || []) : []);
  if (!userGuard(req, res, listedPerms(name), want)) return;
  const r = auth.update(name, { role: b.role, perms: Array.isArray(b.perms) ? b.perms : undefined, password: b.password });
  if (!r.error && b.resetTotp) auth.twoFa.reset(name);
  r.error ? res.status(400).json({ error: r.error }) : res.json({ success: true });
});
app.post('/api/users/delete', (req, res) => {
  const name = String((req.body || {}).username || '');
  if (!userGuard(req, res, listedPerms(name), [])) return;
  const r = auth.remove(name);
  r.error ? res.status(404).json({ error: r.error }) : res.json({ success: true });
});
app.get('/api/audit', (_req, res) => res.json({ entries: auth.readAudit(200) }));

app.get('/api/status', requireAuth, (_req, res) => res.json({
  running: isRunning(),
  version: detectVersion(),
  uptime:  serverStartTime ? Date.now() - serverStartTime : null,
  tps:     lastTps,
  pid:     mcPid || null,
}));

// ── Server control ────────────────────────────────────────────────────────────
app.post('/api/start', requireAuth, (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: t('srv.already_running') });
  intentionalStop = false;
  const ok = startMC();
  if (!ok) return res.status(500).json({ error: t('srv.failed_to_start_the_server') });
  res.json({ success: true });
});

app.post('/api/stop', requireAuth, (_req, res) => {
  if (!isRunning()) return res.status(409).json({ error: t('srv.stopped') });
  restartPending  = false;
  intentionalStop = true; // تم الإيقاف يدوياً من اللوحة، لن يتم إعادة التشغيل
  sendCommand('stop');
  res.json({ success: true });
});

app.post('/api/restart', requireAuth, (_req, res) => {
  if (!isRunning()) {
    intentionalStop = false;
    const ok = startMC();
    if (!ok) return res.status(500).json({ error: t('srv.failed_to_start_the_server') });
    return res.json({ success: true });
  }
  restartPending  = true;
  intentionalStop = false;
  sendCommand('stop');
  res.json({ success: true });
});

app.post('/api/command', requireAuth, (req, res) => {
  const cmd = sanitizeCommand(req.body.command);
  if (cmd && !auth.commandAllowed(req.user, cmd)) return res.status(403).json({ error: t('srv.this_command_is_not_allowed_for_your_role') });
  if (!cmd)         return res.status(400).json({ error: t('srv.invalid_command') });
  if (!isRunning()) return res.status(409).json({ error: t('srv.server_is_stopped') });
  sendCommand(cmd);
  const bm = /^\/?ban\s+(\w{1,16})(\s|$)/i.exec(cmd);
  if (bm) noteBan(bm[1], req.user);
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
    version:   detectVersion(),
    jar:       serverJar(),
    serverDir: SERVER_DIR,
    pid:       mcPid || null,
    uptime:    serverStartTime ? Date.now() - serverStartTime : null,
    tps:       lastTps,
    diskFree,
    diskTotal,
  });
});

// ── Timed bans ───────────────────────────────────────────────────────────────
const { createTempBans } = require('./lib/tempbans');
const tempBans = createTempBans({ dir: SERVER_DIR, isRunning, pardon: n => sendCommand(`pardon ${n}`) });
app.post('/api/player/tempban', (req, res) => {
  const b = req.body || {}, p = sanitizePlayer(b.player);
  if (!p) return res.status(400).json({ error: t('srv.invalid_player_name') });
  const minutes = parseInt(b.minutes, 10) || 0;
  if (minutes < 0 || minutes > 525600) return res.status(400).json({ error: t('srv.invalid_duration') });
  const raw = String(b.reason || '').trim().slice(0, 100), reason = raw ? sanitizeCommand(raw) : '';
  if (raw && !reason) return res.status(400).json({ error: t('srv.invalid_reason') });
  if (!isRunning()) return res.status(409).json({ error: t('srv.server_is_stopped') });
  sendCommand('ban ' + p + (reason ? ' ' + reason : ''));
  noteBan(p, req.user);
  minutes > 0 ? tempBans.add(p, minutes) : tempBans.remove(p);
  res.json({ success: true });
});

// ── Who banned whom (Minecraft itself only records "Server" for console bans) ─────────────
const BANMETA_FILE = path.join(SERVER_DIR, '.panel-banmeta.json');
let banMeta = {};
try { banMeta = JSON.parse(fs.readFileSync(BANMETA_FILE, 'utf8')) || {}; } catch { banMeta = {}; }
function noteBan(name, user) {
  if (!name || !user) return;
  banMeta[String(name).toLowerCase()] = { by: user, at: Date.now() };
  const keys = Object.keys(banMeta);
  if (keys.length > 2000) for (const k of keys.sort((a, b) => banMeta[a].at - banMeta[b].at).slice(0, keys.length - 2000)) delete banMeta[k];
  try { fs.writeFileSync(BANMETA_FILE, JSON.stringify(banMeta)); } catch {}
}
// "2026-11-13 19:16:00 +0300" (banned-players.json) -> ms
const banCreatedMs = c => { const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(String(c || '')); return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN; };
// The panel user is only trusted when the ban was made right then; an older ban with the same name was made by someone else.
function banBy(b) {
  const m = banMeta[String(b.name || '').toLowerCase()], ms = banCreatedMs(b.created);
  if (m && (!Number.isFinite(ms) || Math.abs(ms - m.at) < 5 * 60000)) return m.by;
  return b.source && b.source !== 'Server' ? b.source : null;
}

// ── Player actions ────────────────────────────────────────────────────────────
const PLAYER_ACTIONS = {
  op:    p => `op ${p}`,
  deop:  p => `deop ${p}`,
  ban:   p => `ban ${p}`,
  kick:  p => `kick ${p}`,
  unban: p => `pardon ${p}`,
  // ملاحظة: Minecraft يمنع نهائياً وبشكل متعمد أي كتابة لبيانات اللاعب عبر
  // data merge/modify (يرجع خطأ "Unable to modify player data" دائماً، بغض
  // النظر عن الإصدار أو الإعدادات) — البديل الرسمي الوحيد هو /effect
  heal:  p => `effect give ${p} minecraft:instant_health 1 9`,
  feed:  p => `effect give ${p} minecraft:saturation 1 9`,
  kill:  p => `kill ${p}`,
};
Object.entries(PLAYER_ACTIONS).forEach(([action, fn]) => {
  app.post(`/api/player/${action}`, requireAuth, (req, res) => {
    const p = sanitizePlayer(req.body.player);
    if (!p)           return res.status(400).json({ error: t('srv.invalid_player_name') });
    if (!isRunning()) return res.status(409).json({ error: t('srv.server_is_stopped') });
    sendCommand(fn(p));
    if (action === 'ban') noteBan(p, req.user);
    if (action === 'ban' || action === 'unban') tempBans.remove(p);
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
  res.json({ bans: bans.map(b => ({ name: b.name, reason: b.reason, created: b.created, expires: timed[b.name] || null, by: banBy(b) })) });
});
app.get('/api/whitelist', requireAuth, async (_req, res) => {
  const list = await readJsonFile('whitelist.json');
  res.json({ whitelist: list.map(w => ({ name: w.name || w, uuid: w.uuid })) });
});

// ── قاعدة بيانات اللاعبين (كل من دخل السيرفر تاريخياً) ────────────────────────
app.get('/api/players/all', requireAuth, async (_req, res) => {
  const banned = new Set((await readJsonFile('banned-players.json')).map(b => String(b.name || '').toLowerCase()));
  const list = Object.values(playersDB).map(p => ({
    name: p.name, online: !!p.online, banned: banned.has(String(p.name).toLowerCase()),
    firstSeen: p.firstSeen, lastSeen: p.lastSeen, lastLeft: p.lastLeft,
    joinCount: p.joinCount || 0,
    deathCount: (p.deaths || []).length, teleportCount: (p.teleports || []).length,
  })).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
  res.json({ players: list, total: list.length });
});

app.get('/api/players/detail', requireAuth, async (req, res) => {
  const name = sanitizePlayer(req.query.name);
  if (!name) return res.status(400).json({ error: t('srv.invalid_player_name') });
  const rec = getPlayerRecord(name);
  const { uuid, guessed } = await resolveUuid(name);
  const worldName = getWorldName();

  // نستعلم عن الإضافة مرة واحدة فقط (بيانات + إحصائيات معاً) لتفادي طلبين منفصلين
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
    // للتشخيص فقط — يساعد على معرفة سبب "لا توجد بيانات" مباشرة من الواجهة
    debug: {
      worldName, uuidGuessed: guessed,
      statsPath: playerFilePath(worldName, 'stats', uuid),
      playerDataPath: playerFilePath(worldName, 'playerdata', uuid),
    },
  });
});

// ── حذف بيانات لاعب (مخزون/صندوق سحري/خبرة عبر إعادة كتابة ملف NBT، إحصائيات/تقدم كملفات، وسجل اللوحة) ──
app.post('/api/players/delete-data', requireAuth, async (req, res) => {
  const name = sanitizePlayer(req.body.name);
  if (!name) return res.status(400).json({ error: t('srv.invalid_player_name') });
  const parts = req.body.parts || {};
  const rec = getPlayerRecord(name);
  if (rec.online) return res.status(409).json({ error: t('srv.cannot_delete_data_of_a_player_who_is_online') });

  const { uuid } = await resolveUuid(name);
  const worldName = getWorldName();
  const results = {};

  if ((parts.inventory || parts.enderChest || parts.xp)) {
    if (!nbt) return res.status(500).json({ error: t('srv.the_prismarine_nbt_library_is_not_installed') });
    try {
      const p = playerFilePath(worldName, 'playerdata', uuid);
      if (fs.existsSync(p)) {
        const buf = await fsp.readFile(p);
        const { parsed } = await nbt.parse(buf);
        const root = parsed.value;
        if (parts.inventory && root.Inventory) {
          root.Inventory.value.value = []; // تفريغ كامل: المخزون الرئيسي + الدروع + اليد الثانية معاً
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
      return res.status(500).json({ error: t('srv.failed_to_modify_the_player_file') + e.message });
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
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const abs = filePath(rel);
  if (!abs) return res.status(400).json({ error: t('srv.invalid_path') });
  try {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter(e => !e.name.startsWith('.') && filePath(path.relative(SERVER_DIR, path.join(abs, e.name))))
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
  } catch { res.status(500).json({ error: t('srv.failed_to_read_the_folder') }); }
});

app.get('/api/files/read', requireAuth, async (req, res) => {
  const abs = filePath(req.query.path);
  if (!abs) return res.status(400).json({ error: t('srv.invalid_path') });
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile())            return res.status(400).json({ error: t('srv.not_a_file') });
    if (stat.size > MAX_EDIT_SIZE) return res.status(413).json({ error: t('srv.file_is_too_large_2mb') });
    const ext = path.extname(abs).toLowerCase();
    if (!EDITABLE_EXT.has(ext))    return res.status(415).json({ error: t('srv.file_type_cannot_be_edited') });
    const content = await fsp.readFile(abs, 'utf8');
    res.json({ content });
  } catch (e) { res.status(e && e.code === 'ENOENT' ? 404 : 500).json({ error: t('srv.failed_to_read_the_file') }); }
});

app.post('/api/files/write', requireAuth, async (req, res) => {
  const abs = filePath((req.body || {}).path);
  if (!abs) return res.status(400).json({ error: t('srv.invalid_path') });
  if (typeof req.body.content !== 'string') return res.status(400).json({ error: t('srv.invalid_path') });
  const content = req.body.content;
  if (content.length > MAX_EDIT_SIZE) return res.status(413).json({ error: t('srv.content_is_too_large') });
  const ext = path.extname(abs).toLowerCase();
  if (!EDITABLE_EXT.has(ext)) return res.status(415).json({ error: t('srv.file_type_cannot_be_edited') });
  try {
    await fsp.writeFile(abs, content, 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: t('srv.write_failed') }); }
});

app.post('/api/files/upload', requireAuth, (req, res) => {
  let relPath, fileName;
  try { relPath = decodeURIComponent(req.headers['x-path'] || ''); fileName = decodeURIComponent(req.headers['x-filename'] || ''); }
  catch { return res.status(400).json({ error: t('srv.invalid_path') }); }
  // a plain file name only: no folders, no "..", nothing hidden
  if (!fileName || fileName.length > 200 || /[\\/\x00-\x1f]/.test(fileName) || fileName === '.' || fileName === '..')
    return res.status(400).json({ error: t('srv.invalid_name') });
  const absDir = filePath(relPath);
  const absFile = absDir && filePath(path.relative(SERVER_DIR, path.join(absDir, fileName)));
  if (!absFile || path.dirname(absFile) !== absDir) return res.status(400).json({ error: t('srv.invalid_path') });
  let st = null;
  try { st = fs.statSync(absFile); } catch {}
  if (st && !st.isFile()) return res.status(409).json({ error: t('srv.a_file_folder_with_that_name_already_exists') });
  // write to a temporary name and move it into place only when the whole upload arrived
  const part = absFile + '.part-' + process.pid;
  const ws = fs.createWriteStream(part);
  let done = false;
  const fail = () => { if (done) return; done = true; ws.destroy(); fs.unlink(part, () => {}); if (!res.headersSent) res.status(500).json({ error: t('srv.upload_failed') }); };
  ws.on('error', fail);
  req.on('error', fail);
  req.on('aborted', fail);
  ws.on('finish', () => {
    if (done) return; done = true;
    fs.rename(part, absFile, err => { if (err) { fs.unlink(part, () => {}); return res.status(500).json({ error: t('srv.upload_failed') }); } res.json({ success: true }); });
  });
  req.pipe(ws);
});

// ── تنزيل ملف ────────────────────────────────────────────────────────────────
app.get('/api/files/download', requireAuth, async (req, res) => {
  const abs = filePath(req.query.path);
  if (!abs) return res.status(400).json({ error: t('srv.invalid_path') });
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: t('srv.folders_cannot_be_downloaded_directly') });
    res.download(abs, path.basename(abs));
  } catch { res.status(404).json({ error: t('srv.file_not_found') }); }
});

app.post('/api/files/delete', requireAuth, async (req, res) => {
  const abs = filePath((req.body || {}).path);
  if (!abs)               return res.status(400).json({ error: t('srv.invalid_path') });
  if (abs === SERVER_DIR) return res.status(400).json({ error: t('srv.cannot_delete_the_root') });
  try {
    await fsp.rm(abs, { recursive: true, force: true });
    res.json({ success: true });
  } catch { res.status(500).json({ error: t('srv.delete_failed') }); }
});

// ── إعادة تسمية / نقل ملف أو مجلد ─────────────────────────────────────────────
app.post('/api/files/rename', requireAuth, async (req, res) => {
  const newName = typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
  const absFrom = filePath((req.body || {}).path);
  if (!absFrom)  return res.status(400).json({ error: t('srv.invalid_path') });
  if (!newName || /[\\/]/.test(newName) || newName === '.' || newName === '..')
    return res.status(400).json({ error: t('srv.invalid_name') });
  const absTo = path.join(path.dirname(absFrom), newName);
  if (absFrom === SERVER_DIR || !filePath(path.relative(SERVER_DIR, absTo))) return res.status(400).json({ error: t('srv.invalid_target_path') });
  try {
    if (fs.existsSync(absTo)) return res.status(409).json({ error: t('srv.a_file_folder_with_that_name_already_exists') });
    await fsp.rename(absFrom, absTo);
    res.json({ success: true });
  } catch { res.status(500).json({ error: t('srv.rename_failed') }); }
});

// ── Monitoring history + alerts ──────────────────────────────────────────────
const { createMonitor } = require('./lib/monitor');
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
  if (r.error) return res.status(400).json({ error: r.error === 'discord' ? t('srv.invalid_discord_webhook_url') : t('srv.invalid_telegram_details') });
  res.json({ success: true });
});
app.post('/api/alerts/test', async (_req, res) => {
  const c = monitor.getConfig();
  if (!c.hasDiscord && !c.hasTelegram) return res.status(400).json({ error: t('srv.no_alert_channel_discord_or_telegram_is_conf') });
  const failed = await monitor.test();
  failed.length ? res.status(502).json({ error: t('srv.delivery_failed') + ': ' + failed.join('; ') }) : res.json({ success: true });
});

// ── Off-site backup copies (rclone) ──────────────────────────────────────────
const { createOffsite } = require('./lib/offsite');
const offsite = createOffsite({ dir: SERVER_DIR });
const destError = code => {
  if (code === 'notfound') return t('srv.destination_not_found');
  if (code === 'limit') return t('srv.destination_limit_reached');
  if (code === 'path') return t('srv.invalid_destination_path');
  if (/^field:/.test(code)) return t('srv.destination_check_field', { v0: code.slice(6) });
  return t('srv.invalid_destination_settings');
};
app.get('/api/backups/destinations', (_req, res) => res.json({ destinations: offsite.list(), types: offsite.TYPES, enums: offsite.ENUMS }));
app.post('/api/backups/destinations', (req, res) => {
  const r = offsite.save(req.body || {});
  r.error ? res.status(400).json({ error: destError(r.error) }) : res.json({ success: true, id: r.id });
});
app.post('/api/backups/destinations/delete', (req, res) => {
  const r = offsite.remove(String((req.body || {}).id || ''));
  r.error ? res.status(404).json({ error: destError(r.error) }) : res.json({ success: true });
});
app.post('/api/backups/destinations/test', async (req, res) => {
  try { await offsite.test(String((req.body || {}).id || '')); res.json({ success: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Plugin manager (Modrinth) and Paper jar download ─────────────────────────
const downloads = require('./lib/downloads').createDownloads();
const PLUGINS_DIR = path.join(SERVER_DIR, 'plugins');
const PLUGIN_FILE_RE = /^[\w.+ -]{1,120}\.jar(\.disabled)?$/;
const DL_ERRORS = new Set(["no compatible version", "checksum mismatch", "file too large", "blocked host", "bad file name", "bad project", "bad version", "no file", "no download"]);
const dlError = e => (e && DL_ERRORS.has(e.message)) ? t('srv.dl_' + e.message.replace(/ /g, '_')) : ((e && e.message) || t('srv.operation_failed'));
const mcVersionOnly = () => ((detectVersion() || '').match(/\d+\.\d+(?:\.\d+)?/) || [null])[0];

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

// Where each installed jar came from, so the browse tab can mark a project as installed exactly and updates can be found:
// 1) what the panel itself installed (.panel-plugin-sources.json), 2) Modrinth's hash lookup for any other jar.
const PLUGIN_SOURCES_FILE = path.join(SERVER_DIR, '.panel-plugin-sources.json');
let pluginSources = {};   // jar name (without .disabled) -> { project: "modrinth:<id>"|"hangar:<slug>", version, date }
try { pluginSources = JSON.parse(fs.readFileSync(PLUGIN_SOURCES_FILE, 'utf8')) || {}; } catch { pluginSources = {}; }
for (const [k, v] of Object.entries(pluginSources)) if (typeof v === 'string') pluginSources[k] = { project: v };   // 1.3.4 format
const baseJar = f => String(f).replace(/\.disabled$/, '');
function notePluginSource(file, source, id, version, date) {
  pluginSources[baseJar(file)] = { project: source + ':' + id, version: version || '', date: date || 0 };
  try { fs.writeFileSync(PLUGIN_SOURCES_FILE, JSON.stringify(pluginSources)); } catch {}
}
function forgetPluginSource(file) {
  if (pluginSources[baseJar(file)]) { delete pluginSources[baseJar(file)]; try { fs.writeFileSync(PLUGIN_SOURCES_FILE, JSON.stringify(pluginSources)); } catch {} }
}
const sha1Cache = new Map();        // "file|size|mtime" -> sha1
const modrinthIdCache = new Map();  // sha1 -> { info: { id, version, date } | null, at }
async function pluginProjects(list) {
  const want = [];
  for (const p of list) {
    const key = p.file + '|' + p.size + '|' + p.date;
    if (!sha1Cache.has(key)) {
      try { sha1Cache.set(key, crypto.createHash('sha1').update(await fsp.readFile(path.join(PLUGINS_DIR, p.file))).digest('hex')); } catch { sha1Cache.set(key, null); }
    }
    p.sha1 = sha1Cache.get(key);
    const c = p.sha1 && modrinthIdCache.get(p.sha1);
    if (p.sha1 && (!c || Date.now() - c.at > 6 * 3600000)) want.push(p.sha1);
  }
  if (want.length) {
    try {
      const found = await downloads.identifyModrinth(want);
      for (const h of want) modrinthIdCache.set(h, { info: found[h] || null, at: Date.now() });
    } catch {}   // offline: fall back to names in the browser
  }
  for (const p of list) {
    const ids = [], rec = pluginSources[baseJar(p.file)];
    if (rec && rec.project) ids.push(rec.project);
    const c = p.sha1 && modrinthIdCache.get(p.sha1), info = c && c.info;
    if (info && !ids.includes('modrinth:' + info.id)) ids.push('modrinth:' + info.id);
    p.projects = ids;
    // what the update check compares against: the panel's own record first, else Modrinth's answer for this exact file
    p._origin = rec && rec.project ? { project: rec.project, version: rec.version || p.version || '', date: rec.date || 0 }
      : info ? { project: 'modrinth:' + info.id, version: info.version, date: info.date, sha1: p.sha1 } : null;
    delete p.sha1;
  }
}

async function listPlugins() {
  const files = (await fsp.readdir(PLUGINS_DIR)).filter(f => PLUGIN_FILE_RE.test(f)).slice(0, 300);
  const out = [];
  for (const f of files) {
    const full = path.join(PLUGINS_DIR, f), st = await fsp.stat(full);
    out.push({ file: f, enabled: !f.endsWith('.disabled'), size: st.size, date: st.mtimeMs, ...(await pluginMeta(full)) });
  }
  await pluginProjects(out);
  out.sort((a, b) => (a.name || a.file).toLowerCase().localeCompare((b.name || b.file).toLowerCase()));
  return out;
}

app.get('/api/plugins', async (_req, res) => {
  try {
    const out = await listPlugins();
    for (const p of out) delete p._origin;
    res.json({ plugins: out, mcVersion: mcVersionOnly() });
  } catch { res.json({ plugins: [], mcVersion: mcVersionOnly() }); }
});

// ── Plugin updates: newest compatible version from the same source, only when it is really newer ─────────────
async function latestFor(origin, mc) {
  const [src, id] = origin.project.split(/:(.*)/s);
  const latest = src === 'hangar' ? await downloads.latestHangar(id, mc) : await downloads.latestModrinth(id, mc);
  const same = origin.sha1 && latest.file.sha1 ? origin.sha1 === latest.file.sha1 : latest.version === origin.version;
  // never "update" to an older build (for example when a beta newer than the latest release is installed)
  const newer = !same && (!origin.date || !latest.date || latest.date > origin.date);
  return { src, id, latest, newer };
}
let pluginUpdateCache = { at: 0, list: null };
app.get('/api/plugins/updates', async (req, res) => {
  if (req.query.force !== '1' && pluginUpdateCache.list && Date.now() - pluginUpdateCache.at < 15 * 60000) return res.json({ updates: pluginUpdateCache.list, checkedAt: pluginUpdateCache.at });
  try {
    const mc = mcVersionOnly(), list = await listPlugins(), updates = [];
    await Promise.all(list.filter(p => p._origin).map(async p => {
      try {
        const r = await latestFor(p._origin, mc);
        if (r.newer) updates.push({ file: p.file, name: p.name || p.file, source: r.src, current: p._origin.version || p.version || '', latest: r.latest.version });
      } catch {}   // not compatible any more, project gone, site down: no update offered
    }));
    pluginUpdateCache = { at: Date.now(), list: updates };
    res.json({ updates, checkedAt: pluginUpdateCache.at, checked: list.filter(p => p._origin).length, total: list.length });
  } catch (e) { res.status(502).json({ error: dlError(e) }); }
});

let pluginUpdateBusy = false;
// Replaces one jar with the newest compatible version. The old jar is kept in .panel-old-plugins and put back if the
// download fails. A disabled plugin stays disabled. The server loads the new jar on its next restart.
async function updateOnePlugin(file, mc) {
  const list = await listPlugins(), p = list.find(x => x.file === file);
  if (!p || !p._origin) throw new Error(t('srv.plugin_update_unknown_source'));
  const r = await latestFor(p._origin, mc);
  if (!r.newer) return { file, updated: false };
  const oldDir = path.join(SERVER_DIR, '.panel-old-plugins');
  await fsp.mkdir(oldDir, { recursive: true });
  const kept = path.join(oldDir, file + '.' + Date.now());
  await fsp.rename(path.join(PLUGINS_DIR, file), kept);
  let got;
  try { got = await downloads.fetchPluginFile(r.src, r.latest, PLUGINS_DIR); }
  catch (e) { await fsp.rename(kept, path.join(PLUGINS_DIR, file)).catch(() => {}); throw e; }
  let newFile = got.file;
  if (file.endsWith('.disabled')) { await fsp.rename(path.join(PLUGINS_DIR, newFile), path.join(PLUGINS_DIR, newFile + '.disabled')); newFile += '.disabled'; }
  if (baseJar(file) !== baseJar(newFile)) forgetPluginSource(file);
  notePluginSource(newFile, r.src, r.id, r.latest.version, r.latest.date);
  return { file, newFile, updated: true, from: p._origin.version || p.version || '', to: r.latest.version };
}
app.post('/api/plugins/update', async (req, res) => {
  const b = req.body || {}, mc = mcVersionOnly();
  const files = b.all === true ? (pluginUpdateCache.list || []).map(u => u.file) : [String(b.file || '')];
  if (!files.length || files.some(f => !PLUGIN_FILE_RE.test(f))) return res.status(400).json({ error: t('srv.invalid_file_name') });
  if (pluginUpdateBusy) return res.status(409).json({ error: t('srv.plugin_update_busy') });
  pluginUpdateBusy = true;
  const results = [];
  try {
    for (const f of files) {
      try { results.push(await updateOnePlugin(f, mc)); }
      catch (e) { results.push({ file: f, updated: false, error: dlError(e) }); }
    }
  } finally { pluginUpdateBusy = false; }
  pluginUpdateCache = { at: 0, list: null };
  const updated = results.filter(r => r.updated);
  if (updated.length) broadcast({ type: 'log', data: t('srv.panel_plugins_updated', { v0: updated.map(r => r.newFile).join(', ') }) + '\n' });
  res.json({ success: true, results });
});

function pluginPath(name) {
  const f = String(name || '');
  return PLUGIN_FILE_RE.test(f) ? path.join(PLUGINS_DIR, f) : null;
}
app.post('/api/plugins/toggle', async (req, res) => {
  const p = pluginPath((req.body || {}).file);
  if (!p) return res.status(400).json({ error: t('srv.invalid_file_name') });
  try {
    const to = p.endsWith('.disabled') ? p.slice(0, -'.disabled'.length) : p + '.disabled';
    await fsp.rename(p, to);
    res.json({ success: true });
  } catch { res.status(404).json({ error: t('srv.file_not_found') }); }
});
app.post('/api/plugins/delete', async (req, res) => {
  const p = pluginPath((req.body || {}).file);
  if (!p) return res.status(400).json({ error: t('srv.invalid_file_name') });
  try { await fsp.unlink(p); forgetPluginSource(path.basename(p)); res.json({ success: true }); }
  catch { res.status(404).json({ error: t('srv.file_not_found') }); }
});
app.get('/api/plugins/search', async (req, res) => {
  try { res.json({ results: await (req.query.source === 'hangar' ? downloads.searchHangar : downloads.searchPlugins)(req.query.q, mcVersionOnly()) }); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
app.post('/api/plugins/install', async (req, res) => {
  const b = req.body || {}, src = b.source === 'hangar' ? 'hangar' : 'modrinth';
  try {
    const r = await (src === 'hangar' ? downloads.installHangar : downloads.installPlugin)(b.id, mcVersionOnly(), PLUGINS_DIR);
    notePluginSource(r.file, src, String(b.id), r.version, r.date);
    res.json({ success: true, ...r });
  }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
// ── Server jar: current version/build, update check, download a chosen build, one-click update ───────────
function currentBuild() {
  try {
    const h = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'version_history.json'), 'utf8'));
    const m = /Paper-(\d+)/i.exec(String(h.currentVersion || ''));
    if (m) return Number(m[1]);
  } catch {}
  if (serverBuild) return serverBuild;
  // Newer Paper builds do not write version_history.json and the jar may have a fixed name (paper.jar):
  // the startup log is then the only place that says which build is running.
  for (const f of [MC_LOG_FILE, path.join(SERVER_DIR, 'logs', 'latest.log')]) {
    try {
      const fd = fs.openSync(f, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 400000), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const all = [...buf.toString('utf8').matchAll(/running Paper version\s+\d+(?:\.\d+)*-(\d+)-/gi)];
        if (all.length) { serverBuild = Number(all[all.length - 1][1]); return serverBuild; }
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  const jm = /-(\d+)\.jar$/.exec(serverJar() || '');
  return jm ? Number(jm[1]) : null;
}
let updateCache = { at: 0, data: null };
async function checkUpdate(force) {
  if (!force && updateCache.data && Date.now() - updateCache.at < 10 * 60000) return updateCache.data;
  const mc = mcVersionOnly(), build = currentBuild();
  const data = { mc, build, jar: serverJar(), latestBuild: null, newerVersion: null, updateAvailable: false };
  const versions = await downloads.paperVersions();
  if (mc) {
    try { const l = await downloads.paperLatest(mc); data.latestBuild = l.id; data.channel = l.channel; } catch {}
    data.updateAvailable = build != null && data.latestBuild != null && data.latestBuild > build;
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 4; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
    if (versions.length && cmp(versions[0], mc) > 0) data.newerVersion = versions[0];
  }
  data.versions = versions;
  updateCache = { at: Date.now(), data };
  return data;
}
app.get('/api/jars/paper', async (_req, res) => {
  try { res.json({ versions: await downloads.paperVersions(), current: serverJar(), running: runningJarName(), mc: mcVersionOnly(), build: currentBuild() }); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
app.get('/api/jars/paper/builds', async (req, res) => {
  try { res.json({ builds: await downloads.paperBuilds(String(req.query.version || '')) }); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});
app.get('/api/jars/update-check', async (req, res) => {
  try { res.json(await checkUpdate(req.query.force === '1')); }
  catch (e) { res.status(502).json({ error: dlError(e) }); }
});

let jarUpdateBusy = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Runs after the HTTP reply: backup -> stop -> replace the jar (the old one is kept) -> start again.
async function applyJarUpdate(newFile, { backup, restart }) {
  try {
    if (backup) {
      broadcast({ type: 'log', data: t('srv.panel_update_backing_up') + '\n' });
      await createBackup({ keep: 0 });
    }
    if (isRunning()) {
      broadcast({ type: 'log', data: t('srv.panel_update_stopping') + '\n' });
      restartPending = false; intentionalStop = true; sendCommand('stop');
      for (let i = 0; i < 90 && isRunning(); i++) await sleep(1000);
      if (isRunning()) throw new Error(t('srv.panel_update_stop_timeout'));
    }
    const target = path.join(SERVER_DIR, serverJar()), src = path.join(SERVER_DIR, newFile);
    if (path.resolve(target) !== path.resolve(src)) {
      const oldDir = path.join(SERVER_DIR, '.panel-old-jars');
      await fsp.mkdir(oldDir, { recursive: true });
      if (fs.existsSync(target)) await fsp.rename(target, path.join(oldDir, serverJar() + '.' + Date.now()));
      await fsp.copyFile(src, target);
    }
    broadcast({ type: 'log', data: t('srv.panel_update_done', { v0: newFile }) + '\n' });
    updateCache = { at: 0, data: null }; serverVersion = null; serverBuild = null;
    if (restart) { intentionalStop = false; startMC(); }
  } catch (e) {
    broadcast({ type: 'log', data: t('srv.panel_update_failed') + e.message + '\n' });
  } finally { jarUpdateBusy = false; }
}
app.post('/api/jars/paper', async (req, res) => {
  const b = req.body || {}, user = req.session && req.session.user;
  const apply = b.apply === true;
  if (apply && !(auth.has(user, 'server.stop') && auth.has(user, 'server.start'))) return res.status(403).json({ error: t('srv.you_do_not_have_permission_for_this_action') });
  if (apply && b.backup !== false && !auth.has(user, 'backups.create')) return res.status(403).json({ error: t('srv.you_do_not_have_permission_for_this_action') });
  if (jarUpdateBusy) return res.status(409).json({ error: t('srv.panel_update_busy') });
  try {
    const r = await downloads.downloadPaper(b.version, SERVER_DIR, b.build);
    if (b.eula === true) {
      await fsp.writeFile(path.join(SERVER_DIR, 'eula.txt'), '# Accepted by the panel user (https://aka.ms/MinecraftEULA)\neula=true\n');
      broadcast({ type: 'log', data: t('srv.panel_eula_accepted_at_your_request') + '\n' });
    }
    if (apply) { jarUpdateBusy = true; applyJarUpdate(r.file, { backup: b.backup !== false, restart: b.restart !== false && isRunning() }); }
    res.json({ success: true, applying: apply, ...r });
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

// opts: { keep: keep the newest N local backups (0 = all), dests: destination ids (undefined = the "auto" ones),
//         keepLocal: false deletes the local zip once every destination has it }
async function createBackup(opts = {}) {
  if (typeof opts === 'number') opts = { keep: opts };
  const keep = opts.keep || 0;
  if (backupBusy || restoreBusy) throw new Error('__BUSY__');
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
    for (const w of worldDirs()) {
      const p = path.join(SERVER_DIR, w);
      if (fs.existsSync(p)) archive.directory(p, w);
    }
    for (const c of ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json']) {
      const p = path.join(SERVER_DIR, c);
      if (fs.existsSync(p)) archive.file(p, { name: c });
    }
    await new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); archive.finalize(); });
    const removed = await pruneBackups(keep);
    const ids = offsite.resolve(opts.dests);
    let uploaded = 0, failed = 0;
    for (const id of ids) {
      try {
        const r = await offsite.upload(id, out); uploaded++;
        broadcast({ type: 'log', data: t('srv.panel_backup_copied_off_site') + name + ' → ' + offsite.name(id) + (r.removed ? t('srv.old_removed_suffix', { v0: r.removed }) : '') + '\n' });
      } catch (e) { failed++; broadcast({ type: 'log', data: t('srv.panel_off_site_copy_failed') + offsite.name(id) + ': ' + e.message + '\n' }); }
    }
    if (opts.keepLocal === false && uploaded > 0 && !failed) await fsp.unlink(out).catch(() => {});
    return { name, removed, uploaded: uploaded > 0, destinations: ids.length, failed };
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
const { createScheduler } = require('./lib/scheduler');
const scheduler = createScheduler({
  file: path.join(SERVER_DIR, '.panel-schedule.json'),
  sanitizeCommand,
  log: line => broadcast({ type: 'log', data: line }),
  actions: {
    isRunning,
    command: sendCommand,
    backup: opts => createBackup(opts),
    restart: warn => restartWithCountdown(warn),
  },
  t: {
    get badType() { return t('srv.invalid_task_type'); }, get badCron() { return t('srv.invalid_cron_schedule'); }, get badSchedule() { return t('srv.invalid_schedule'); }, get missed() { return t('srv.missed_server_was_down'); }, get badArg() { return t('srv.invalid_text_or_command'); }, get tooMany() { return t('srv.task_limit_reached_50'); }, get notFound() { return t('srv.task_not_found'); },
    get alreadyRunning() { return t('srv.task_is_already_running'); }, get skippedBusy() { return t('srv.skipped_restart_already_in_progress'); }, get skippedStopped() { return t('srv.skipped_server_is_stopped'); },
    ranBackup: (n, b, r) => t('srv.panel_scheduled_task_v0_backup_v1',{v0:n,v1:b}) + (r ? t('srv.old_removed_suffix',{v0:r}) : '') + '\n',
    ranRestart: (n, w) => t('srv.panel_scheduled_task_v0_restarting_in_v1_s',{v0:n,v1:w}),
    ranGeneric: n => t('srv.panel_scheduled_task_v0_ran',{v0:n}),
    failed: (n, e) => t('srv.panel_task_v0_failed_v1',{v0:n,v1:e}),
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
  scheduler.remove(String((req.body || {}).id || '')) ? res.json({ success: true }) : res.status(404).json({ error: t('srv.task_not_found') });
});
app.post('/api/schedule/run', requireAuth, async (req, res) => {
  const status = await scheduler.runNow(String((req.body || {}).id || ''));
  status === null ? res.status(404).json({ error: t('srv.task_not_found') }) : res.json({ success: true, status });
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

app.post('/api/backups/create', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const { name, uploaded, failed } = await createBackup({ dests: Array.isArray(b.dests) ? b.dests.map(String) : undefined, keepLocal: b.keepLocal !== false });
    res.json({ success: true, name, uploaded, failed });
  } catch (e) {
    res.status(e.message === '__BUSY__' ? 409 : 500).json({ error: t('srv.backup_failed') });
  }
});

// Restoring only ever writes what a panel backup contains (the worlds and the five config files), checks every
// entry before touching anything, replaces each world folder as a whole (no leftovers from after the backup), and
// puts the previous files back if anything fails half way.
const RESTORE_FILES = ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json'];
let restoreBusy = false;
async function restoreBackup(file) {
  const { pipeline } = require('stream/promises');
  const zip = await unzipper.Open.file(file);
  const RESTORE_TOP = new Set(['world', 'world_nether', 'world_the_end', ...worldDirs(), ...RESTORE_FILES]);
  const entries = [];
  for (const e of zip.files) {
    const rel = String(e.path).replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) continue;
    if (!RESTORE_TOP.has(parts[0]) || parts.some(x => x === '..' || x === '.') || rel.startsWith('/')) throw new Error('unexpected entry in archive: ' + rel.slice(0, 80));
    const abs = safePath(parts.join('/'));
    if (!abs) throw new Error('unexpected entry in archive: ' + rel.slice(0, 80));
    entries.push({ e, abs, dir: e.type === 'Directory' || rel.endsWith('/') });
  }
  if (!entries.length) throw new Error('empty archive');
  const tops = [...new Set(entries.map(x => path.relative(SERVER_DIR, x.abs).split(path.sep)[0]))];
  const existed = new Set(tops.filter(x => fs.existsSync(path.join(SERVER_DIR, x))));
  const stash = path.join(SERVER_DIR, '.panel-restore-old', String(Date.now()));
  await fsp.mkdir(stash, { recursive: true });
  const moved = [];
  try {
    for (const x of tops) if (existed.has(x)) { await fsp.rename(path.join(SERVER_DIR, x), path.join(stash, x)); moved.push(x); }
    for (const { e, abs, dir } of entries) {
      if (dir) { await fsp.mkdir(abs, { recursive: true }); continue; }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await pipeline(e.stream(), fs.createWriteStream(abs));
    }
  } catch (err) {
    for (const x of tops) {
      if (moved.includes(x)) { await fsp.rm(path.join(SERVER_DIR, x), { recursive: true, force: true }).catch(() => {}); await fsp.rename(path.join(stash, x), path.join(SERVER_DIR, x)).catch(() => {}); }
      else if (!existed.has(x)) await fsp.rm(path.join(SERVER_DIR, x), { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
  await fsp.rm(stash, { recursive: true, force: true }).catch(() => {});
}

app.post('/api/backups/restore', requireAuth, async (req, res) => {
  const name = typeof (req.body || {}).name === 'string' ? req.body.name : '';
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: t('srv.invalid_name') });
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file))         return res.status(404).json({ error: t('srv.backup_not_found') });
  if (restoreBusy || backupBusy)    return res.status(409).json({ error: t('srv.backup_or_restore_in_progress') });
  restoreBusy = true;

  const run = async () => {
    try {
      if (isRunning()) {
        restartPending = false; intentionalStop = true;   // stopped on purpose for the restore
        sendCommand('stop');
        for (let i = 0; i < 90 && isRunning(); i++) await new Promise(r => setTimeout(r, 1000));
        if (isRunning()) throw new Error(t('srv.panel_update_stop_timeout'));
      }
      await restoreBackup(file);
      broadcast({ type: 'log', data: `[Panel] Restored from ${name}\n` });
    } catch (e) {
      broadcast({ type: 'log', data: `[Panel] Restore failed: ${e.message}\n` });
    } finally { restoreBusy = false; }
  };
  run();
  res.json({ success: true });
});

app.post('/api/backups/delete', requireAuth, async (req, res) => {
  const name = String(req.body.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: t('srv.invalid_name') });
  try { await fsp.unlink(path.join(BACKUPS_DIR, name)); res.json({ success: true }); }
  catch { res.status(500).json({ error: t('srv.delete_failed') }); }
});

app.get('/api/backups/download', requireAuth, (req, res) => {
  const name = String(req.query.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: t('srv.invalid_name') });
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: t('srv.not_found') });
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
  } catch { res.status(500).json({ error: t('srv.read_failed') }); }
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
  } catch { res.status(500).json({ error: t('srv.save_failed') }); }
});

// ── Settings: startup (JVM) ───────────────────────────────────────────────────
app.get('/api/settings/startup', requireAuth, (_req, res) => {
  res.json({ ...loadStartupCfg(), totalRamGB: Math.round(os.totalmem() / (1024 ** 3)) });
});

app.post('/api/settings/startup', requireAuth, async (req, res) => {
  const { xms, xmx, g1gc, extraFlags } = req.body || {};
  const memRe = /^\d{1,6}[MG]$/;
  if (typeof xms !== 'string' || typeof xmx !== 'string' || !memRe.test(xms) || !memRe.test(xmx)) return res.status(400).json({ error: t('srv.invalid_memory_values') });
  const jf = parseJvmFlags(typeof extraFlags === 'string' ? extraFlags : '');
  if (jf.bad.length) return res.status(400).json({ error: t('srv.invalid_jvm_flags', { v0: jf.bad.slice(0, 3).join(' ') }) });
  const cfg = { xms, xmx, g1gc: !!g1gc, extraFlags: jf.flags.join(' ') };
  try {
    await fsp.writeFile(STARTUP_CFG, JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: t('srv.save_failed') }); }
});

// ── WebSocket (session required) ─────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  sessionMw(req, {}, () => {
    if (!req.session || !auth.roleOf(req.session.user)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => { ws.user = req.session.user; wss.emit('connection', ws, req); });
  });
});
wss.on('connection', ws => {
  if (logBuffer.length && auth.has(ws.user, 'console.view')) ws.send(JSON.stringify({ type: 'log', data: logBuffer.join('') }));

  ws.send(JSON.stringify({
    type:    'status',
    running: isRunning(),
    version: detectVersion(),
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
// نحسب النسبة من فرق وقت المعالج (utime+stime) بين قياسين، مقسوم على عدد الأنوية
// عشان تكون النتيجة من 0 لـ 100% (نسبة من كامل قدرة الجهاز، مثل Task Manager)
async function readCpuUsagePct(pid) {
  const statPath = `/proc/${pid}/stat`;
  if (!fs.existsSync(statPath)) return null;
  const txt = await fsp.readFile(statPath, 'utf8');
  const afterComm = txt.slice(txt.lastIndexOf(')') + 2).trim().split(/\s+/);
  const utime = parseInt(afterComm[11], 10); // الحقل 14
  const stime = parseInt(afterComm[12], 10); // الحقل 15
  if (Number.isNaN(utime) || Number.isNaN(stime)) return null;

  const now = Date.now();
  const prev = cpuSample;
  cpuSample = { utime, stime, time: now };
  if (!prev) return null; // أول قياس، نحتاج قياسين للمقارنة

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
    const msg = t('srv.panel_server_is_ready_started_monitoring_tps');
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

// ── Errors: bad JSON and the like get a short JSON answer, never an HTML page with a stack trace ─────────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'Invalid JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: t('srv.content_is_too_large') });
  console.error('[Panel] Request error:', req.method, req.path, err && err.message);
  res.status(500).json({ error: t('srv.operation_failed') });
});

// ── Listen ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Panel] http://localhost:${PORT}`);
  console.log(`[Panel] MC dir: ${SERVER_DIR} | Jar: ${serverJar()}`);
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
