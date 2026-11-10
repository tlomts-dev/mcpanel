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

// مكتبة قراءة NBT (لملفات playerdata) — اختيارية، لا تُسقط اللوحة إذا لم تُثبَّت
let nbt = null;
try { nbt = require('prismarine-nbt'); }
catch { console.warn('[Panel] prismarine-nbt غير مثبّتة — قراءة ملفات NBT المحفوظة ستكون معطّلة حتى تشغيل npm install'); }

// منفذ خادم HTTP المدمج داخل إضافة PanelDataLogger — يُستخدم للاستعلام المباشر
// عن بيانات اللاعبين المتصلين (أدق وأسرع بكثير من قراءة كونسول أو ملف محفوظ)
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
const USERS = { [ADMIN_USER]: ADMIN_HASH };
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

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
    return res.status(429).json({ error: `محاولات كثيرة. حاول بعد ${Math.ceil((e.resetAt-now)/1000)} ثانية.` });
  e.count++;
  next();
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000, httpOnly: true, sameSite: 'strict' },
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── State ─────────────────────────────────────────────────────────────────────
let restartPending  = false;
let intentionalStop = false; // المتغير الجديد لمعرفة هل الإيقاف متعمد من اللوحة أم لا
let serverVersion   = null;
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
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
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
  catch (e) { console.error('[Panel] فشل حفظ قاعدة بيانات اللاعبين:', e.message); }
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
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return 'world';
}

// قراءة إحصائيات اللاعب (JSON عادي، لا يحتاج مكتبة NBT) — world/stats/<uuid>.json
async function readPlayerStats(uuid) {
  try {
    const p = path.join(SERVER_DIR, getWorldName(), 'stats', `${uuid}.json`);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(await fsp.readFile(p, 'utf8'));
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
      const trim = it.components?.['minecraft:trim'];
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
  if (!nbt) return { available: false, reason: 'مكتبة prismarine-nbt غير مثبّتة على السيرفر (npm install)' };
  try {
    const p = path.join(SERVER_DIR, getWorldName(), 'playerdata', `${uuid}.dat`);
    if (!fs.existsSync(p)) return { available: false, reason: 'لا يوجد ملف بيانات في المسار: ' + p };
    const buf = await fsp.readFile(p);
    const { parsed } = await nbt.parse(buf);
    const d = nbt.simplify(parsed);
    return buildPlayerDataResult(d, false);
  } catch (e) {
    return { available: false, reason: 'تعذّرت قراءة/تحليل ملف NBT: ' + e.message };
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

// يستخرج اسم اللاعب الحقيقي من مقطع نص واحد ضمن رد أمر list
// الأولوية: أي اسم داخل <> (تنسيق يستخدمه بعض إضافات الفرق/الرتب لعزل الاسم الحقيقي)
// وإلا: آخر كلمة في النص (سلوك احتياطي متوافق مع الإصدارات السابقة)
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
    return true; // رد أمر tps الداخلي، يبقى مخفي عن الكونسول
  }

  const listMatch = line.match(/players online:\s*(.*)/i);
  if (listMatch) {
    const players = listMatch[1].split(',').map(s => {
      const name = extractPlayerName(s);
      return { name, display: name };
    }).filter(p => p.name && PLAYER_RE.test(p.name));
    syncOnlineFromList(players.map(p => p.name));
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
            cause: causeParts.join('|') || 'غير معروف',
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
    } catch (e) { console.error('[Panel] فشل تحليل سطر PanelData:', e.message); }
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

    // نظام التشغيل التلقائي إذا كان الإيقاف غير متعمد أو أمر ريستارت
    if (restartPending || !intentionalStop) {
      restartPending = false;
      const restartMsg = '[Panel] جاري إعادة التشغيل التلقائي خلال 5 ثوانٍ...\n';
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

  intentionalStop = false; // تصفير المتغير عند التشغيل

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
  return true;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body;
  const hash  = username && USERS[username];
  const valid = hash
    ? bcrypt.compareSync(String(password), hash)
    : (bcrypt.compareSync('dummy', '$2a$12$dummyhash..............................'), false);
  if (!valid) return res.status(401).json({ error: 'بيانات خاطئة' });
  loginAttempts.delete(req.ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.user = username;
    res.json({ success: true });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.get('/api/status', requireAuth, (_req, res) => res.json({
  running: isRunning(),
  version: serverVersion,
  uptime:  serverStartTime ? Date.now() - serverStartTime : null,
  tps:     lastTps,
  pid:     mcPid || null,
}));

// ── Server control ────────────────────────────────────────────────────────────
app.post('/api/start', requireAuth, (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'يعمل بالفعل' });
  intentionalStop = false;
  const ok = startMC();
  if (!ok) return res.status(500).json({ error: 'فشل تشغيل السيرفر' });
  res.json({ success: true });
});

app.post('/api/stop', requireAuth, (_req, res) => {
  if (!isRunning()) return res.status(409).json({ error: 'متوقف' });
  restartPending  = false;
  intentionalStop = true; // تم الإيقاف يدوياً من اللوحة، لن يتم إعادة التشغيل
  sendCommand('stop');
  res.json({ success: true });
});

app.post('/api/restart', requireAuth, (_req, res) => {
  if (!isRunning()) {
    intentionalStop = false;
    const ok = startMC();
    if (!ok) return res.status(500).json({ error: 'فشل تشغيل السيرفر' });
    return res.json({ success: true });
  }
  restartPending  = true;
  intentionalStop = false;
  sendCommand('stop');
  res.json({ success: true });
});

app.post('/api/command', requireAuth, (req, res) => {
  const cmd = sanitizeCommand(req.body.command);
  if (!cmd)         return res.status(400).json({ error: 'أمر غير صالح' });
  if (!isRunning()) return res.status(409).json({ error: 'السيرفر متوقف' });
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
    if (!p)           return res.status(400).json({ error: 'اسم لاعب غير صالح' });
    if (!isRunning()) return res.status(409).json({ error: 'السيرفر متوقف' });
    sendCommand(fn(p));
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
  res.json({ bans: bans.map(b => ({ name: b.name, reason: b.reason, created: b.created })) });
});
app.get('/api/whitelist', requireAuth, async (_req, res) => {
  const list = await readJsonFile('whitelist.json');
  res.json({ whitelist: list.map(w => ({ name: w.name || w, uuid: w.uuid })) });
});

// ── قاعدة بيانات اللاعبين (كل من دخل السيرفر تاريخياً) ────────────────────────
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
  if (!name) return res.status(400).json({ error: 'اسم لاعب غير صالح' });
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
      statsPath: path.join(SERVER_DIR, worldName, 'stats', `${uuid}.json`),
      playerDataPath: path.join(SERVER_DIR, worldName, 'playerdata', `${uuid}.dat`),
    },
  });
});

// ── حذف بيانات لاعب (مخزون/صندوق سحري/خبرة عبر إعادة كتابة ملف NBT، إحصائيات/تقدم كملفات، وسجل اللوحة) ──
app.post('/api/players/delete-data', requireAuth, async (req, res) => {
  const name = sanitizePlayer(req.body.name);
  if (!name) return res.status(400).json({ error: 'اسم لاعب غير صالح' });
  const parts = req.body.parts || {};
  const rec = getPlayerRecord(name);
  if (rec.online) return res.status(409).json({ error: 'لا يمكن حذف بيانات لاعب متصل الآن — أخرجه من السيرفر أولاً' });

  const { uuid } = await resolveUuid(name);
  const worldName = getWorldName();
  const results = {};

  if ((parts.inventory || parts.enderChest || parts.xp)) {
    if (!nbt) return res.status(500).json({ error: 'مكتبة prismarine-nbt غير مثبّتة على السيرفر (npm install)' });
    try {
      const p = path.join(SERVER_DIR, worldName, 'playerdata', `${uuid}.dat`);
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
      return res.status(500).json({ error: 'فشل تعديل ملف اللاعب: ' + e.message });
    }
  }

  if (parts.stats) {
    try {
      const p = path.join(SERVER_DIR, worldName, 'stats', `${uuid}.json`);
      if (fs.existsSync(p)) await fsp.unlink(p);
      results.stats = true;
    } catch {}
  }
  if (parts.advancements) {
    try {
      const p = path.join(SERVER_DIR, worldName, 'advancements', `${uuid}.json`);
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
  if (!abs) return res.status(400).json({ error: 'مسار غير صالح' });
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
  } catch { res.status(500).json({ error: 'فشل قراءة المجلد' }); }
});

app.get('/api/files/read', requireAuth, async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'مسار غير صالح' });
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile())            return res.status(400).json({ error: 'ليس ملفاً' });
    if (stat.size > MAX_EDIT_SIZE) return res.status(413).json({ error: 'الملف كبير جداً (>2MB)' });
    const ext = path.extname(abs).toLowerCase();
    if (!EDITABLE_EXT.has(ext))    return res.status(415).json({ error: 'نوع ملف غير قابل للتعديل' });
    const content = await fsp.readFile(abs, 'utf8');
    res.json({ content });
  } catch { res.status(500).json({ error: 'فشل قراءة الملف' }); }
});

app.post('/api/files/write', requireAuth, async (req, res) => {
  const rel = String(req.body.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'مسار غير صالح' });
  const content = String(req.body.content ?? '');
  if (content.length > MAX_EDIT_SIZE) return res.status(413).json({ error: 'المحتوى كبير جداً' });
  const ext = path.extname(abs).toLowerCase();
  if (!EDITABLE_EXT.has(ext)) return res.status(415).json({ error: 'نوع ملف غير قابل للتعديل' });
  try {
    await fsp.writeFile(abs, content, 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'فشل الكتابة' }); }
});

app.post('/api/files/upload', requireAuth, (req, res) => {
  const relPath = decodeURIComponent(req.headers['x-path'] || '');
  const fileName = decodeURIComponent(req.headers['x-filename'] || '');
  const absDir = safePath(relPath);
  if (!absDir) return res.status(400).json({ error: 'مسار غير صالح' });
  const absFile = path.join(absDir, fileName);
  if (!absFile.startsWith(SERVER_DIR)) return res.status(400).json({ error: 'مسار غير صالح' });

  const writeStream = fs.createWriteStream(absFile);
  req.pipe(writeStream);
  req.on('end', () => res.json({ success: true }));
  req.on('error', () => res.status(500).json({ error: 'فشل الرفع' }));
});

// ── تنزيل ملف ────────────────────────────────────────────────────────────────
app.get('/api/files/download', requireAuth, async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = safePath(rel);
  if (!abs) return res.status(400).json({ error: 'مسار غير صالح' });
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'المجلدات لا يمكن تنزيلها مباشرة' });
    res.download(abs, path.basename(abs));
  } catch { res.status(404).json({ error: 'الملف غير موجود' }); }
});

app.post('/api/files/delete', requireAuth, async (req, res) => {
  const rel = String(req.body.path || '');
  const abs = safePath(rel);
  if (!abs)               return res.status(400).json({ error: 'مسار غير صالح' });
  if (abs === SERVER_DIR) return res.status(400).json({ error: 'لا يمكن حذف الجذر' });
  try {
    await fsp.rm(abs, { recursive: true, force: true });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'فشل الحذف' }); }
});

// ── إعادة تسمية / نقل ملف أو مجلد ─────────────────────────────────────────────
app.post('/api/files/rename', requireAuth, async (req, res) => {
  const relFrom = String(req.body.path || '');
  const newName = String(req.body.newName || '').trim();
  const absFrom = safePath(relFrom);
  if (!absFrom)  return res.status(400).json({ error: 'مسار غير صالح' });
  if (!newName || /[\\/]/.test(newName) || newName === '.' || newName === '..')
    return res.status(400).json({ error: 'اسم غير صالح' });
  const absTo = path.join(path.dirname(absFrom), newName);
  if (!safePath(path.relative(SERVER_DIR, absTo))) return res.status(400).json({ error: 'مسار هدف غير صالح' });
  try {
    if (fs.existsSync(absTo)) return res.status(409).json({ error: 'يوجد ملف/مجلد بنفس الاسم' });
    await fsp.rename(absFrom, absTo);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'فشل إعادة التسمية' }); }
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
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const name  = `backup-${stamp}.zip`;
  const out   = path.join(BACKUPS_DIR, name);
  try {
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
    res.json({ success: true, name });
  } catch { res.status(500).json({ error: 'فشل إنشاء النسخة' }); }
});

app.post('/api/backups/restore', requireAuth, async (req, res) => {
  const name = String(req.body.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'اسم غير صالح' });
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file))         return res.status(404).json({ error: 'النسخة غير موجودة' });

  if (isRunning()) {
    intentionalStop = true; // إيقاف متعمد لإرجاع النسخة
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
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'اسم غير صالح' });
  try { await fsp.unlink(path.join(BACKUPS_DIR, name)); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'فشل الحذف' }); }
});

app.get('/api/backups/download', requireAuth, (req, res) => {
  const name = String(req.query.name || '');
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ error: 'اسم غير صالح' });
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'غير موجود' });
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
  } catch { res.status(500).json({ error: 'فشل القراءة' }); }
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
  } catch { res.status(500).json({ error: 'فشل الحفظ' }); }
});

// ── Settings: startup (JVM) ───────────────────────────────────────────────────
app.get('/api/settings/startup', requireAuth, (_req, res) => {
  res.json({ ...loadStartupCfg(), totalRamGB: Math.round(os.totalmem() / (1024 ** 3)) });
});

app.post('/api/settings/startup', requireAuth, async (req, res) => {
  const { xms, xmx, g1gc, extraFlags } = req.body;
  const memRe = /^\d+[MG]$/;
  if (!memRe.test(xms) || !memRe.test(xmx)) return res.status(400).json({ error: 'قيم ذاكرة غير صالحة' });
  const cfg = { xms, xmx, g1gc: !!g1gc, extraFlags: String(extraFlags || '') };
  try {
    await fsp.writeFile(STARTUP_CFG, JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'فشل الحفظ' }); }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
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
    const msg = '[Panel] السيرفر جاهز — بدء مراقبة TPS\n';
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
