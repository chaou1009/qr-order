// 餐厅扫码点单 — single-file server, no npm dependencies.
// Requires Node.js 22.13+ (uses built-in node:sqlite).
'use strict';
process.removeAllListeners('warning'); // hide the "SQLite is experimental" notice
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const ADMIN_PIN = process.env.ADMIN_PIN || STAFF_PIN; // back office (menu, prices, tables, theme)
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = process.env.TZ_NAME || 'Asia/Kuala_Lumpur';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'My Restaurant';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // e.g. https://order.myshop.com
const DEMO = process.env.DEMO === '1';
// A table's dining session ends when staff taps "clear table", or automatically after this many hours without new orders.
const AUTO_CLOSE_HOURS = Number(process.env.AUTO_CLOSE_HOURS || 1);
// This computer's address on the shop Wi-Fi, so phones on the same Wi-Fi can open the QR links.
function lanUrl() {
  const nets = Object.values(require('node:os').networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal);
  const pick = nets.find((n) => /^192\.168\./.test(n.address)) || nets.find((n) => /^(10|172\.(1[6-9]|2\d|3[01]))\./.test(n.address)) || nets[0];
  return pick ? `http://${pick.address}:${PORT}` : '';
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads'); // dish photos live with the data so backups include them
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'cook_minutes')) {
  db.exec('ALTER TABLE items ADD COLUMN cook_minutes INTEGER NOT NULL DEFAULT 15'); // usual time until served
}
for (const [col, def] of [['sold_out_day', 'TEXT'], ['stock', 'INTEGER'], ['featured', 'INTEGER NOT NULL DEFAULT 0'], ['featured_day', 'TEXT'], ['featured_days', 'TEXT'], ['auto_special', 'INTEGER NOT NULL DEFAULT 1'], ['days', 'TEXT'], ['option_groups', "TEXT NOT NULL DEFAULT '[]'"], ['stock_pool', 'TEXT'], ['discount', 'INTEGER NOT NULL DEFAULT 0'], ['discount_until', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${def}`);
}
db.exec(`
-- Dishes sitting in a guest's cart (not yet ordered) for items with limited stock, so others see "N in other carts".
CREATE TABLE IF NOT EXISTS holds (
  client_id TEXT NOT NULL, item_id INTEGER NOT NULL, qty INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, item_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, table_id INTEGER NOT NULL, table_name TEXT NOT NULL,
  type TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL, handled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_open ON service_requests(handled_at);
-- Shared option groups (e.g. "Ice level", "Spiciness") that many dishes or drinks can use; edit once, all update.
CREATE TABLE IF NOT EXISTS option_templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'single', required INTEGER NOT NULL DEFAULT 0,
  choices TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0
);
-- Ingredients with a limited count for the day (chicken legs, a sauce...). Many dishes can draw from one ingredient,
-- and one dish can draw from several; stock NULL = not counted.
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, stock INTEGER, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS item_ingredients (
  item_id INTEGER NOT NULL, ing_id INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, ing_id)
);
CREATE INDEX IF NOT EXISTS idx_item_ing ON item_ingredients(ing_id);
`);
for (const [col, def] of [['daily', 'INTEGER'], ['reset_day', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(ingredients)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE ingredients ADD COLUMN ${col} ${def}`);
}
// Older databases: turn each "shared portions" group into an ingredient of the same name.
for (const r of db.prepare("SELECT stock_pool AS k, MIN(stock) AS stock FROM items WHERE stock_pool IS NOT NULL GROUP BY stock_pool").all()) {
  const ing = db.prepare('INSERT INTO ingredients (name, stock, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM ingredients))').run(r.k, r.stock);
  for (const it of db.prepare('SELECT id FROM items WHERE stock_pool = ?').all(r.k)) {
    db.prepare('INSERT OR IGNORE INTO item_ingredients (item_id, ing_id, qty) VALUES (?, ?, 1)').run(it.id, Number(ing.lastInsertRowid));
    db.prepare('UPDATE items SET stock = NULL, stock_pool = NULL WHERE id = ?').run(it.id);
  }
}
const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? parseJSON(r.value, d) : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
// Kitchen busy level set on the tablet: 0 normal, 1 busy, 2 very busy -> extra minutes added to every dish's usual time.
const BUSY_EXTRA = { 0: 0, 1: 10, 2: 20 };
const busyInfo = () => { const level = Number(getSetting('busy_level', 0)) || 0; return { level, extra: BUSY_EXTRA[level] || 0 }; };

const newToken = () => crypto.randomBytes(9).toString('base64url'); // 12 chars, unguessable

// First run: load sample menu + tables so the system can be tried immediately.
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  const insCat = db.prepare('INSERT INTO categories (id, name, sort) VALUES (?, ?, ?)');
  const insItem = db.prepare('INSERT INTO items (category_id, name, description, price, image, options, sort, sold_out, cook_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  seed.categories.forEach((c, i) => {
    insCat.run(i + 1, JSON.stringify(c.name), i);
    c.items.forEach((it, j) => insItem.run(i + 1, JSON.stringify(it.name), JSON.stringify(it.description || {}),
      Math.round(it.price * 100), it.image || null, JSON.stringify(it.options || []), j, it.sold_out ? 1 : 0, it.cook_minutes || 15));
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
function staffCookie(role = 'staff') {
  const exp = String(Date.now() + 180 * 24 * 3600 * 1000);
  return `${role}=${exp}.${sign(role + exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}`;
}
function hasCookie(req, role) {
  const m = new RegExp(`(?:^|;\\s*)${role}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(role + exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
// Staff can also manage the menu unless a separate ADMIN_PIN is set.
const isAdmin = (req) => hasCookie(req, 'admin') || (ADMIN_PIN === STAFF_PIN && hasCookie(req, 'staff'));
const isStaff = (req) => hasCookie(req, 'staff') || isAdmin(req);
const pinOk = (pin, want) => pin.length === want.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(want));

// Very small in-memory rate limiter (per key)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// Latest food reminder per dish line in a session: { "orderId:line": { at, handled } }
const REMIND_COOLDOWN = 3 * 60e3;
function remindersFor(sessionId) {
  const out = {};
  for (const r of db.prepare("SELECT detail, created_at, handled_at FROM service_requests WHERE session_id = ? AND type = 'remind' ORDER BY id").all(sessionId)) {
    for (const i of parseJSON(r.detail, {}).items || []) if (i.line != null) out[`${i.orderId}:${i.line}`] = { at: r.created_at, handled: !!r.handled_at };
  }
  return out;
}

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

// ---------- menu, sold out, limited stock ----------
const today = () => dayOf(Date.now());
// Sold out = marked "until further notice", or "today only" for today's date, or limited stock used up.
const isSoldOut = (it) => !!it.sold_out || it.sold_out_day === today() || (stockOf(it) ?? 1) <= 0;
const HOLD_MS = 5 * 60e3; // a cart reservation lasts 5 minutes after the guest's phone last checked in
// What a dish needs: [{ id, name, stock, per }] for each ingredient it uses.
const ingOf = (itemId) => db.prepare('SELECT g.id, g.name, g.stock, MAX(1, ii.qty) AS per FROM item_ingredients ii JOIN ingredients g ON g.id = ii.ing_id WHERE ii.item_id = ? ORDER BY g.sort, g.id').all(itemId);
// How much of an ingredient other guests are holding in their carts right now.
function ingHeldByOthers(ingId, clientId) {
  return db.prepare('SELECT COALESCE(SUM(h.qty * MAX(1, ii.qty)), 0) AS n FROM holds h JOIN item_ingredients ii ON ii.item_id = h.item_id WHERE ii.ing_id = ? AND h.client_id != ? AND h.expires_at > ?')
    .get(ingId, clientId || '', Date.now()).n;
}
function heldByOthers(itemId, clientId) { return db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM holds WHERE item_id = ? AND client_id != ? AND expires_at > ?').get(itemId, clientId || '', Date.now()).n; }
function heldBySelf(itemId, clientId) { return db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM holds WHERE item_id = ? AND client_id = ?').get(itemId, clientId).n; }
// How much of an ingredient this guest's own cart uses for its other dishes (e.g. curry for a second curry dish).
function ingHeldBySelfOther(ingId, clientId, itemId) {
  return db.prepare('SELECT COALESCE(SUM(h.qty * MAX(1, ii.qty)), 0) AS n FROM holds h JOIN item_ingredients ii ON ii.item_id = h.item_id WHERE ii.ing_id = ? AND h.client_id = ? AND h.item_id != ? AND h.expires_at > ?')
    .get(ingId, clientId, itemId, Date.now()).n;
}
// Portions of a dish left: its own limit and every ingredient it needs, whichever runs out first. null = no limit.
// clientId undefined = count what sits in carts as still available; ownOther = also count this guest's other dishes
// that use the same ingredients (not this dish itself: the phone subtracts its own cart for that).
function portionsLeft(it, clientId, ownOther = false) {
  let n = it.stock == null ? null : Math.max(0, it.stock - (clientId === undefined ? 0 : heldByOthers(it.id, clientId)));
  for (const g of ingOf(it.id)) {
    if (g.stock == null) continue;
    const used = clientId === undefined ? 0 : ingHeldByOthers(g.id, clientId) + (ownOther ? ingHeldBySelfOther(g.id, clientId, it.id) : 0);
    const k = Math.floor(Math.max(0, g.stock - used) / g.per);
    n = n == null ? k : Math.min(n, k);
  }
  return n;
}
const stockOf = (it) => portionsLeft(it, undefined);
// One guest's view of a dish: portions left in total, how many of those sit in other guests' carts (held),
// and how many this guest's own cart already uses through other dishes sharing an ingredient (mine).
function stockView(it, clientId) {
  const total = stockOf(it); if (total == null) return { stock: null, held: 0, mine: 0 };
  const others = portionsLeft(it, clientId) ?? total, withMine = portionsLeft(it, clientId, true) ?? others;
  return { stock: total, held: Math.max(0, total - others), mine: Math.max(0, others - withMine) };
}
// An ingredient count is for the day it was typed in: from the next day (shop time zone) it goes back to no limit.
function dailyReset() {
  const d = today();
  if (dailyReset.day === d) return; dailyReset.day = d;
  db.prepare('UPDATE ingredients SET reset_day = ? WHERE reset_day IS NULL').run(d); // counts typed before this rule last until tonight
  db.prepare('UPDATE ingredients SET stock = NULL WHERE stock IS NOT NULL AND reset_day != ?').run(d);
}
// take portions off a dish's own limit and off every ingredient it uses (negative delta), or give them back
function changeStock(itemId, delta) {
  db.prepare('UPDATE items SET stock = MAX(0, stock + ?) WHERE stock IS NOT NULL AND id = ?').run(delta, itemId);
  for (const g of ingOf(itemId)) db.prepare('UPDATE ingredients SET stock = MAX(0, stock + ?) WHERE stock IS NOT NULL AND id = ?').run(delta * g.per, g.id);
}
const setStock = (itemId, st) => db.prepare('UPDATE items SET stock = ? WHERE id = ?').run(st, itemId);
// Live availability of limited / sold-out dishes for one guest: { itemId: { soldOut, stock, held } }
// Carts are per phone AND per table: one browser open on two tables counts as two guests.
const holderOf = (clientId, seat) => seat ? `${clientId}@${seat.sess.id}` : clientId;
function availability(clientId) {
  const out = {};
  for (const it of db.prepare('SELECT id, sold_out, sold_out_day, stock FROM items WHERE listed = 1').all()) {
    const v = stockView(it, clientId);
    if (v.stock == null && !isSoldOut(it)) continue;
    out[it.id] = { soldOut: isSoldOut(it), ...v };
  }
  return out;
}
// Weekday in the shop's time zone (0 = Sunday). Dishes with set days only appear on those days.
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const weekday = () => DOW[new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date())];
const onToday = (it) => { const d = parseJSON(it.days, null); return !Array.isArray(d) || !d.length || d.includes(weekday()); };
// Today's special: always (until removed), today only (ends at midnight), or on fixed weekdays.
const hasDays = (it) => { const d = parseJSON(it.days, null); return Array.isArray(d) && d.length > 0; };
// Dishes sold only on certain weekdays become a special automatically on those days, unless staff turned that off.
const autoSpecial = (it) => !!it.auto_special && hasDays(it) && onToday(it);
const specialNow = (it) => !!it.featured || it.featured_day === today() || (parseJSON(it.featured_days, []) || []).includes(weekday()) || autoSpecial(it);
function specialInfo(it) {
  const days = parseJSON(it.featured_days, []) || [];
  const mode = it.featured ? 'always' : days.length ? 'weekly' : it.featured_day === today() ? 'today' : 'none';
  return { mode, days, active: specialNow(it), auto: !!it.auto_special, autoActive: autoSpecial(it) };
}
function specialCols(sp) {
  const mode = ['always', 'today', 'weekly'].includes(sp?.mode) ? sp.mode : 'none';
  const days = [...new Set((Array.isArray(sp?.days) ? sp.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  if (mode === 'weekly' && !days.length) return [0, null, null];
  return [mode === 'always' ? 1 : 0, mode === 'today' ? today() : null, mode === 'weekly' ? JSON.stringify(days) : null];
}
const templates = () => new Map(db.prepare('SELECT * FROM option_templates ORDER BY sort, id').all().map((t) => [t.id, t]));
const tplGroup = (t) => ({ id: 't' + t.id, name: parseJSON(t.name, {}), type: t.type, required: !!t.required, choices: parseJSON(t.choices, []), shared: true });
// A dish's option groups: the shared ones it uses first, then its own.
// Discount in percent (0 = none). discount_until = last day it applies (KL date), empty = until removed.
const discountOf = (i) => (i.discount > 0 && (!i.discount_until || i.discount_until >= today()) ? i.discount : 0);
function itemOptions(it, tpl = templates()) {
  const shared = parseJSON(it.option_groups, []).map((id) => tpl.get(Number(id))).filter(Boolean).map(tplGroup).filter((g) => g.choices.length);
  return [...shared, ...parseJSON(it.options, [])];
}
function loadMenu(clientId) {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  const hideSold = getSetting('hideSoldOut', false) === true;
  const items = db.prepare('SELECT * FROM items WHERE listed = 1 ORDER BY sort, id').all().filter((i) => onToday(i) && !(hideSold && isSoldOut(i)));
  const tpl = templates();
  return cats.map((c) => ({
    id: c.id, name: parseJSON(c.name, {}),
    items: items.filter((i) => i.category_id === c.id).map((i) => ({
      id: i.id, name: parseJSON(i.name, {}), description: parseJSON(i.description, {}),
      price: i.price, image: i.image, soldOut: isSoldOut(i), options: itemOptions(i, tpl), cookMinutes: i.cook_minutes || 15,
      featured: specialNow(i), days: parseJSON(i.days, null), discount: discountOf(i), ...stockView(i, clientId),
    })),
  })).filter((c) => c.items.length);
}

// Validate a cart line against the live menu; returns a snapshot or throws.
function priceLine(line, itemsById) {
  const it = itemsById.get(Number(line.itemId));
  if (!it || !it.listed || !onToday(it)) throw new Error('ITEM_UNAVAILABLE');
  if (isSoldOut(it)) throw Object.assign(new Error('SOLD_OUT'), { itemName: parseJSON(it.name, {}) });
  const qty = Math.floor(Number(line.qty));
  if (!(qty >= 1 && qty <= 50)) throw new Error('BAD_QTY');
  const groups = itemOptions(it);
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
  const disc = discountOf(it), full = unit;
  if (disc) unit = Math.round(full * (100 - disc) / 1000) * 10; // nearest 10 sen
  return { itemId: it.id, name: parseJSON(it.name, {}), qty, unit, ...(disc ? { discount: disc, full } : {}), options: picked, note, takeaway: line.takeaway === true, cookMinutes: it.cook_minutes || 15 };
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
  if (p.startsWith('/api/')) dailyReset();

  // Customer page: /t/<token>  (the token printed in each table's fixed QR code)
  if (req.method === 'GET' && (/^\/t\/[\w-]{6,40}$/.test(p) || p === '/o')) return serveFile(res, path.join(PUBLIC_DIR, 'order.html'));
  if (req.method === 'GET' && (p === '/staff' || p === '/staff/')) return serveFile(res, path.join(PUBLIC_DIR, 'staff.html'));
  if (req.method === 'GET' && p === '/staff/qr') return serveFile(res, path.join(PUBLIC_DIR, 'qr.html'));
  if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  if (req.method === 'GET' && /^\/uploads\/[\w-]+\.(jpg|png|webp)$/.test(p)) {
    const f = path.join(UPLOAD_DIR, path.basename(p));
    return fs.existsSync(f) ? serveFile(res, f, 'public, max-age=31536000, immutable') : serveFile(res, path.join(PUBLIC_DIR, p));
  }
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
    if (!seat) return send(res, 410, { error: 'SEAT_CLOSED' });
    const clientId = url.searchParams.get('clientId') || '';
    const c = db.prepare("SELECT COALESCE(SUM(status != 'void'), 0) AS n, COALESCE(SUM(client_id = ? AND status != 'void'), 0) AS mine, COUNT(*) AS all_n FROM orders WHERE session_id = ?").get(clientId, seat.sess.id);
    return send(res, 200, { table: seat.table.name, openedAt: seat.sess.opened_at, busy: busyInfo(), now: Date.now(), ...themeInfo(),
      orderCount: c.n, mineCount: c.mine, allCount: c.all_n, avail: availability(holderOf(clientId, seat)) });
  }
  // The guest's cart for limited dishes: reserve those portions for a few minutes so other guests see them as taken.
  if (p === '/api/holds' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    const seat = seatFromKey(body?.seat);
    const rawId = String(body?.clientId || '');
    if (!seat || !/^[\w-]{10,64}$/.test(rawId)) return send(res, 410, { error: 'SEAT_CLOSED' });
    const clientId = holderOf(rawId, seat);
    const want = new Map();
    for (const h of Array.isArray(body.holds) ? body.holds.slice(0, 60) : []) want.set(Number(h.itemId), (want.get(Number(h.itemId)) || 0) + Math.max(0, Math.floor(Number(h.qty) || 0)));
    db.prepare('DELETE FROM holds WHERE client_id = ? OR expires_at < ?').run(clientId, Date.now());
    const granted = {};
    for (const [itemId, qty] of want) {
      const it = db.prepare('SELECT id, stock FROM items WHERE id = ?').get(itemId);
      if (!it || !qty) continue;
      const left = portionsLeft(it, clientId, true); if (left == null) continue; // counts this cart's other dishes already reserved above
      const g = Math.min(qty, Math.max(0, left - heldBySelf(itemId, clientId)));
      granted[itemId] = g;
      if (g) db.prepare('INSERT INTO holds (client_id, item_id, qty, expires_at) VALUES (?, ?, ?, ?)').run(clientId, itemId, g, Date.now() + HOLD_MS);
    }
    return send(res, 200, { granted, avail: availability(clientId) });
  }
  // Guest asks for help: "call" (reason) or "remind" (dishes that have not arrived yet).
  if (p === '/api/service' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    const seat = seatFromKey(body?.seat);
    if (!seat) return send(res, 410, { error: 'SEAT_CLOSED' });
    const type = body.type === 'remind' ? 'remind' : 'call';
    if (limited(`s:${seat.sess.id}:${type}`, 3, 2 * 60e3)) return send(res, 429, { error: 'TOO_MANY' });
    let detail;
    if (type === 'call') {
      const reason = String(body.reason || 'other');
      if (!['water', 'cutlery', 'sauce', 'other'].includes(reason)) return send(res, 400, { error: 'BAD_REASON' });
      detail = { reason };
    } else {
      const want = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
      const items = []; const recent = remindersFor(seat.sess.id);
      for (const w of want) {
        const o = db.prepare("SELECT id, seq, items, created_at FROM orders WHERE id = ? AND session_id = ? AND status != 'void'").get(Number(w.orderId), seat.sess.id);
        const l = o && parseJSON(o.items, [])[Number(w.line)];
        const last = recent[`${Number(w.orderId)}:${Number(w.line)}`];
        if (last && Date.now() - last.at < REMIND_COOLDOWN) continue; // same dish reminded less than 3 minutes ago
        if (l) items.push({ orderId: o.id, line: Number(w.line), seq: o.seq, name: l.name, qty: l.qty, takeaway: !!l.takeaway, orderedAt: o.created_at });
      }
      if (!items.length && want.length) return send(res, 429, { error: 'COOLDOWN' });
      if (!items.length) return send(res, 400, { error: 'NO_ITEMS' });
      detail = { items };
    }
    db.prepare('INSERT INTO service_requests (session_id, table_id, table_name, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(seat.sess.id, seat.table.id, seat.table.name, type, JSON.stringify(detail), Date.now());
    return send(res, 201, { ok: true });
  }
  if (p === '/api/config' && req.method === 'GET') return send(res, 200, { ...shopInfo(), publicUrl: PUBLIC_URL, lanUrl: lanUrl(), demo: DEMO, ...themeInfo() });
  if (DEMO && req.method === 'GET' && p === '/demo') return serveFile(res, path.join(PUBLIC_DIR, 'demo.html'));
  if (DEMO && req.method === 'GET' && p === '/api/demo') {
    return send(res, 200, { tables: db.prepare('SELECT name, token FROM tables WHERE active = 1 ORDER BY sort, id').all(), pin: STAFF_PIN, adminPin: ADMIN_PIN });
  }
  if (p === '/api/menu' && req.method === 'GET') { const k = url.searchParams.get('key'); return send(res, 200, { categories: loadMenu(holderOf(url.searchParams.get('clientId') || '', k ? seatFromKey(k) : null)) }); }

  if (p === '/api/orders' && req.method === 'POST') {
    if (limited('o:' + ip, 20, 10 * 60e3)) return send(res, 429, { error: 'TOO_MANY' });
    let body; try { body = await readBody(req); } catch { return send(res, 413, { error: 'TOO_LARGE' }); }
    if (!body || !Array.isArray(body.lines) || !body.lines.length || body.lines.length > 60) return send(res, 400, { error: 'EMPTY' });
    const clientId = String(body.clientId || '');
    if (!/^[\w-]{10,64}$/.test(clientId)) return send(res, 400, { error: 'BAD_CLIENT' });
    const seat = seatFromKey(body.seat);
    if (!seat) return send(res, 410, { error: 'SEAT_CLOSED' });
    const { table, sess } = seat; const holder = holderOf(clientId, seat);
    const itemsById = new Map(db.prepare('SELECT * FROM items').all().map((i) => [i.id, i]));
    let lines;
    try { lines = body.lines.map((l) => priceLine(l, itemsById)); }
    catch (e) { return send(res, 409, { error: e.message, itemName: e.itemName }); }
    // Limited dishes: this order may use what is left minus what other guests currently hold in their carts.
    const perItem = new Map(); lines.forEach((l) => perItem.set(l.itemId, (perItem.get(l.itemId) || 0) + l.qty));
    // Own limits first, then the shared ingredients: dishes using the same ingredient are counted together.
    const needIng = new Map();
    for (const [itemId, qty] of perItem) {
      const it = itemsById.get(itemId);
      if (it.stock != null) { const left = Math.max(0, it.stock - heldByOthers(itemId, holder));
        if (qty > left) return send(res, 409, { error: 'STOCK', itemName: parseJSON(it.name, {}), left }); }
      for (const g of ingOf(itemId)) if (g.stock != null) { const e = needIng.get(g.id) || { need: 0, g, itemId, per: g.per }; e.need += qty * g.per; needIng.set(g.id, e); }
    }
    for (const [ingId, e] of needIng) {
      const left = Math.max(0, e.g.stock - ingHeldByOthers(ingId, holder));
      if (e.need > left) return send(res, 409, { error: 'STOCK', itemName: parseJSON(itemsById.get(e.itemId).name, {}), left: Math.floor(left / e.per) });
    }
    for (const [itemId, qty] of perItem) changeStock(itemId, -qty);
    db.prepare('DELETE FROM holds WHERE client_id = ?').run(holder);
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
      lines: parseJSON(o.items, []), total: o.total, status: o.status, createdAt: o.created_at })), reminders: remindersFor(seat.sess.id), cooldownMs: REMIND_COOLDOWN, now: Date.now() });
  }

  // ----- staff API -----
  if (p === '/api/staff/login' && req.method === 'POST') {
    if (limited('l:' + ip, 10, 10 * 60e3)) return send(res, 429, { error: 'TOO_MANY' });
    const body = await readBody(req).catch(() => null);
    const pin = String(body?.pin || '');
    if (body?.role === 'admin') return pinOk(pin, ADMIN_PIN) ? send(res, 200, { ok: true }, { 'Set-Cookie': staffCookie('admin') }) : send(res, 401, { error: 'BAD_PIN' });
    return pinOk(pin, STAFF_PIN) || pinOk(pin, ADMIN_PIN) ? send(res, 200, { ok: true }, { 'Set-Cookie': staffCookie() }) : send(res, 401, { error: 'BAD_PIN' });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'LOGIN' });
    return adminApi(req, res, p, url);
  }
  if (p.startsWith('/api/staff/')) {
    if (!isStaff(req)) return send(res, 401, { error: 'LOGIN' });
    let m;
    const mapOrder = (o) => ({ id: o.id, seq: o.seq, day: o.day, tableId: o.table_id, table: o.table_name, lines: parseJSON(o.items, []),
      total: o.total, status: o.status, createdAt: o.created_at, doneAt: o.done_at });

    if (p === '/api/staff/orders' && req.method === 'GET') {
      const rows = db.prepare("SELECT * FROM orders WHERE status = 'new' ORDER BY id").all();
      const requests = db.prepare('SELECT * FROM service_requests WHERE handled_at IS NULL ORDER BY id').all()
        .map((r) => ({ id: r.id, table: r.table_name, type: r.type, detail: parseJSON(r.detail, {}), createdAt: r.created_at }));
      return send(res, 200, { orders: rows.map(mapOrder), requests, busy: busyInfo(), now: Date.now() });
    }
    if ((m = /^\/api\/staff\/requests\/(\d+)\/done$/.exec(p)) && req.method === 'POST') {
      db.prepare('UPDATE service_requests SET handled_at = ? WHERE id = ?').run(Date.now(), Number(m[1]));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/staff/busy' && req.method === 'POST') {
      const body = await readBody(req).catch(() => null);
      const level = Number(body?.level);
      if (![0, 1, 2].includes(level)) return send(res, 400, { error: 'BAD_LEVEL' });
      setSetting('busy_level', level);
      return send(res, 200, { busy: busyInfo() });
    }
    if (p === '/api/staff/history' && req.method === 'GET') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : dayOf(Date.now());
      const rows = db.prepare('SELECT * FROM orders WHERE day = ? ORDER BY id DESC').all(day);
      return send(res, 200, { day, orders: rows.map(mapOrder) });
    }
    if ((m = /^\/api\/staff\/orders\/(\d+)\/(done|undo|void)$/.exec(p)) && req.method === 'POST') {
      const status = { done: 'done', undo: 'new', void: 'void' }[m[2]];
      const prev = db.prepare('SELECT status, items FROM orders WHERE id = ?').get(Number(m[1]));
      if (prev && (prev.status === 'void') !== (status === 'void')) { // voiding gives limited portions back; restoring takes them again
        const sign = status === 'void' ? 1 : -1;
        for (const l of parseJSON(prev.items, [])) changeStock(l.itemId, sign * l.qty);
      }
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

// ---------- back office (admin) API ----------
const shopInfo = () => ({ name: getSetting('shopName', '') || RESTAURANT_NAME, logo: getSetting('logo', '') || null, hideSoldOut: getSetting('hideSoldOut', false) === true, showPrepTime: getSetting('showPrepTime', false) === true });
function themeInfo() {
  const theme = getSetting('theme', 'default');
  return { theme, banner: getSetting('banner:' + theme, '') || null, effects: getSetting('effects', true) !== false };
}
const THEMES = ['default', 'cny', 'merdeka', 'raya', 'deepavali', 'gawai', 'christmas'];
const clean3 = (o, max = 80) => { const r = {}; for (const k of ['en', 'ms', 'zh']) { const v = String(o?.[k] ?? '').trim().slice(0, max); if (v) r[k] = v; } return r; };
const toSen = (rm) => { const n = Math.round(Number(rm) * 100); return Number.isFinite(n) && n >= 0 && n <= 1e7 ? n : null; };
const slug = () => crypto.randomBytes(4).toString('hex');
// Option groups as edited in the back office -> safe stored shape (ids kept stable so old carts still match).
function cleanOptions(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, 12).map((g) => ({
    id: /^[\w-]{1,24}$/.test(g?.id || '') ? g.id : slug(), name: clean3(g?.name), type: g?.type === 'multi' ? 'multi' : 'single', required: !!g?.required,
    choices: (Array.isArray(g?.choices) ? g.choices : []).slice(0, 20).map((c) => ({
      id: /^[\w-]{1,24}$/.test(c?.id || '') ? c.id : slug(), name: clean3(c?.name), ...(Number(c?.price) > 0 ? { price: Math.round(Number(c.price) * 100) / 100 } : {}),
    })).filter((c) => Object.keys(c.name).length),
  })).filter((g) => Object.keys(g.name).length && g.choices.length);
}
const adminItem = (i) => ({ id: i.id, categoryId: i.category_id, name: parseJSON(i.name, {}), description: parseJSON(i.description, {}), price: i.price,
  image: i.image, options: parseJSON(i.options, []), listed: !!i.listed, soldOut: i.sold_out ? 'until' : i.sold_out_day === today() ? 'today' : 'none',
  stock: i.stock, cookMinutes: i.cook_minutes || 15, discount: i.discount || 0, discountUntil: i.discount_until || null, discountActive: discountOf(i) > 0, sort: i.sort, special: specialInfo(i), days: parseJSON(i.days, []) || [], optionGroups: parseJSON(i.option_groups, []),
  ingredients: db.prepare('SELECT ing_id AS id, MAX(1, qty) AS qty FROM item_ingredients WHERE item_id = ?').all(i.id), portions: stockOf(i), held: heldByOthers(i.id, '') });

async function adminApi(req, res, p, url) {
  const body = req.method === 'GET' ? null : await readBody(req, 6 * 1024 * 1024).catch(() => null);
  let m;
  if (p === '/api/admin/menu' && req.method === 'GET') {
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
    const items = db.prepare('SELECT * FROM items ORDER BY sort, id').all();
    return send(res, 200, { hideSoldOut: getSetting('hideSoldOut', false) === true, showPrepTime: getSetting('showPrepTime', false) === true, categories: cats.map((c) => ({ id: c.id, name: parseJSON(c.name, {}), items: items.filter((i) => i.category_id === c.id).map(adminItem) })) });
  }
  // categories
  if (p === '/api/admin/categories' && req.method === 'POST') {
    const name = clean3(body?.name); if (!Object.keys(name).length) return send(res, 400, { error: 'NAME' });
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories').get().n;
    const r = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)').run(JSON.stringify(name), sort);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if ((m = /^\/api\/admin\/categories\/(\d+)$/.exec(p))) {
    const id = Number(m[1]);
    if (req.method === 'PUT') { const name = clean3(body?.name); if (!Object.keys(name).length) return send(res, 400, { error: 'NAME' });
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(JSON.stringify(name), id); return send(res, 200, { ok: true }); }
    if (req.method === 'DELETE') {
      if (db.prepare('SELECT COUNT(*) AS n FROM items WHERE category_id = ?').get(id).n) return send(res, 409, { error: 'NOT_EMPTY' });
      db.prepare('DELETE FROM categories WHERE id = ?').run(id); return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/admin/categories/order' && req.method === 'POST') {
    (body?.ids || []).forEach((id, i) => db.prepare('UPDATE categories SET sort = ? WHERE id = ?').run(i, Number(id)));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/items/order' && req.method === 'POST') {
    (body?.ids || []).forEach((id, i) => db.prepare('UPDATE items SET sort = ? WHERE id = ?').run(i, Number(id)));
    return send(res, 200, { ok: true });
  }
  // dishes: create / full update
  if ((p === '/api/admin/items' && req.method === 'POST') || ((m = /^\/api\/admin\/items\/(\d+)$/.exec(p)) && req.method === 'PUT')) {
    const name = clean3(body?.name), price = toSen(body?.price), cat = Number(body?.categoryId);
    if (!Object.keys(name).length) return send(res, 400, { error: 'NAME' });
    if (price == null) return send(res, 400, { error: 'PRICE' });
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(cat)) return send(res, 400, { error: 'CATEGORY' });
    const image = /^\/uploads\/[\w-]+\.(jpg|png|webp)$/.test(body?.image || '') ? body.image : null;
    const cook = Math.min(240, Math.max(1, Math.round(Number(body?.cookMinutes) || 15)));
    const days = [...new Set((Array.isArray(body?.days) ? body.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    const tpl = templates(); const groupsUsed = [...new Set((Array.isArray(body?.optionGroups) ? body.optionGroups : []).map(Number).filter((id) => tpl.has(id)))];
    const vals = [cat, JSON.stringify(name), JSON.stringify(clean3(body?.description, 300)), price, image, JSON.stringify(cleanOptions(body?.options)), body?.listed === false ? 0 : 1, cook,
      ...specialCols(body?.special), body?.special?.auto === false ? 0 : 1, days.length && days.length < 7 ? JSON.stringify(days) : null, JSON.stringify(groupsUsed)];
    // Ingredients this dish draws from: [{ id, qty }] (qty = portions used per dish). Only set when the field is sent.
    const setIngredients = (id) => {
      if (!Array.isArray(body?.ingredients)) return;
      db.prepare('DELETE FROM item_ingredients WHERE item_id = ?').run(id);
      const seen = new Set();
      for (const row of body.ingredients) {
        const gid = Number(row?.id); if (!gid || seen.has(gid) || !db.prepare('SELECT id FROM ingredients WHERE id = ?').get(gid)) continue;
        seen.add(gid); db.prepare('INSERT INTO item_ingredients (item_id, ing_id, qty) VALUES (?, ?, ?)').run(id, gid, Math.max(1, Math.min(99, Math.floor(Number(row?.qty) || 1))));
      }
    };
    const setDiscount = (id) => {
      if (!('discount' in (body || {}))) return;
      const d = Math.max(0, Math.min(90, Math.round(Number(body.discount) || 0)));
      const until = d && /^\d{4}-\d{2}-\d{2}$/.test(body.discountUntil || '') ? body.discountUntil : null;
      db.prepare('UPDATE items SET discount = ?, discount_until = ? WHERE id = ?').run(d, until, id);
    };
    if (m) { db.prepare('UPDATE items SET category_id = ?, name = ?, description = ?, price = ?, image = ?, options = ?, listed = ?, cook_minutes = ?, featured = ?, featured_day = ?, featured_days = ?, auto_special = ?, days = ?, option_groups = ? WHERE id = ?').run(...vals, Number(m[1])); setIngredients(Number(m[1])); setDiscount(Number(m[1])); return send(res, 200, { id: Number(m[1]) }); }
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM items WHERE category_id = ?').get(cat).n;
    const r = db.prepare('INSERT INTO items (category_id, name, description, price, image, options, listed, cook_minutes, featured, featured_day, featured_days, auto_special, days, option_groups, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, sort);
    setIngredients(Number(r.lastInsertRowid)); setDiscount(Number(r.lastInsertRowid));
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if ((m = /^\/api\/admin\/items\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
    db.prepare('DELETE FROM items WHERE id = ?').run(Number(m[1])); db.prepare('DELETE FROM holds WHERE item_id = ?').run(Number(m[1])); db.prepare('DELETE FROM item_ingredients WHERE item_id = ?').run(Number(m[1]));
    return send(res, 200, { ok: true });
  }
  // ingredients with a shared daily count: list / create / rename / set count / delete
  if (p === '/api/admin/ingredients' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM ingredients ORDER BY sort, id').all();
    const used = {}; for (const r of db.prepare('SELECT ing_id, COUNT(*) AS n FROM item_ingredients GROUP BY ing_id').all()) used[r.ing_id] = r.n;
    return send(res, 200, { ingredients: rows.map((g) => ({ id: g.id, name: g.name, stock: g.stock, daily: g.daily, usedBy: used[g.id] || 0, held: ingHeldByOthers(g.id, '') })) });
  }
  if ((p === '/api/admin/ingredients' && req.method === 'POST') || ((m = /^\/api\/admin\/ingredients\/(\d+)$/.exec(p)) && req.method === 'PUT')) {
    const num = (v) => v === null || v === '' || v === undefined ? null : Math.max(0, Math.min(99999, Math.floor(Number(v) || 0)));
    const fields = {}; if ('name' in body) { const n = String(body.name || '').trim().slice(0, 40); if (!n) return send(res, 400, { error: 'NAME' }); fields.name = n; }
    if ('stock' in body) fields.stock = num(body.stock);
    if ('stock' in body) fields.reset_day = today(); // the count lasts until midnight
    if (m) { const id = Number(m[1]); const keys = Object.keys(fields); if (keys.length) db.prepare(`UPDATE ingredients SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id); return send(res, 200, { id }); }
    if (!fields.name) return send(res, 400, { error: 'NAME' });
    const r = db.prepare('INSERT INTO ingredients (name, stock, daily, reset_day, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM ingredients))').run(fields.name, fields.stock ?? null, null, today());
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if ((m = /^\/api\/admin\/ingredients\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
    const id = Number(m[1]); db.prepare('DELETE FROM ingredients WHERE id = ?').run(id); db.prepare('DELETE FROM item_ingredients WHERE ing_id = ?').run(id);
    return send(res, 200, { ok: true });
  }
  // set, in one go, which dishes draw from an ingredient
  if ((m = /^\/api\/admin\/ingredients\/(\d+)\/items$/.exec(p)) && req.method === 'POST') {
    const id = Number(m[1]); if (!db.prepare('SELECT id FROM ingredients WHERE id = ?').get(id)) return send(res, 404, { error: 'NOT_FOUND' });
    const want = new Set((Array.isArray(body?.itemIds) ? body.itemIds : []).map(Number)); let changed = 0;
    for (const i of db.prepare('SELECT id FROM items').all()) {
      const has = !!db.prepare('SELECT 1 FROM item_ingredients WHERE item_id = ? AND ing_id = ?').get(i.id, id), should = want.has(i.id);
      if (has && !should) { db.prepare('DELETE FROM item_ingredients WHERE item_id = ? AND ing_id = ?').run(i.id, id); changed++; }
      else if (!has && should) { db.prepare('INSERT INTO item_ingredients (item_id, ing_id, qty) VALUES (?, ?, 1)').run(i.id, id); changed++; }
    }
    return send(res, 200, { changed });
  }
  // quick changes from the list: listed, sold out mode, remaining portions, price
  if ((m = /^\/api\/admin\/items\/(\d+)\/quick$/.exec(p)) && req.method === 'POST') {
    const id = Number(m[1]);
    if (!db.prepare('SELECT id FROM items WHERE id = ?').get(id)) return send(res, 404, { error: 'NOT_FOUND' });
    if ('listed' in body) db.prepare('UPDATE items SET listed = ? WHERE id = ?').run(body.listed ? 1 : 0, id);
    if ('special' in body) {
      if (body.special.mode !== undefined) db.prepare('UPDATE items SET featured = ?, featured_day = ?, featured_days = ? WHERE id = ?').run(...specialCols(body.special), id);
      if ('auto' in body.special) db.prepare('UPDATE items SET auto_special = ? WHERE id = ?').run(body.special.auto ? 1 : 0, id);
    }
    if ('soldOut' in body) {
      const mode = body.soldOut;
      db.prepare('UPDATE items SET sold_out = ?, sold_out_day = ? WHERE id = ?').run(mode === 'until' ? 1 : 0, mode === 'today' ? today() : null, id);
      if (mode === 'none' && db.prepare('SELECT stock FROM items WHERE id = ?').get(id).stock <= 0) setStock(id, null); // back on sale: drop an empty limit
    }
    if ('stock' in body) {
      const st = body.stock === null || body.stock === '' ? null : Math.max(0, Math.min(9999, Math.floor(Number(body.stock))));
      if (st !== null && !Number.isFinite(st)) return send(res, 400, { error: 'STOCK' });
      setStock(id, st);
    }
    if ('price' in body) { const pr = toSen(body.price); if (pr == null) return send(res, 400, { error: 'PRICE' }); db.prepare('UPDATE items SET price = ? WHERE id = ?').run(pr, id); }
    return send(res, 200, { item: adminItem(db.prepare('SELECT * FROM items WHERE id = ?').get(id)) });
  }
  if (p === '/api/admin/menu-settings' && req.method === 'POST') { if ('hideSoldOut' in body) setSetting('hideSoldOut', !!body.hideSoldOut); if ('showPrepTime' in body) setSetting('showPrepTime', !!body.showPrepTime); return send(res, 200, { hideSoldOut: getSetting('hideSoldOut', false) === true, showPrepTime: getSetting('showPrepTime', false) === true }); }
  // shared option groups
  if (p === '/api/admin/option-templates' && req.method === 'GET') {
    const used = {}; for (const i of db.prepare('SELECT option_groups FROM items').all()) for (const id of parseJSON(i.option_groups, [])) used[id] = (used[id] || 0) + 1;
    return send(res, 200, { templates: [...templates().values()].map((t) => ({ ...tplGroup(t), id: t.id, usedBy: used[t.id] || 0 })) });
  }
  if ((p === '/api/admin/option-templates' && req.method === 'POST') || ((m = /^\/api\/admin\/option-templates\/(\d+)$/.exec(p)) && req.method === 'PUT')) {
    const [g] = cleanOptions([{ ...body, id: 'x' }]);
    if (!g) return send(res, 400, { error: 'NAME' });
    const vals = [JSON.stringify(g.name), g.type, g.required ? 1 : 0, JSON.stringify(g.choices)];
    if (m) { db.prepare('UPDATE option_templates SET name = ?, type = ?, required = ?, choices = ? WHERE id = ?').run(...vals, Number(m[1])); return send(res, 200, { id: Number(m[1]) }); }
    const r = db.prepare('INSERT INTO option_templates (name, type, required, choices, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM option_templates))').run(...vals);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  // set, in one go, which dishes use a shared option group
  if ((m = /^\/api\/admin\/option-templates\/(\d+)\/items$/.exec(p)) && req.method === 'POST') {
    const id = Number(m[1]); if (!templates().has(id)) return send(res, 404, { error: 'NOT_FOUND' });
    const want = new Set((Array.isArray(body?.itemIds) ? body.itemIds : []).map(Number)); let changed = 0;
    const upd = db.prepare('UPDATE items SET option_groups = ? WHERE id = ?');
    for (const i of db.prepare('SELECT id, option_groups FROM items').all()) {
      const g = parseJSON(i.option_groups, []) || [], has = g.includes(id), should = want.has(i.id);
      if (has !== should) { upd.run(JSON.stringify(should ? [...g, id] : g.filter((x) => x !== id)), i.id); changed++; }
    }
    return send(res, 200, { changed });
  }
  if ((m = /^\/api\/admin\/option-templates\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
    const id = Number(m[1]); db.prepare('DELETE FROM option_templates WHERE id = ?').run(id);
    for (const i of db.prepare('SELECT id, option_groups FROM items').all()) { const g = parseJSON(i.option_groups, []); if (g.includes(id)) db.prepare('UPDATE items SET option_groups = ? WHERE id = ?').run(JSON.stringify(g.filter((x) => x !== id)), i.id); }
    return send(res, 200, { ok: true });
  }
  // photo upload: the browser already resized it; we just store the bytes
  if (p === '/api/admin/upload' && req.method === 'POST') {
    const mm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.dataUrl || ''));
    if (!mm) return send(res, 400, { error: 'IMAGE' });
    const buf = Buffer.from(mm[2], 'base64'); if (buf.length > 4 * 1024 * 1024) return send(res, 413, { error: 'TOO_LARGE' });
    const name = `${Date.now().toString(36)}-${slug()}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return send(res, 201, { url: '/uploads/' + name });
  }
  // tables
  if (p === '/api/admin/tables' && req.method === 'GET') return send(res, 200, { tables: db.prepare('SELECT id, name, token, active FROM tables ORDER BY sort, id').all() });
  if (p === '/api/admin/tables' && req.method === 'POST') {
    const name = String(body?.name || '').trim().slice(0, 20); if (!name) return send(res, 400, { error: 'NAME' });
    if (db.prepare('SELECT id FROM tables WHERE name = ?').get(name)) return send(res, 409, { error: 'EXISTS' });
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM tables').get().n;
    db.prepare('INSERT INTO tables (name, token, sort) VALUES (?, ?, ?)').run(name, newToken(), sort);
    return send(res, 201, { ok: true });
  }
  if ((m = /^\/api\/admin\/tables\/(\d+)$/.exec(p)) && req.method === 'PUT') {
    const id = Number(m[1]);
    if ('name' in body) { const name = String(body.name || '').trim().slice(0, 20); if (!name) return send(res, 400, { error: 'NAME' });
      if (db.prepare('SELECT id FROM tables WHERE name = ? AND id != ?').get(name, id)) return send(res, 409, { error: 'EXISTS' });
      db.prepare('UPDATE tables SET name = ? WHERE id = ?').run(name, id); }
    if ('active' in body) db.prepare('UPDATE tables SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
    return send(res, 200, { ok: true });
  }
  if ((m = /^\/api\/admin\/tables\/(\d+)\/regen$/.exec(p)) && req.method === 'POST') {
    const id = Number(m[1]);
    db.prepare('UPDATE tables SET token = ? WHERE id = ?').run(newToken(), id);
    db.prepare('SELECT id FROM table_sessions WHERE table_id = ? AND closed_at IS NULL').all(id).forEach((s) => closeSession(s.id, 'regen')); // old QR stops working
    return send(res, 200, { ok: true });
  }
  // manual backup: a zip with data/restaurant.db and data/uploads, ready to copy back over the data folder
  if (p === '/api/admin/backup' && req.method === 'GET') {
    const zip = backupZip(), name = `qr-order-backup-${dayOf(Date.now())}.zip`;
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.end(zip);
  }
  // before opening day: remove test orders, calls and table visits; menu, tables and settings stay
  if (p === '/api/admin/clear-orders' && req.method === 'POST') {
    if (body?.confirm !== 'CLEAR') return send(res, 400, { error: 'CONFIRM' });
    const n = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    db.exec('DELETE FROM orders; DELETE FROM service_requests; DELETE FROM holds; DELETE FROM table_sessions;');
    return send(res, 200, { cleared: n });
  }
  // shop name and logo (logo = transparent PNG with the shop name, shown on the guest menu and QR cards)
  if (p === '/api/admin/shop') {
    if (req.method === 'POST') {
      if ('name' in body) { const n = String(body.name || '').trim().slice(0, 60); setSetting('shopName', n); }
      if ('logo' in body) { const u = body.logo; if (u !== null && !/^\/uploads\/[\w-]+\.(jpg|png|webp)$/.test(u || '')) return send(res, 400, { error: 'IMAGE' }); setSetting('logo', u || ''); }
    }
    return send(res, 200, { ...shopInfo(), defaultName: RESTAURANT_NAME });
  }
  // festival theme for the guest page
  if (p === '/api/admin/theme') {
    if (req.method === 'POST') {
      if ('theme' in body) { if (!THEMES.includes(body.theme)) return send(res, 400, { error: 'THEME' }); setSetting('theme', body.theme); }
      if ('effects' in body) setSetting('effects', !!body.effects);
      if (body.banner) { // custom banner picture for one theme (null = back to the built-in banner)
        if (!THEMES.includes(body.banner.theme)) return send(res, 400, { error: 'THEME' });
        const u = body.banner.url; if (u !== null && !/^\/uploads\/[\w-]+\.(jpg|png|webp)$/.test(u || '')) return send(res, 400, { error: 'IMAGE' });
        setSetting('banner:' + body.banner.theme, u || '');
      }
    }
    return send(res, 200, { ...themeInfo(), themes: THEMES, banners: Object.fromEntries(THEMES.map((t) => [t, getSetting('banner:' + t, '') || null])) });
  }
  return send(res, 404, { error: 'NOT_FOUND' });
}

// A minimal zip writer (no extra packages): deflated files with UTF-8 names.
function makeZip(files) {
  const parts = [], central = []; let off = 0;
  const dt = new Date(), dosTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1), dosDate = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = zlib.deflateRawSync(f.data), crc = zlib.crc32(f.data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, data); central.push(c, name); off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
function backupZip() {
  const tmp = path.join(DATA_DIR, `backup-${process.pid}.tmp`);
  try { fs.unlinkSync(tmp); } catch {}
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const files = [{ name: 'data/restaurant.db', data: fs.readFileSync(tmp) }]; fs.unlinkSync(tmp);
  for (const n of fs.readdirSync(UPLOAD_DIR)) { const f = path.join(UPLOAD_DIR, n); if (fs.statSync(f).isFile()) files.push({ name: 'data/uploads/' + n, data: fs.readFileSync(f) }); }
  return makeZip(files);
}

// Daily backup: BACKUP_DIR (e.g. a Google Drive / OneDrive folder) gets one folder per day with the
// database and dish photos; folders older than BACKUP_KEEP_DAYS (default 30) are removed.
const BACKUP_DIR = process.env.BACKUP_DIR || '';
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 30);
function backupNow() {
  if (!BACKUP_DIR) return;
  try {
    const day = dayOf(Date.now()), dest = path.join(BACKUP_DIR, 'qr-order-' + day);
    if (fs.existsSync(path.join(dest, 'restaurant.db'))) return; // already done today
    fs.mkdirSync(dest, { recursive: true });
    const tmp = path.join(dest, 'restaurant.db.part');
    try { fs.unlinkSync(tmp); } catch {}
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // consistent copy while the shop is running
    fs.renameSync(tmp, path.join(dest, 'restaurant.db'));
    fs.cpSync(UPLOAD_DIR, path.join(dest, 'uploads'), { recursive: true });
    const old = fs.readdirSync(BACKUP_DIR).filter((n) => /^qr-order-\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) fs.rmSync(path.join(BACKUP_DIR, n), { recursive: true, force: true });
    console.log('Backup saved to ' + dest);
  } catch (e) { console.error('Backup failed:', e.message); }
}
if (BACKUP_DIR) { setTimeout(backupNow, 60e3).unref(); setInterval(backupNow, 3600e3).unref(); }

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'SERVER' }); });
}).listen(PORT, () => {
  console.log(`Ordering server on http://localhost:${PORT}  (staff: /staff, QR codes: /staff/qr)`);
  if (lanUrl()) console.log(`Phones on the same Wi-Fi: ${lanUrl()}`);
  console.log(`Back office: http://localhost:${PORT}/admin`);
  if (STAFF_PIN === '1234' && !DEMO) console.log('WARNING: using default staff PIN 1234 — set STAFF_PIN in production.');
});
