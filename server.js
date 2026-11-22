// 餐厅扫码点单 — single-file server, no npm dependencies.
// Requires Node.js 22.13+ (uses built-in node:sqlite).
'use strict';
process.removeAllListeners('warning'); // hide the "SQLite is experimental" notice
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = process.env.TZ_NAME || 'Asia/Kuala_Lumpur';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'My Restaurant';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // e.g. https://order.myshop.com
const DEMO = process.env.DEMO === '1';
// A table's dining session ends when staff taps "clear table", or automatically after this many hours without new orders.
const AUTO_CLOSE_HOURS = Number(process.env.AUTO_CLOSE_HOURS || 3);
// This computer's address on the shop Wi-Fi, so phones on the same Wi-Fi can open the QR links.
function lanUrl() {
  const nets = Object.values(require('node:os').networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal);
  const pick = nets.find((n) => /^192\.168\./.test(n.address)) || nets.find((n) => /^(10|172\.(1[6-9]|2\d|3[01]))\./.test(n.address)) || nets[0];
  return pick ? `http://${pick.address}:${PORT}` : '';
}
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- secret for staff login cookies (persisted so restarts keep tablets logged in) ----------
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'restaurant.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT,
  price INTEGER NOT NULL, image TEXT, options TEXT NOT NULL DEFAULT '[]',
  listed INTEGER NOT NULL DEFAULT 1, sold_out INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL, seq INTEGER NOT NULL,
  table_id INTEGER NOT NULL, table_name TEXT NOT NULL, client_id TEXT NOT NULL,
  items TEXT NOT NULL, total INTEGER NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL, done_at INTEGER
);
CREATE TABLE IF NOT EXISTS table_sessions (
  id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL, opened_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_table ON table_sessions(table_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(day);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
`);

if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'session_id')) {
  db.exec('ALTER TABLE orders ADD COLUMN session_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id)');

const newToken = () => crypto.randomBytes(9).toString('base64url'); // 12 chars, unguessable

// First run: load sample menu + tables so the system can be tried immediately.
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  const insCat = db.prepare('INSERT INTO categories (id, name, sort) VALUES (?, ?, ?)');
  const insItem = db.prepare('INSERT INTO items (category_id, name, description, price, image, options, sort, sold_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  seed.categories.forEach((c, i) => {
    insCat.run(i + 1, JSON.stringify(c.name), i);
    c.items.forEach((it, j) => insItem.run(i + 1, JSON.stringify(it.name), JSON.stringify(it.description || {}),
      Math.round(it.price * 100), it.image || null, JSON.stringify(it.options || []), j, it.sold_out ? 1 : 0));
  });
}
if (db.prepare('SELECT COUNT(*) AS n FROM tables').get().n === 0) {
  const ins = db.prepare('INSERT INTO tables (name, token, sort) VALUES (?, ?, ?)');
  for (let i = 1; i <= 10; i++) ins.run(String(i), newToken(), i);
}

// ---------- helpers ----------
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(parseJSON(Buffer.concat(chunks).toString('utf8'), null)));
    req.on('error', reject);
  });
}

// Staff session: signed cookie "staff=<expiry>.<hmac>"
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function staffCookie() {
  const exp = String(Date.now() + 180 * 24 * 3600 * 1000);
  return `staff=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}`;
}
function isStaff(req) {
  const m = /(?:^|;\s*)staff=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

// Very small in-memory rate limiter (per key)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- table dining sessions ----------
// Scanning a table's QR opens (or joins) that table's current session and gives the phone a "seat key".
// The seat key stops working once staff clears the table, so a guest who has left cannot keep ordering
// from the old browser tab or history — they would need to scan the physical QR code again.
const staleBefore = () => Date.now() - AUTO_CLOSE_HOURS * 3600e3;
function openSessionFor(tableId) {
  const cur = db.prepare('SELECT * FROM table_sessions WHERE table_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(tableId);
  if (cur && cur.last_activity >= staleBefore()) {
    db.prepare('UPDATE table_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), cur.id); // a fresh scan = guests still here
    return cur;
  }
  if (cur) db.prepare("UPDATE table_sessions SET closed_at = ?, closed_by = 'auto' WHERE id = ?").run(cur.last_activity + AUTO_CLOSE_HOURS * 3600e3, cur.id);
  const now = Date.now();
  const r = db.prepare('INSERT INTO table_sessions (table_id, opened_at, last_activity) VALUES (?, ?, ?)').run(tableId, now, now);
  return db.prepare('SELECT * FROM table_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
}
const seatKeyFor = (sid) => `${sid}.${sign('seat:' + sid).slice(0, 22)}`;
// Returns the open session + table for a seat key, or null if the key is invalid or the table was cleared.
function seatFromKey(key) {
  const m = /^(\d+)\.([\w-]{22})$/.exec(String(key || ''));
  if (!m || seatKeyFor(m[1]) !== m[0]) return null;
  const sess = db.prepare('SELECT * FROM table_sessions WHERE id = ?').get(Number(m[1]));
  if (!sess || sess.closed_at || sess.last_activity < staleBefore()) return null;
  const table = db.prepare('SELECT id, name FROM tables WHERE id = ? AND active = 1').get(sess.table_id);
  return table ? { sess, table } : null;
}
function closeSession(id, by) { db.prepare('UPDATE table_sessions SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL').run(Date.now(), by, id); }

// ---------- menu ----------
function loadMenu() {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  const items = db.prepare('SELECT * FROM items WHERE listed = 1 ORDER BY sort, id').all();
  return cats.map((c) => ({
    id: c.id, name: parseJSON(c.name, {}),
    items: items.filter((i) => i.category_id === c.id).map((i) => ({
      id: i.id, name: parseJSON(i.name, {}), description: parseJSON(i.description, {}),
      price: i.price, image: i.image, soldOut: !!i.sold_out, options: parseJSON(i.options, []),
    })),
  })).filter((c) => c.items.length);
}

// Validate a cart line against the live menu; returns a snapshot or throws.
function priceLine(line, itemsById) {
  const it = itemsById.get(Number(line.itemId));
  if (!it || !it.listed) throw new Error('ITEM_UNAVAILABLE');
  if (it.sold_out) throw Object.assign(new Error('SOLD_OUT'), { itemName: parseJSON(it.name, {}) });
  const qty = Math.floor(Number(line.qty));
  if (!(qty >= 1 && qty <= 50)) throw new Error('BAD_QTY');
  const groups = parseJSON(it.options, []);
  const chosen = line.options && typeof line.options === 'object' ? line.options : {};
  let unit = it.price; const picked = [];
  for (const g of groups) {
    let ids = chosen[g.id]; ids = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
    ids = [...new Set(ids.map(String))];
    if (g.type === 'single' && ids.length > 1) throw new Error('BAD_OPTION');
    if (g.required && ids.length === 0) throw new Error('OPTION_REQUIRED');
    for (const cid of ids) {
      const ch = g.choices.find((c) => String(c.id) === cid);
      if (!ch) throw new Error('BAD_OPTION');
      unit += Math.round((ch.price || 0) * 100);
      picked.push({ group: g.name, choice: ch.name, price: Math.round((ch.price || 0) * 100) });
    }
  }
  const note = String(line.note || '').trim().slice(0, 120);
  return { itemId: it.id, name: parseJSON(it.name, {}), qty, unit, options: picked, note, takeaway: line.takeaway === true };
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // Customer page: /t/<token>  (the token printed in each table's fixed QR code)
  if (req.method === 'GET' && (/^\/t\/[\w-]{6,40}$/.test(p) || p === '/o')) return serveFile(res, path.join(PUBLIC_DIR, 'order.html'));
  if (req.method === 'GET' && (p === '/staff' || p === '/staff/')) return serveFile(res, path.join(PUBLIC_DIR, 'staff.html'));
  if (req.method === 'GET' && p === '/staff/qr') return serveFile(res, path.join(PUBLIC_DIR, 'qr.html'));
  if (req.method === 'GET' && p === '/') return serveFile(res, path.join(PUBLIC_DIR, 'home.html'));

  // ----- public API -----
  // Called right after a QR scan: open/join the table's session and hand out a seat key.
  if (p === '/api/checkin' && req.method === 'POST') {
    if (limited('c:' + ip, 60, 10 * 60e3)) return send(res, 429, { error: 'TOO_MANY' });
    const body = await readBody(req).catch(() => null);
    const t = db.prepare('SELECT id, name FROM tables WHERE token = ? AND active = 1').get(String(body?.token || ''));
    if (!t) return send(res, 404, { error: 'TABLE_NOT_FOUND' });
    const sess = openSessionFor(t.id);
    return send(res, 200, { seat: seatKeyFor(sess.id), table: t.name });
  }
  if (p === '/api/seat' && req.method === 'GET') {
    const seat = seatFromKey(url.searchParams.get('key'));
    return seat ? send(res, 200, { table: seat.table.name, openedAt: seat.sess.opened_at }) : send(res, 410, { error: 'SEAT_CLOSED' });
  }
  if (p === '/api/config' && req.method === 'GET') return send(res, 200, { name: RESTAURANT_NAME, publicUrl: PUBLIC_URL, lanUrl: lanUrl(), demo: DEMO });
  if (DEMO && req.method === 'GET' && p === '/demo') return serveFile(res, path.join(PUBLIC_DIR, 'demo.html'));
  if (DEMO && req.method === 'GET' && p === '/api/demo') {
    return send(res, 200, { tables: db.prepare('SELECT name, token FROM tables WHERE active = 1 ORDER BY sort, id').all(), pin: STAFF_PIN });
  }
  if (p === '/api/menu' && req.method === 'GET') return send(res, 200, { categories: loadMenu() });

  if (p === '/api/orders' && req.method === 'POST') {
    if (limited('o:' + ip, 20, 10 * 60e3)) return send(res, 429, { error: 'TOO_MANY' });
    let body; try { body = await readBody(req); } catch { return send(res, 413, { error: 'TOO_LARGE' }); }
    if (!body || !Array.isArray(body.lines) || !body.lines.length || body.lines.length > 60) return send(res, 400, { error: 'EMPTY' });
    const clientId = String(body.clientId || '');
    if (!/^[\w-]{10,64}$/.test(clientId)) return send(res, 400, { error: 'BAD_CLIENT' });
    const seat = seatFromKey(body.seat);
    if (!seat) return send(res, 410, { error: 'SEAT_CLOSED' });
    const { table, sess } = seat;
    const itemsById = new Map(db.prepare('SELECT * FROM items').all().map((i) => [i.id, i]));
    let lines;
    try { lines = body.lines.map((l) => priceLine(l, itemsById)); }
    catch (e) { return send(res, 409, { error: e.message, itemName: e.itemName }); }
    const total = lines.reduce((s, l) => s + l.unit * l.qty, 0);
    const now = Date.now(); const day = dayOf(now);
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM orders WHERE day = ?').get(day).n;
    const r = db.prepare('INSERT INTO orders (day, seq, table_id, table_name, client_id, items, total, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(day, seq, table.id, table.name, clientId, JSON.stringify(lines), total, now, sess.id);
    db.prepare('UPDATE table_sessions SET last_activity = ? WHERE id = ?').run(now, sess.id);
    return send(res, 201, { id: Number(r.lastInsertRowid), seq, total, createdAt: now });
  }

  // Orders of the current dining session at this table only — previous guests' orders are never shown.
  // "mine" marks the ones placed from this phone.
  if (p === '/api/seat-orders' && req.method === 'GET') {
    const seat = seatFromKey(url.searchParams.get('key'));
    if (!seat) return send(res, 410, { error: 'SEAT_CLOSED' });
    const clientId = url.searchParams.get('clientId') || '';
    const rows = db.prepare('SELECT id, seq, table_name, client_id, items, total, status, created_at FROM orders WHERE session_id = ? ORDER BY id DESC').all(seat.sess.id);
    return send(res, 200, { table: seat.table.name, orders: rows.map((o) => ({ id: o.id, seq: o.seq, table: o.table_name, mine: o.client_id === clientId,
      lines: parseJSON(o.items, []), total: o.total, status: o.status, createdAt: o.created_at })) });
  }

  // ----- staff API -----
  if (p === '/api/staff/login' && req.method === 'POST') {
    if (limited('l:' + ip, 10, 10 * 60e3)) return send(res, 429, { error: 'TOO_MANY' });
    const body = await readBody(req).catch(() => null);
    const pin = String(body?.pin || '');
    const ok = pin.length === STAFF_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(STAFF_PIN));
    return ok ? send(res, 200, { ok: true }, { 'Set-Cookie': staffCookie() }) : send(res, 401, { error: 'BAD_PIN' });
  }
  if (p.startsWith('/api/staff/')) {
    if (!isStaff(req)) return send(res, 401, { error: 'LOGIN' });
    const mapOrder = (o) => ({ id: o.id, seq: o.seq, day: o.day, tableId: o.table_id, table: o.table_name, lines: parseJSON(o.items, []),
      total: o.total, status: o.status, createdAt: o.created_at, doneAt: o.done_at });

    if (p === '/api/staff/orders' && req.method === 'GET') {
      const rows = db.prepare("SELECT * FROM orders WHERE status = 'new' ORDER BY id").all();
      return send(res, 200, { orders: rows.map(mapOrder), now: Date.now() });
    }
    if (p === '/api/staff/history' && req.method === 'GET') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : dayOf(Date.now());
      const rows = db.prepare('SELECT * FROM orders WHERE day = ? ORDER BY id DESC').all(day);
      return send(res, 200, { day, orders: rows.map(mapOrder) });
    }
    let m;
    if ((m = /^\/api\/staff\/orders\/(\d+)\/(done|undo|void)$/.exec(p)) && req.method === 'POST') {
      const status = { done: 'done', undo: 'new', void: 'void' }[m[2]];
      db.prepare('UPDATE orders SET status = ?, done_at = ? WHERE id = ?').run(status, status === 'new' ? null : Date.now(), Number(m[1]));
      return send(res, 200, { ok: true });
    }
    // Table overview for the "tables" tab: who is dining, since when, how much ordered.
    if (p === '/api/staff/table-status' && req.method === 'GET') {
      const tables = db.prepare('SELECT id, name FROM tables WHERE active = 1 ORDER BY sort, id').all();
      const out = tables.map((t) => {
        const s = db.prepare('SELECT * FROM table_sessions WHERE table_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(t.id);
        if (!s || s.last_activity < staleBefore()) return { id: t.id, name: t.name, session: null };
        const orders = db.prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY id').all(s.id).map(mapOrder);
        const live = orders.filter((o) => o.status !== 'void');
        return { id: t.id, name: t.name, session: { id: s.id, openedAt: s.opened_at, lastActivity: s.last_activity,
          orders, total: live.reduce((a, o) => a + o.total, 0), pending: orders.filter((o) => o.status === 'new').length } };
      });
      return send(res, 200, { tables: out, now: Date.now(), autoCloseHours: AUTO_CLOSE_HOURS });
    }
    if ((m = /^\/api\/staff\/sessions\/(\d+)\/clear$/.exec(p)) && req.method === 'POST') {
      closeSession(Number(m[1]), 'staff');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/staff/tables' && req.method === 'GET') {
      return send(res, 200, { tables: db.prepare('SELECT id, name, token, active FROM tables ORDER BY sort, id').all() });
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  }

  // ----- static -----
  if (req.method === 'GET') {
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    return serveFile(res, file, p.startsWith('/uploads/') || p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache');
  }
  send(res, 404, 'Not found');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'SERVER' }); });
}).listen(PORT, () => {
  console.log(`Ordering server on http://localhost:${PORT}  (staff: /staff, QR codes: /staff/qr)`);
  if (lanUrl()) console.log(`Phones on the same Wi-Fi: ${lanUrl()}`);
  if (STAFF_PIN === '1234' && !DEMO) console.log('WARNING: using default staff PIN 1234 — set STAFF_PIN in production.');
});
