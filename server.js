/**
 * MC Panel - server.js (v4 - Auto-Restart Edition)
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

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '8080', 10);
const SERVER_DIR  = path.resolve(process.env.MC_DIR || '/opt/minecraft');
const SERVER_JAR  = process.env.MC_JAR || 'spigot-1.21.11.jar';
const BACKUPS_DIR = path.join(SERVER_DIR, 'backups');
const STARTUP_CFG = path.join(SERVER_DIR, '.panel-startup.json');
const SESSION_SEC = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ── tmux config ───────────────────────────────────────────
const TMUX_SESSION = process.env.TMUX_SESSION || 'mcserver';
const MC_LOG_FILE  = path.join(SERVER_DIR, '.mc-panel.log');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_HASH = process.env.ADMIN_HASH || bcrypt.hashSync(process.env.ADMIN_PASS, 12);
const USERS = { [ADMIN_USER]: ADMIN_HASH };
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Validation ────────────────────────────────────────────────────────────────
const PLAYER_RE     = /^[a-zA-Z0-9_]{1,16}$/;
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

const LOG_MAX   = 500;
const logBuffer = [];

function pushLog(line) { logBuffer.push(line); if (logBuffer.length > LOG_MAX) logBuffer.shift(); }

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
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
  try {
    const safe = cmd.replace(/'/g, "'\\''");
    execSync(`TMUX= tmux send-keys -t ${TMUX_SESSION} '${safe}' Enter`);
    const echo = `> ${cmd}\n`;
    pushLog(echo);
    broadcast({ type: 'log', data: echo });
  } catch (e) {
    console.error('[Panel] Failed to send tmux command:', e.message);
  }
}

// ── ANSI escape code stripper ─────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]|\x1b\][^\x07]*\x07|\x1b[()][AB0-9]/g;
function stripAnsi(str) { return str.replace(ANSI_RE, ''); }

function parseLogLine(line) {
  const vm = line.match(/Starting minecraft server version (.+)/i);
  if (vm) { serverVersion = vm[1].trim(); broadcast({ type: 'info', version: serverVersion }); }

  const tpsMatch = line.match(/TPS from last[^:]*:\s*\*?([\d.]+)/i);
  if (tpsMatch) { lastTps = parseFloat(tpsMatch[1]); broadcast({ type: 'stats', tps: lastTps }); }
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
      pushLog(line);
      broadcast({ type: 'log', data: line });
      parseLogLine(line);
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
        let size = 0;
        try { if (e.isFile()) size = (await fsp.stat(full)).size; } catch {}
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
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
    const archive = archiver('zip', { zlib: { level: 6 } });
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
  res.json(loadStartupCfg());
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
});

const wsPing = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(wsPing));

// ── Stats: RAM polling ────────────────────────────────────────────────────────
setInterval(async () => {
  if (!isRunning()) return;

  const pid = getMcPid();
  if (!pid) return;
  mcPid = pid;

  try {
    const statusPath = `/proc/${pid}/status`;
    if (fs.existsSync(statusPath)) {
      const txt      = await fsp.readFile(statusPath, 'utf8');
      const rssMatch = txt.match(/VmRSS:\s+(\d+)\s+kB/);
      if (rssMatch) {
        const ramUsedMB = Math.round(parseInt(rssMatch[1]) / 1024);
        const cfg       = loadStartupCfg();
        const ramMaxMB  = cfg.xmx.endsWith('G') ? parseInt(cfg.xmx) * 1024 : parseInt(cfg.xmx);
        broadcast({ type: 'stats', ramUsed: ramUsedMB, ramMax: ramMaxMB, tps: lastTps });
      }
    }
  } catch {}
}, 5000);

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
  if (logTailer)    { try { logTailer.kill(); } catch {} }
  if (tmuxMonitor)  clearInterval(tmuxMonitor);
  process.exit(0);
}