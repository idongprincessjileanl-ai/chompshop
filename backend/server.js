// Chomp Shop API - works with the ChompCart database (SQL files 01 to 10)
// Security: login (JWT), role permissions, rate limiting, RLS in MySQL, audit + error logs.
// .env lives next to this file (backend/.env), so it is found whatever folder you start from
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch { /* dotenv is optional */ }

const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const fraudAI = require('./ai/fraud');

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

// ===================== LOGGING =====================
// One JSON line per event, to the console and to logs/app-YYYY-MM-DD.log (kept 14 days)

const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });

function log(level, msg, extra = {}) {
  const entry = { time: new Date().toISOString(), level, msg, pid: process.pid, ...extra };
  const line = JSON.stringify(entry);
  (level === 'error' ? console.error : console.log)(line);
  fs.appendFile(path.join(logDir, `app-${entry.time.slice(0, 10)}.log`), line + '\n', () => {});
}

function cleanOldLogs() {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(logDir)) {
    const file = path.join(logDir, f);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* ignore */ }
  }
}
cleanOldLogs();

// ===================== DATABASE =====================
// Two accounts (least privilege). If the restricted ones are not set in .env, the main account is used.

const baseDb = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME || 'chompcart',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  decimalNumbers: true, // DECIMAL columns come back as numbers, not strings
  dateStrings: true,    // dates come back as readable text
};
const mainUser = { user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };

// Staff, riders, admin and the system itself
const staffPool = mysql.createPool({
  ...baseDb,
  user: process.env.DB_STAFF_USER || mainUser.user,
  password: process.env.DB_STAFF_USER ? process.env.DB_STAFF_PASSWORD || '' : mainUser.password,
});
// Visitors and customers: this account can only read the rls_* views
const customerPool = mysql.createPool({
  ...baseDb,
  user: process.env.DB_CUSTOMER_USER || mainUser.user,
  password: process.env.DB_CUSTOMER_USER ? process.env.DB_CUSTOMER_PASSWORD || '' : mainUser.password,
});

const STAFF_ROLES = ['Admin', 'Inventory Staff'];

// Run a query as the logged-in user: MySQL learns who it is (@app_user_id / @app_role),
// so the RLS views and triggers can enforce the policies.
async function q(req, sql, params = []) {
  const user = req.user || null;
  const pool = user && user.role !== 'Customer' ? staffPool : customerPool;
  const conn = await pool.getConnection();
  try {
    await conn.query('SET @app_user_id = ?, @app_role = ?', [user ? user.id : null, user ? user.role : null]);
    return await conn.query(sql, params);
  } finally {
    try { await conn.query('SET @app_user_id = NULL, @app_role = NULL'); } catch { /* connection will be dropped */ }
    conn.release();
  }
}

// System work that is not tied to a visitor (login, logs)
const sys = (sql, params = []) => staffPool.query(sql, params);

// ===================== APP SETUP =====================

const app = express();
app.disable('x-powered-by');
// Behind a load balancer (nginx): trust the first proxy so rate limits use the real visitor IP
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0)); // set TRUST_PROXY=1 behind nginx

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  ...(IS_PROD ? {} : { hsts: false }),
}));

// Request ID + access log
app.use((req, res, next) => {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api')) return; // skip static files
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'request', {
      reqId: req.id, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode,
      ms: Number(process.hrtime.bigint() - start) / 1e6, user: req.user?.id ?? null, ip: req.ip,
    });
  });
  next();
});

app.use(express.json({ limit: '100kb' }));
// Website files are in ../frontend/public; uploaded photos are in backend/uploads (served at /uploads)
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '..', 'frontend', 'public');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use(express.static(FRONTEND_DIR, { maxAge: IS_PROD ? '1h' : 0 }));
app.use('/uploads', express.static(UPLOAD_ROOT, { maxAge: IS_PROD ? '1h' : 0 }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// ===================== RATE LIMITING =====================

const limiter = (windowMinutes, limit, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: message },
});

app.use('/api', limiter(1, Number(process.env.RATE_LIMIT_PER_MIN) || 300, 'Too many requests. Please slow down.'));
const loginLimiter    = limiter(15, 10, 'Too many login attempts. Try again in 15 minutes.');
const registerLimiter = limiter(60, 5, 'Too many sign-ups from this network. Try again later.');
const checkoutLimiter = limiter(1, 10, 'Too many orders in a short time. Please wait a minute.');
const feedbackLimiter = limiter(60, 30, 'Too many reviews. Try again later.');
const uploadLimiter   = limiter(10, 30, 'Too many uploads. Try again later.');

// ===================== AUTH (login + permissions) =====================

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) throw new Error('JWT_SECRET must be set in production');
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  log('warn', 'JWT_SECRET is not set: using a temporary one (everyone is logged out when the server restarts)');
}
const TOKEN_HOURS = Number(process.env.TOKEN_HOURS) || 8;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'chomp123';
const PLACEHOLDER_HASH = '$2b$10$REPLACE%';

// Reads "Authorization: Bearer <token>" on every request (optional login)
app.use((req, res, next) => {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(header.slice(7), JWT_SECRET);
      req.user = { id: p.uid, role: p.role, name: p.name, driverId: p.driverId || null };
    } catch {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'TOKEN_EXPIRED' });
    }
  }
  next();
});

const requireLogin = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Please log in first.', code: 'LOGIN_REQUIRED' });

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.', code: 'LOGIN_REQUIRED' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to do this.' });
  next();
};
const staffOnly = requireRole(...STAFF_ROLES);
const adminOnly = requireRole('Admin');

function audit(req, action, entity = null, entityId = null, details = null) {
  sys(`INSERT INTO audit_log (user_id, role_name, action, entity, entity_id, details, ip_address, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [req.user?.id ?? null, req.user?.role ?? null, action, entity, entityId == null ? null : String(entityId),
    details ? JSON.stringify(details) : null, req.ip, req.id])
    .catch((err) => log('error', 'audit write failed', { err: err.message }));
}

function issueToken(u) {
  const payload = { uid: u.user_id, role: u.role_name, name: `${u.first_name} ${u.last_name}`, driverId: u.driver_id || null };
  return {
    token: jwt.sign(payload, JWT_SECRET, { expiresIn: `${TOKEN_HOURS}h` }),
    user: { id: u.user_id, name: payload.name, email: u.email, role: u.role_name, driver_id: payload.driverId },
  };
}

// ===================== CAPTCHA (self-hosted "type the blurry word", no external service) =====================
// The answer word is kept ONLY on the server (in captchaChallenges, keyed by jti). The client gets
// an opaque signed token (jti inside, no answer) plus an image URL. The word is revealed solely as
// rendered pixels in a distorted/blurry SVG served as an image, so it never appears in page source or JSON.
const captchaUsed = new Map();        // jti -> expiry ms (blocks reuse of a solved token)
const captchaChallenges = new Map();  // jti -> { word, exp }
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of captchaUsed) if (exp < now) captchaUsed.delete(k);
  for (const [k, v] of captchaChallenges) if (v.exp < now) captchaChallenges.delete(k);
}, 60 * 1000).unref?.();

const CAPTCHA_MINUTES = 5;

// Short, friendly, easy-to-read words (ambiguous shapes avoided). Answer is case-insensitive.
const CAPTCHA_WORDS = [
  'apple', 'bread', 'chair', 'cloud', 'dance', 'eagle', 'frost', 'grape', 'house', 'juice',
  'lemon', 'mango', 'music', 'ocean', 'piano', 'plant', 'river', 'robot', 'salad', 'smile',
  'snack', 'stone', 'sugar', 'table', 'tiger', 'toast', 'train', 'water', 'zebra', 'bloom',
  'candy', 'chomp', 'cheese', 'coffee', 'donut', 'dragon', 'flower', 'garden', 'guitar', 'orange',
  'pepper', 'planet', 'rocket', 'silver', 'summer', 'tomato', 'wonder', 'yellow'
];

const CAPTCHA_COLORS = ['#1e2a4a', '#2b3a67', '#3a2d5c', '#1f4536', '#5c2b2b', '#2c2c54', '#334155'];
function rnd(min, max) { return min + Math.random() * (max - min); }

// Build a distorted, slightly blurry SVG of the word. Letters are individually rotated, nudged and
// colored; faint curved noise lines and dots sit on top; a gaussian blur + turbulence displacement
// keep it machine-unfriendly while staying human-readable.
function captchaSvg(word) {
  const W = 230, H = 80;
  const letters = word.toUpperCase().split('');
  const step = (W - 40) / letters.length;
  let glyphs = '';
  letters.forEach((ch, i) => {
    const x = 24 + i * step + rnd(-4, 4);
    const y = H / 2 + rnd(-6, 6);
    const rot = rnd(-20, 20);
    const size = rnd(30, 40);
    const color = CAPTCHA_COLORS[Math.floor(Math.random() * CAPTCHA_COLORS.length)];
    glyphs += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Georgia,'Times New Roman',serif" font-weight="700" font-size="${size.toFixed(1)}" fill="${color}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" dominant-baseline="middle" text-anchor="middle">${ch}</text>`;
  });
  let lines = '';
  for (let i = 0; i < 3; i++) {
    const y1 = rnd(10, H - 10), y2 = rnd(10, H - 10), cy = rnd(0, H);
    const color = CAPTCHA_COLORS[Math.floor(Math.random() * CAPTCHA_COLORS.length)];
    lines += `<path d="M0 ${y1.toFixed(1)} Q ${(W / 2).toFixed(1)} ${cy.toFixed(1)} ${W} ${y2.toFixed(1)}" stroke="${color}" stroke-width="${rnd(1, 2).toFixed(1)}" fill="none" opacity="0.4"/>`;
  }
  let dots = '';
  for (let i = 0; i < 40; i++) {
    dots += `<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" r="${rnd(0.5, 1.6).toFixed(1)}" fill="#334155" opacity="0.35"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="CAPTCHA image">
<defs>
  <filter id="d"><feTurbulence type="fractalNoise" baseFrequency="0.018 0.03" numOctaves="2" seed="${Math.floor(rnd(0, 9999))}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G"/></filter>
  <filter id="b"><feGaussianBlur stdDeviation="0.9"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="#f4f5f8"/>
<g filter="url(#b)"><g filter="url(#d)">${glyphs}${lines}</g></g>
${dots}
</svg>`;
}

// GET a fresh challenge: stores the word server-side, returns an opaque token + the image URL.
app.get('/api/captcha', wrap(async (req, res) => {
  const word = CAPTCHA_WORDS[crypto.randomInt(0, CAPTCHA_WORDS.length)];
  const jti = crypto.randomUUID();
  captchaChallenges.set(jti, { word, exp: Date.now() + CAPTCHA_MINUTES * 60 * 1000 });
  const token = jwt.sign({ jti, scope: 'captcha' }, JWT_SECRET, { expiresIn: `${CAPTCHA_MINUTES}m` });
  res.json({ token, image: `/api/captcha/image/${jti}` });
}));

// Serve the distorted word as an image (never cached). The answer lives only in these pixels.
app.get('/api/captcha/image/:jti', wrap(async (req, res) => {
  const ch = captchaChallenges.get(req.params.jti);
  res.set('Cache-Control', 'no-store, max-age=0');
  res.type('image/svg+xml');
  if (!ch || ch.exp < Date.now()) return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="230" height="80"><rect width="230" height="80" fill="#f4f5f8"/><text x="115" y="46" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#64748b">expired — tap ↻</text></svg>');
  res.send(captchaSvg(ch.word));
}));

// Returns true only for a valid, unexpired, unused token whose typed word matches. Case-insensitive.
function verifyCaptcha(req) {
  const token = req.body?.captcha_token;
  const given = String(req.body?.captcha_answer || '').trim().toLowerCase();
  if (!token || !given) return false;
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { return false; }
  if (p.scope !== 'captcha' || !p.jti) return false;
  if (captchaUsed.has(p.jti)) return false;           // reused token
  const ch = captchaChallenges.get(p.jti);
  if (!ch || ch.exp < Date.now()) return false;       // unknown/expired challenge
  if (given !== ch.word.toLowerCase()) return false;  // wrong word
  captchaUsed.set(p.jti, (p.exp || 0) * 1000 || Date.now() + CAPTCHA_MINUTES * 60 * 1000);
  captchaChallenges.delete(p.jti);                    // one-time use
  return true;
}

// Log in with email + password. 5 wrong passwords lock the account for 15 minutes.
app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!verifyCaptcha(req)) return res.status(400).json({ error: 'Please answer the CAPTCHA correctly.', code: 'CAPTCHA_FAILED' });
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  const [rows] = await sys(
    `SELECT u.user_id, u.first_name, u.last_name, u.email, u.password_hash, u.is_active,
            u.failed_logins, u.locked_until, u.locked_until > NOW() AS is_locked, r.role_name, d.driver_id
     FROM users u
     JOIN roles r ON r.role_id = u.role_id
     LEFT JOIN drivers d ON d.user_id = u.user_id
     WHERE u.email = ?`, [email]);
  const u = rows[0];

  if (u && u.is_locked) {
    return res.status(423).json({ error: 'Too many wrong passwords. This account is locked for 15 minutes.' });
  }
  // Compare even when the email is unknown, so response time does not reveal which emails exist
  const ok = await bcrypt.compare(password, u ? u.password_hash : '$2a$10$abcdefghijklmnopqrstuuMG1bJzWbqjvUW0wT0D6CzA7pc1aSU7m');
  if (!u || !ok || !u.is_active) {
    if (u) {
      await sys(`UPDATE users SET failed_logins = failed_logins + 1,
                   locked_until = IF(failed_logins + 1 >= 5, NOW() + INTERVAL 15 MINUTE, locked_until)
                 WHERE user_id = ?`, [u.user_id]);
    }
    req.user = u ? { id: u.user_id, role: u.role_name } : null;
    audit(req, 'login_failed', 'user', u?.user_id ?? null, { email });
    return res.status(401).json({ error: u && !u.is_active ? 'This account is disabled.' : 'Wrong email or password.' });
  }

  await sys('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE user_id = ?', [u.user_id]);
  const result = issueToken(u);
  req.user = { id: u.user_id, role: u.role_name };
  audit(req, 'login', 'user', u.user_id);
  res.json(result);
}));

// ---- Registration input validation (reject blank / junk / wrong-format values) ----
const NAME_RE  = /^[A-Za-zÀ-ɏñÑ][A-Za-zÀ-ɏñÑ .'-]*$/; // letters, spaces, . ' -
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// true if the text is one character repeated (e.g. "aaaa", "1111") or has no letters
const isJunkText = (s) => !/[A-Za-z]/.test(s) || /^(.)\1*$/.test(s.replace(/\s/g, ''));

// Keep only digits; a leading +63 becomes 0. Returns '' if it is not a PH mobile number.
function normalisePHMobile(raw) {
  let d = String(raw || '').replace(/[\s()-]/g, '');
  if (d.startsWith('+63')) d = '0' + d.slice(3);
  else if (d.startsWith('63') && d.length === 12) d = '0' + d.slice(2);
  d = d.replace(/\D/g, '');
  return /^09\d{9}$/.test(d) ? d : '';
}

function validateRegistration(data, password) {
  const missing = ['first_name', 'last_name', 'email', 'phone', 'street', 'barangay', 'city'].filter((k) => !data[k]);
  if (missing.length) return 'Please fill in: ' + missing.join(', ').replace(/_/g, ' ') + '.';

  for (const [field, label] of [['first_name', 'First name'], ['last_name', 'Last name']]) {
    const v = data[field];
    if (v.length < 2 || !NAME_RE.test(v) || /^(.)\1*$/.test(v.replace(/\s/g, '')))
      return label + ' must be a real name (letters only, at least 2 characters).';
  }

  if (!EMAIL_RE.test(data.email) || data.email.length > 100 || data.email.includes('..'))
    return 'Enter a valid email address, for example juan@gmail.com.';

  if (!normalisePHMobile(data.phone))
    return 'Enter a valid Philippine mobile number, for example 0917 123 4567.';

  if (data.street.length < 5 || isJunkText(data.street)) return 'Enter your complete street / house address.';
  if (data.barangay.length < 2 || isJunkText(data.barangay)) return 'Enter a valid barangay.';
  if (data.city.length < 2 || isJunkText(data.city)) return 'Enter a valid city or municipality.';
  if (data.postal_code && !/^\d{4}$/.test(data.postal_code)) return 'Postal code must be 4 digits.';

  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must include both a letter and a number.';
  return null;
}

// Create a customer account with a delivery address
app.post('/api/auth/register', registerLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const data = {
    first_name: clean(b.first_name, 50), last_name: clean(b.last_name, 50),
    email: clean(b.email, 100).toLowerCase(), phone: clean(b.phone, 20),
    street: clean(b.street, 150), barangay: clean(b.barangay, 100), city: clean(b.city, 100),
    province: clean(b.province, 100) || 'Metro Manila', postal_code: clean(b.postal_code, 10),
  };
  const password = String(b.password || '');

  if (!verifyCaptcha(req)) return res.status(400).json({ error: 'Please answer the CAPTCHA correctly.', code: 'CAPTCHA_FAILED' });

  const vError = validateRegistration(data, password);
  if (vError) return res.status(400).json({ error: vError });

  // Normalise the phone to 11 digits (09XXXXXXXXX) before saving
  data.phone = normalisePHMobile(data.phone);

  const hash = await bcrypt.hash(password, 10);
  const conn = await staffPool.getConnection();
  let userId;
  try {
    await conn.beginTransaction();
    const [u] = await conn.query(
      'INSERT INTO users (role_id, first_name, last_name, email, password_hash, phone) VALUES (3, ?, ?, ?, ?, ?)',
      [data.first_name, data.last_name, data.email, hash, data.phone || null]);
    userId = u.insertId;
    await conn.query(
      `INSERT INTO customer_addresses (user_id, label, street, barangay, city, province, postal_code, is_default)
       VALUES (?, 'Home', ?, ?, ?, ?, ?, TRUE)`,
      [userId, data.street, data.barangay, data.city, data.province, data.postal_code || null]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This email already has an account. Please log in.' });
    throw err;
  } finally {
    conn.release();
  }

  const result = issueToken({ user_id: userId, first_name: data.first_name, last_name: data.last_name, email: data.email, role_name: 'Customer' });
  req.user = { id: userId, role: 'Customer' };
  audit(req, 'register', 'user', userId);
  res.status(201).json(result);
}));

// Who am I? (checks that the saved login is still valid)
app.get('/api/auth/me', requireLogin, wrap(async (req, res) => {
  const [rows] = await q(req, 'SELECT user_id, first_name, last_name, email, phone, role_name FROM rls_users WHERE user_id = ?', [req.user.id]);
  if (!rows.length) return res.status(401).json({ error: 'Account not found. Please log in again.', code: 'LOGIN_REQUIRED' });
  const [addr] = await q(req,
    `SELECT CONCAT_WS(', ', street, barangay, city, province) AS address FROM rls_customer_addresses
     WHERE user_id = ? ORDER BY is_default DESC, address_id LIMIT 1`, [req.user.id]);
  res.json({ ...rows[0], driver_id: req.user.driverId, address: addr[0]?.address || null });
}));

// ===================== HEALTH (for the load balancer) =====================

app.get('/api/health', wrap(async (req, res) => {
  const started = Date.now();
  try {
    await sys('SELECT 1');
    res.json({ status: 'ok', db: 'ok', db_ms: Date.now() - started, uptime_s: Math.round(process.uptime()), pid: process.pid });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'down', error: err.code || err.message });
  }
}));

// ===================== SHOP (public) =====================

// Product rows in the shape the website expects (name, price, stock)
const PRODUCT_SELECT = `
  SELECT v.product_id, v.sku, v.product_name AS name, v.description,
         v.category_name, v.supplier_name, v.unit_price AS price,
         v.quantity_on_hand AS stock, v.stock_status, v.avg_rating, v.review_count,
         p.image_url
  FROM vw_product_catalog v
  JOIN products p ON p.product_id = v.product_id`;

app.get('/api/products', wrap(async (req, res) => {
  const [rows] = await q(req, `${PRODUCT_SELECT} ORDER BY v.category_name, v.product_name`);
  res.json(rows);
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const [rows] = await q(req, `${PRODUCT_SELECT} WHERE v.product_id = ?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Product not found' });
  const [specs] = await q(req, 'SELECT spec_name, spec_value FROM product_specifications WHERE product_id = ?', [req.params.id]);
  res.json({ ...rows[0], specifications: specs });
}));

// Public list of a product's customer reviews (name shown as "First L.")
app.get('/api/products/:id/reviews', wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid product ID' });
  const [rows] = await sys(
    `SELECT pr.rating, pr.comment, pr.created_at, u.first_name,
            CONCAT(UPPER(LEFT(u.last_name, 1)), '.') AS last_initial
       FROM product_reviews pr
       JOIN users u ON u.user_id = pr.user_id
      WHERE pr.product_id = ?
      ORDER BY pr.created_at DESC
      LIMIT 50`, [id]);
  res.json(rows);
}));

app.get('/api/search', wrap(async (req, res) => {
  const term = `%${String(req.query.q || '').trim().slice(0, 100)}%`;
  const [rows] = await q(req,
    `${PRODUCT_SELECT}
     WHERE v.product_name LIKE ? OR v.sku LIKE ? OR v.description LIKE ? OR v.category_name LIKE ?
     ORDER BY v.product_name LIMIT 50`, [term, term, term, term]);
  res.json(rows);
}));

app.get('/api/suppliers', wrap(async (req, res) => {
  const [rows] = await q(req,
    'SELECT supplier_id, supplier_name, contact_person, email, phone, city FROM suppliers ORDER BY supplier_name');
  res.json(rows);
}));

// "Frequently bought together" (from a summary view with no customer data)
app.get('/api/recommendations/product/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid product ID' });
  const [rows] = await q(req,
    `${PRODUCT_SELECT}
     JOIN (SELECT other_product_id, times_bought_together FROM vw_bought_together
           WHERE product_id = ? ORDER BY times_bought_together DESC LIMIT 8) r
       ON r.other_product_id = v.product_id
     ORDER BY r.times_bought_together DESC`, [id]);
  res.json(rows);
}));

// For the logged-in customer: best sellers in the categories they buy, that they have not bought yet
app.get('/api/me/recommendations', requireLogin, wrap(async (req, res) => {
  let [rows] = await q(req,
    `${PRODUCT_SELECT}
     JOIN vw_top_selling_products t ON t.product_id = v.product_id
     WHERE p.category_id IN (SELECT DISTINCT p2.category_id FROM rls_order_items oi
                               JOIN products p2 ON p2.product_id = oi.product_id)
       AND v.product_id NOT IN (SELECT product_id FROM rls_order_items)
     ORDER BY t.sales_rank LIMIT 8`);
  if (!rows.length) {
    [rows] = await q(req,
      `${PRODUCT_SELECT} JOIN vw_top_selling_products t ON t.product_id = v.product_id
       WHERE t.sales_rank <= 8 ORDER BY t.sales_rank`);
  }
  res.json(rows);
}));

// ===================== CUSTOMER ORDERS (RLS: only their own) =====================

// Checkout: the logged-in customer is the buyer (never taken from the request body)
// ---------- Order confirmation email (Resend HTTP API; never blocks checkout) ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Chomp Shop <onboarding@resend.dev>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

async function sendOrderEmail(order, user) {
  if (!RESEND_API_KEY) return;
  const to = [user.email].filter(Boolean);
  if (ADMIN_EMAIL && !to.includes(ADMIN_EMAIL)) to.push(ADMIN_EMAIL);
  if (!to.length) return;
  const total = Number(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#13254a">
    <h2 style="margin:0 0 8px">Chomp Shop — Order Confirmed 🎉</h2>
    <p style="margin:0 0 12px">Hi ${user.name || 'customer'}, salamat sa iyong order!</p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:3px 10px 3px 0;color:#6c7590">Order number</td><td><b>#${order.order_id}</b></td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#6c7590">Total</td><td><b>₱${total}</b></td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#6c7590">Status</td><td>Pending — awaiting confirmation</td></tr>
    </table>
    <p style="margin:12px 0 0">Bibigyan ka namin ng update habang pinoproseso ang order mo.</p>
    <p style="color:#6c7590;font-size:12px;margin-top:18px">Chomp Shop · Online Store</p></div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to, subject: `Chomp Shop — Order #${order.order_id} confirmed`, html }),
    });
    if (!r.ok) log('warn', 'order email failed', { status: r.status, body: (await r.text()).slice(0, 200) });
    else log('info', 'order email sent', { order: order.order_id, to: to.length });
  } catch (err) { log('warn', 'order email error', { order: order.order_id, err: err.message }); }
}

app.post('/api/checkout', checkoutLimiter, requireRole('Customer'), wrap(async (req, res) => {
  const body = req.body || {};
  const method = String(body.payment_method || 'GCASH').toUpperCase();
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map((i) => ({
    product_id: Number(i.product_id), quantity: Number(i.quantity),
  }));
  if (!['GCASH', 'MAYA', 'CARD', 'COD'].includes(method))
    return res.status(400).json({ error: 'Payment method must be GCASH, MAYA, CARD or COD' });
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });

  const [addr] = await q(req,
    'SELECT address_id FROM rls_customer_addresses WHERE user_id = ? ORDER BY is_default DESC, address_id LIMIT 1',
    [req.user.id]);
  if (!addr.length) return res.status(400).json({ error: 'Add a delivery address to your account first.' });

  const [sets] = await q(req, 'CALL sp_place_order(?, ?, ?, ?, @order_id)',
    [req.user.id, addr[0].address_id, JSON.stringify(items), method]);
  const order = sets[0][0];
  audit(req, 'checkout', 'order', order.order_id, { total: order.total_amount, method, items: items.length });
  // AI fraud check (never blocks the checkout if it fails)
  try { await scoreOrder(order.order_id); } catch (err) { log('warn', 'AI fraud check failed', { order: order.order_id, err: err.message }); }
  // Send order confirmation email (fire-and-forget; never blocks or fails the checkout)
  sendOrderEmail(order, req.user).catch(() => {});
  res.status(201).json(order);
}));

// ===================== SAVED CART (RLS: only their own) =====================

app.get('/api/me/cart', requireRole('Customer'), wrap(async (req, res) => {
  const [rows] = await q(req,
    `SELECT c.product_id, c.quantity, v.product_name AS name, v.unit_price AS price, v.quantity_on_hand AS stock
     FROM rls_cart_items c
     JOIN vw_product_catalog v ON v.product_id = c.product_id
     WHERE c.user_id = ?
     ORDER BY c.added_at, c.product_id`, [req.user.id]);
  res.json(rows);
}));

// Replaces the whole cart. The user ID comes from the login token inside sp_cart_save (app_user_id()).
app.put('/api/me/cart', requireRole('Customer'), wrap(async (req, res) => {
  const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 50)
    .map((i) => ({ product_id: Number(i.product_id), quantity: Math.min(99, Math.max(1, Math.floor(Number(i.quantity) || 1))) }))
    .filter((i) => Number.isInteger(i.product_id) && i.product_id > 0);
  await q(req, 'CALL sp_cart_save(?)', [JSON.stringify(items)]);
  res.json({ saved: items.length });
}));

// "My Orders"
app.get('/api/me/orders', requireLogin, wrap(async (req, res) => {
  const [orders] = await q(req,
    `SELECT o.order_id, o.order_date, o.status, pay.payment_method, pay.payment_status, pay.amount,
            (SELECT SUM(quantity) FROM rls_order_items WHERE order_id = o.order_id) AS items
     FROM rls_orders o
     LEFT JOIN rls_payments pay ON pay.order_id = o.order_id
     WHERE o.user_id = ?
     ORDER BY o.order_date DESC, o.order_id DESC
     LIMIT 50`, [req.user.id]);
  res.json({ customer: req.user.name, orders });
}));

// Order details: everything comes from RLS views, so other people's orders simply "do not exist"
app.get('/api/orders/:id/details', requireLogin, wrap(async (req, res) => {
  const [rows] = await q(req,
    `SELECT o.order_id, o.order_date, o.status,
            o.user_id, CONCAT(u.first_name, ' ', u.last_name) AS customer,
            CONCAT_WS(', ', a.street, a.barangay, a.city, a.province) AS address,
            pay.payment_method, pay.payment_status, pay.amount, pay.paid_at
     FROM rls_orders o
     LEFT JOIN rls_users u              ON u.user_id    = o.user_id
     JOIN rls_customer_addresses a      ON a.address_id = o.address_id
     LEFT JOIN rls_payments pay         ON pay.order_id = o.order_id
     WHERE o.order_id = ?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const order = rows[0];
  if (!order.customer) order.customer = 'Customer #' + order.user_id; // riders see the name below instead

  const [items] = await q(req,
    `SELECT p.product_id, p.sku, p.product_name AS name, oi.quantity, oi.unit_price AS price,
            oi.quantity * oi.unit_price AS subtotal,
            s.supplier_name, s.city AS supplier_city,
            r.rating AS my_rating, r.comment AS my_comment
     FROM rls_order_items oi
     JOIN products  p ON p.product_id  = oi.product_id
     JOIN suppliers s ON s.supplier_id = p.supplier_id
     LEFT JOIN rls_my_reviews r ON r.product_id = p.product_id AND r.user_id = ?
     WHERE oi.order_id = ?`, [order.user_id, req.params.id]);

  const [del] = await q(req,
    `SELECT dl.driver_id, dl.driver_name, dl.driver_phone, dl.vehicle, dl.plate_no,
            dl.assigned_at, dl.delivered_at, dl.recipient_name, dl.proof_image_url, dl.notes,
            dr.rating AS driver_rating, dr.comment AS driver_comment
     FROM rls_deliveries dl
     LEFT JOIN rls_driver_ratings dr ON dr.order_id = dl.order_id
     WHERE dl.order_id = ?`, [req.params.id]);

  const ship_from = [...new Map(items.map((i) =>
    [i.supplier_name, { supplier_name: i.supplier_name, city: i.supplier_city }])).values()];
  res.json({ ...order, ship_from, delivery: del[0] || null, items });
}));

// Rate the rider of a delivered order (trigger checks it was delivered and is yours)
app.post('/api/orders/:id/rate-driver', feedbackLimiter, requireRole('Customer'), wrap(async (req, res) => {
  const rating = Number(req.body?.rating);
  const comment = String(req.body?.comment || '').trim().slice(0, 500) || null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5 stars' });

  const [rows] = await q(req, 'SELECT driver_id FROM rls_deliveries WHERE order_id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No delivery found for this order' });
  try {
    await q(req, 'INSERT INTO driver_ratings (order_id, driver_id, user_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, rows[0].driver_id, req.user.id, rating, comment]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You already rated the rider for this order' });
    throw err;
  }
  audit(req, 'rate_rider', 'order', req.params.id, { rating });
  res.status(201).json({ ok: true });
}));

// Review a product from a delivered order (trigger checks it was delivered and is yours)
app.post('/api/orders/:id/review-product', feedbackLimiter, requireRole('Customer'), wrap(async (req, res) => {
  const productId = toId(req.body?.product_id);
  const rating = Number(req.body?.rating);
  const comment = String(req.body?.comment || '').trim().slice(0, 1000) || null;
  if (!productId) return res.status(400).json({ error: 'product_id required' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5 stars' });

  const [rows] = await q(req, 'SELECT 1 FROM rls_order_items WHERE order_id = ? AND product_id = ?', [req.params.id, productId]);
  if (!rows.length) return res.status(404).json({ error: 'This product is not in this order' });
  try {
    await q(req, 'INSERT INTO product_reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)',
      [productId, req.user.id, rating, comment]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You already reviewed this product' });
    throw err;
  }
  audit(req, 'review_product', 'product', productId, { rating, order_id: req.params.id });
  res.status(201).json({ ok: true });
}));

// ===================== STAFF & RIDERS =====================

// Proof-of-delivery photos are saved in backend/uploads/proofs
const uploadDir = UPLOAD_ROOT;
const proofDir = path.join(uploadDir, 'proofs');
fs.mkdirSync(proofDir, { recursive: true });
const imageFilter = (req, file, cb) => cb(null, /^image\/(png|jpe?g|gif|webp|heic|heif)$/.test(file.mimetype));
const uploadProof = multer({
  storage: multer.diskStorage({
    destination: proofDir,
    filename: (req, file, cb) =>
      cb(null, `order-${toId(req.params.id)}-${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: imageFilter,
});
const uploadProductImage = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
});

// Riders with their scorecard and latest feedback
app.get('/api/staff/drivers', requireRole(...STAFF_ROLES, 'Rider'), wrap(async (req, res) => {
  const onlyMe = req.user.role === 'Rider' ? ' WHERE driver_id = ' + Number(req.user.driverId || 0) : '';
  const [drivers] = await q(req, `SELECT * FROM vw_driver_performance${onlyMe} ORDER BY driver_id`);
  const [feedback] = await q(req,
    `SELECT driver_id, order_id, rating, comment, created_at FROM (
       SELECT dr.*, ROW_NUMBER() OVER (PARTITION BY driver_id ORDER BY created_at DESC) AS rn
       FROM rls_driver_ratings dr) x
     WHERE rn <= 3 ORDER BY driver_id, created_at DESC`);
  res.json(drivers.map((d) => ({ ...d, feedback: feedback.filter((f) => f.driver_id === d.driver_id) })));
}));

// Order queue. Staff see everything; a rider only sees their own deliveries.
app.get('/api/staff/orders', requireRole(...STAFF_ROLES, 'Rider'), wrap(async (req, res) => {
  const statuses = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
  const status = String(req.query.status || 'PENDING').toUpperCase();
  if (!statuses.includes(status)) return res.status(400).json({ error: 'Unknown status' });

  const isRider = req.user.role === 'Rider';
  if (isRider && !['SHIPPED', 'DELIVERED'].includes(status)) return res.json({ status, counts: {}, orders: [] });
  const driverId = isRider ? req.user.driverId || -1 : toId(req.query.driver_id);

  const order = 'DESC'; // newest orders first in every tab, so new customer orders show at the top
  const [orders] = await q(req,
    `SELECT o.order_id, o.order_date, o.status, o.user_id,
            CONCAT(u.first_name, ' ', u.last_name) AS customer, u.phone,
            CONCAT_WS(', ', a.street, a.barangay, a.city, a.province) AS address,
            a.city AS to_city,
            pay.payment_method, pay.payment_status, pay.amount,
            pr.risk_score, pr.risk_level, pr.reasons AS risk_reasons, pr.reviewed_by AS risk_reviewed_by,
            dl.driver_id, d.full_name AS driver_name, dl.assigned_at, dl.delivered_at,
            dl.recipient_name, dl.proof_image_url, dr.rating AS driver_rating, dr.comment AS driver_comment,
            (SELECT d2.driver_id FROM drivers d2
              WHERE d2.is_active AND d2.service_area LIKE CONCAT('%', a.city, '%') LIMIT 1) AS suggested_driver_id,
            (SELECT GROUP_CONCAT(CONCAT(oi.quantity, ' x ', p.product_name) ORDER BY p.product_name SEPARATOR '; ')
               FROM order_items oi JOIN products p ON p.product_id = oi.product_id
              WHERE oi.order_id = o.order_id) AS items,
            (SELECT GROUP_CONCAT(DISTINCT CONCAT(s.supplier_name, ' (', s.city, ')') SEPARATOR '; ')
               FROM order_items oi
               JOIN products  p ON p.product_id  = oi.product_id
               JOIN suppliers s ON s.supplier_id = p.supplier_id
              WHERE oi.order_id = o.order_id) AS ship_from
     FROM rls_orders o
     JOIN users u              ON u.user_id    = o.user_id
     JOIN customer_addresses a ON a.address_id = o.address_id
     LEFT JOIN payments pay    ON pay.order_id = o.order_id
     LEFT JOIN rls_payment_risk pr ON pr.order_id = o.order_id
     LEFT JOIN deliveries dl   ON dl.order_id  = o.order_id
     LEFT JOIN drivers d       ON d.driver_id  = dl.driver_id
     LEFT JOIN driver_ratings dr ON dr.order_id = o.order_id
     WHERE o.status = ? AND (? IS NULL OR dl.driver_id = ?)
     ORDER BY o.order_date ${order}, o.order_id ${order}
     LIMIT 100`, [status, driverId, driverId]);

  const [counts] = await q(req,
    `SELECT o.status, COUNT(*) AS total FROM rls_orders o
     LEFT JOIN deliveries dl ON dl.order_id = o.order_id
     WHERE (? IS NULL OR dl.driver_id = ? OR o.status IN ('PENDING', 'PAID'))
     GROUP BY o.status`, [driverId, driverId]);
  res.json({ status, counts: Object.fromEntries(counts.map((c) => [c.status, c.total])), orders });
}));

// Confirm payment or cancel. Shipping and delivery have their own routes.
app.post('/api/orders/:id/status', staffOnly, wrap(async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (status === 'SHIPPED') return res.status(400).json({ error: 'Assign a rider to ship this order' });
  if (status === 'DELIVERED') return res.status(400).json({ error: 'The rider must upload a proof of delivery' });
  let reviewedHighRisk = false;
  if (status === 'PAID') {
    const [risk] = await q(req, 'SELECT risk_level, risk_score, reasons FROM rls_payment_risk WHERE order_id = ?', [req.params.id]);
    if (risk.length && risk[0].risk_level === 'HIGH') {
      if (!req.body?.override_risk) {
        return res.status(409).json({
          error: `AI fraud check: HIGH risk (${risk[0].risk_score}/100). ${risk[0].reasons}. Verify the payment, then confirm again.`,
          risk: risk[0], needs_review: true,
        });
      }
      reviewedHighRisk = true;
    }
  }
  const [sets] = await q(req, 'CALL sp_update_order_status(?, ?, ?)', [req.params.id, status, req.user.id]);
  if (reviewedHighRisk) {
    await q(req, 'UPDATE payment_risk SET reviewed_by = ?, reviewed_at = NOW() WHERE order_id = ?', [req.user.id, req.params.id]);
  }
  audit(req, 'order_status', 'order', req.params.id, { status, high_risk_reviewed: reviewedHighRisk || undefined });
  res.json(sets[0][0]);
}));

// Ship: assign a rider, then mark the order SHIPPED
app.post('/api/staff/orders/:id/ship', staffOnly, wrap(async (req, res) => {
  const driverId = toId(req.body?.driver_id);
  if (!driverId) return res.status(400).json({ error: 'Choose a rider' });
  const [d] = await q(req, 'SELECT full_name FROM drivers WHERE driver_id = ? AND is_active', [driverId]);
  if (!d.length) return res.status(400).json({ error: 'Rider not found or inactive' });

  const [sets] = await q(req, 'CALL sp_update_order_status(?, ?, ?)', [req.params.id, 'SHIPPED', req.user.id]);
  await q(req,
    `INSERT INTO deliveries (order_id, driver_id, assigned_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE driver_id = VALUES(driver_id), assigned_by = VALUES(assigned_by), assigned_at = NOW()`,
    [req.params.id, driverId, req.user.id]);
  audit(req, 'order_ship', 'order', req.params.id, { driver_id: driverId });
  res.json({ ...sets[0][0], driver_name: d[0].full_name });
}));

// Deliver: proof photo required. A rider can only deliver their own orders (also enforced by a DB trigger).
app.post('/api/staff/orders/:id/deliver', uploadLimiter, requireRole(...STAFF_ROLES, 'Rider'),
  uploadProof.single('proof'), wrap(async (req, res) => {
    const removeUpload = () => req.file && fs.unlink(req.file.path, () => {});
    if (!req.file) return res.status(400).json({ error: 'Attach a photo as proof of delivery (max 8MB)' });

    const recipient = String(req.body?.recipient_name || '').trim().slice(0, 100);
    const notes = String(req.body?.notes || '').trim().slice(0, 255) || null;
    if (!recipient) { removeUpload(); return res.status(400).json({ error: 'Enter who received the parcel' }); }

    const [dl] = await q(req, 'SELECT driver_id FROM rls_deliveries WHERE order_id = ?', [req.params.id]);
    if (!dl.length) { removeUpload(); return res.status(404).json({ error: 'Delivery not found' }); }
    if (req.user.role === 'Rider' && dl[0].driver_id !== req.user.driverId) {
      removeUpload();
      return res.status(403).json({ error: 'This delivery is assigned to another rider' });
    }

    try {
      await q(req, 'CALL sp_update_order_status(?, ?, ?)', [req.params.id, 'DELIVERED', req.user.id]);
    } catch (err) {
      removeUpload();
      throw err;
    }
    const url = '/uploads/proofs/' + req.file.filename;
    await q(req,
      'UPDATE deliveries SET delivered_at = NOW(), recipient_name = ?, proof_image_url = ?, notes = ? WHERE order_id = ?',
      [recipient, url, notes, req.params.id]);
    audit(req, 'order_deliver', 'order', req.params.id, { proof: url });
    res.json({ order_id: Number(req.params.id), status: 'DELIVERED', proof_image_url: url });
  }));

// ===================== REPORTS & FORECASTING (staff) =====================

const reports = {
  'daily-sales': 'SELECT * FROM vw_daily_sales_summary ORDER BY sale_date DESC LIMIT 60',
  'top-sellers': 'SELECT * FROM vw_top_selling_products ORDER BY sales_rank LIMIT 20',
  'monthly-category': 'SELECT * FROM vw_monthly_category_sales ORDER BY sale_month DESC, category_id LIMIT 200',
  'low-stock': 'SELECT * FROM vw_low_stock_products ORDER BY quantity_on_hand',
  'forecast-vs-actual': 'SELECT * FROM vw_forecast_vs_actual ORDER BY forecast_id DESC LIMIT 100',
  'rider-performance': 'SELECT * FROM vw_driver_performance ORDER BY driver_id',
  'restock-requests': `
    SELECT r.restock_id, p.sku, p.product_name, s.supplier_name, r.quantity_requested,
           r.status, r.reason, r.created_at
    FROM restock_requests r
    JOIN products  p ON p.product_id  = r.product_id
    JOIN suppliers s ON s.supplier_id = r.supplier_id
    ORDER BY r.restock_id DESC LIMIT 100`,
};

app.get('/api/reports/:name', staffOnly, wrap(async (req, res) => {
  const sql = reports[req.params.name];
  if (!sql) return res.status(404).json({ error: 'Unknown report' });
  const [rows] = await q(req, sql);
  res.json(rows);
}));

// Dashboard overview: KPIs + top products by units delivered (staff/admin)
app.get('/api/staff/dashboard', staffOnly, wrap(async (req, res) => {
  const [statusRows] = await sys('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const counts = {};
  let total = 0;
  statusRows.forEach((r) => { counts[r.status] = Number(r.n); total += Number(r.n); });
  const delivered = counts.DELIVERED || 0;
  const cancelled = counts.CANCELLED || 0;

  const [[rev]] = await sys(
    `SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS delivered_revenue,
            COALESCE(SUM(oi.quantity), 0)                 AS units_delivered
       FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
      WHERE o.status = 'DELIVERED'`);
  const [[prod]] = await sys('SELECT COUNT(*) AS n FROM products WHERE is_active = TRUE');
  const [[low]]  = await sys('SELECT COUNT(*) AS n FROM vw_low_stock_products');

  const [top] = await sys(
    `SELECT p.product_id, p.product_name, p.sku, c.category_name,
            SUM(oi.quantity)                 AS units_delivered,
            SUM(oi.quantity * oi.unit_price) AS revenue
       FROM order_items oi
       JOIN orders     o ON o.order_id    = oi.order_id
       JOIN products   p ON p.product_id  = oi.product_id
       JOIN categories c ON c.category_id = p.category_id
      WHERE o.status = 'DELIVERED'
      GROUP BY p.product_id, p.product_name, p.sku, c.category_name
      ORDER BY units_delivered DESC
      LIMIT 8`);

  res.json({
    orders_total: total,
    delivered,
    cancelled,
    in_progress: total - delivered - cancelled,
    delivered_revenue: Number(rev.delivered_revenue),
    units_delivered: Number(rev.units_delivered),
    products: Number(prod.n),
    low_stock: Number(low.n),
    counts,
    top_products: top.map((r) => ({ ...r, units_delivered: Number(r.units_delivered), revenue: Number(r.revenue) }))
  });
}));

// Forecast = weighted moving average of the last 8 weeks (recent weeks count more)
app.post('/api/forecasts/generate', staffOnly, wrap(async (req, res) => {
  const productId = toId(req.body?.product_id);
  const days = Number(req.body?.days ?? 7);
  if (!productId) return res.status(400).json({ error: 'product_id required' });
  if (!Number.isInteger(days) || days < 1 || days > 90) return res.status(400).json({ error: 'days must be from 1 to 90' });

  const [prod] = await q(req,
    `SELECT p.product_id, p.sku, p.product_name, i.quantity_on_hand, i.reorder_level
     FROM products p JOIN inventory i ON i.product_id = p.product_id WHERE p.product_id = ?`, [productId]);
  if (!prod.length) return res.status(404).json({ error: 'Product not found' });

  const WEEKS = 8;
  const MODEL = 'WMA-8w';
  const [sets] = await q(req, 'CALL sp_get_sales_history(?, ?)', [productId, WEEKS + 1]);
  const byWeek = new Map(sets[0].map((r) => [String(r.week_start).slice(0, 10), Number(r.units_sold)]));

  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const history = [];
  for (let i = WEEKS; i >= 1; i--) {
    const d = new Date(thisMonday);
    d.setDate(thisMonday.getDate() - 7 * i);
    history.push({ week_start: fmt(d), units_sold: byWeek.get(fmt(d)) || 0 });
  }
  let weightSum = 0;
  let weighted = 0;
  history.forEach((w, i) => { weightSum += i + 1; weighted += (i + 1) * w.units_sold; });
  const avgPerWeek = weighted / weightSum;
  const predicted = Math.round((avgPerWeek / 7) * days);

  await q(req, 'CALL sp_save_forecast(?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?)',
    [productId, days - 1, predicted, MODEL]);
  audit(req, 'forecast', 'product', productId, { days, predicted });

  const p = prod[0];
  res.status(201).json({
    product_id: p.product_id, sku: p.sku, name: p.product_name, model: MODEL, days,
    avg_units_per_week: Math.round(avgPerWeek * 10) / 10, predicted_quantity: predicted,
    current_stock: p.quantity_on_hand, reorder_level: p.reorder_level,
    restock_needed: predicted + p.reorder_level > p.quantity_on_hand, history,
  });
}));

app.post('/api/restock/suggestions', staffOnly, wrap(async (req, res) => {
  const [sets] = await q(req, 'CALL sp_generate_restock_suggestions(?)', [req.user.id]);
  audit(req, 'restock_suggestions', 'restock', null, { created: sets[0][0].suggestions_created });
  res.json({ suggestions_created: sets[0][0].suggestions_created, pending: sets[1] });
}));

app.post('/api/restock/:id/receive', staffOnly, wrap(async (req, res) => {
  const [sets] = await q(req, 'CALL sp_receive_restock(?, ?)', [req.params.id, req.user.id]);
  audit(req, 'restock_receive', 'restock', req.params.id);
  res.json(sets[0][0]);
}));

app.post('/api/suppliers', staffOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.supplier_name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Enter a supplier name' });
  const [r] = await q(req,
    'INSERT INTO suppliers (supplier_name, contact_person, email, phone, city) VALUES (?, ?, ?, ?, ?)',
    [name, ...['contact_person', 'email', 'phone', 'city'].map((k) => String(b[k] || '').trim().slice(0, 100) || null)]);
  audit(req, 'create', 'suppliers', r.insertId);
  res.status(201).json({ supplier_id: r.insertId });
}));

app.post('/api/products/:id/image', uploadLimiter, staffOnly, uploadProductImage.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a png, jpg, gif or webp image (max 5MB)' });
  const url = '/uploads/' + req.file.filename;
  const [r] = await q(req, 'UPDATE products SET image_url = ? WHERE product_id = ?', [url, req.params.id]);
  if (!r.affectedRows) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Not found' }); }
  audit(req, 'product_image', 'product', req.params.id);
  res.json({ product_id: Number(req.params.id), image_url: url });
}));

// ===================== ADMIN: monitoring =====================

app.get('/api/admin/errors', adminOnly, wrap(async (req, res) => {
  const [rows] = await sys('SELECT error_id, created_at, status, method, path, message, user_id, request_id FROM error_log ORDER BY error_id DESC LIMIT 100');
  res.json(rows);
}));

app.get('/api/admin/audit', adminOnly, wrap(async (req, res) => {
  const [rows] = await sys(
    `SELECT a.audit_id, a.created_at, a.action, a.entity, a.entity_id, a.role_name,
            CONCAT(u.first_name, ' ', u.last_name) AS user_name, a.ip_address, a.details
     FROM audit_log a LEFT JOIN users u ON u.user_id = a.user_id
     ORDER BY a.audit_id DESC LIMIT 100`);
  res.json(rows);
}));

app.get('/api/admin/system', adminOnly, wrap(async (req, res) => {
  const [[counts]] = await sys(
    `SELECT (SELECT COUNT(*) FROM error_log WHERE created_at > NOW() - INTERVAL 1 DAY) AS errors_24h,
            (SELECT COUNT(*) FROM audit_log WHERE action = 'login_failed' AND created_at > NOW() - INTERVAL 1 DAY) AS failed_logins_24h,
            (SELECT COUNT(*) FROM audit_log WHERE action = 'login' AND created_at > NOW() - INTERVAL 1 DAY) AS logins_24h,
            (SELECT COUNT(*) FROM users WHERE locked_until > NOW()) AS locked_accounts`);
  const backups = fs.existsSync(path.join(__dirname, 'backups'))
    ? fs.readdirSync(path.join(__dirname, 'backups')).filter((f) => f.endsWith('.sql')).sort().reverse().slice(0, 5)
    : [];
  res.json({
    ...counts, instance: `${require('os').hostname()} (pid ${process.pid})`, uptime_s: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, latest_backups: backups,
  });
}));

// ===================== ADMIN: generic CRUD (API tester) =====================
// ops: c = create, r = read, u = update, d = delete. Orders and payments only change through procedures.
const entities = {
  products: { table: 'products', pk: 'product_id', ops: 'cru',
    cols: ['category_id', 'supplier_id', 'sku', 'product_name', 'description', 'unit_price', 'cost_price', 'is_active', 'image_url'] },
  categories: { table: 'categories', pk: 'category_id', ops: 'cru', cols: ['category_name', 'description'] },
  suppliers: { table: 'suppliers', pk: 'supplier_id', ops: 'cru', cols: ['supplier_name', 'contact_person', 'email', 'phone', 'city'] },
  users: { table: 'users', pk: 'user_id', ops: 'ru', cols: ['is_active', 'phone'],
    select: 'user_id, role_id, first_name, last_name, email, phone, is_active, failed_logins, locked_until, last_login_at, created_at' },
  addresses: { table: 'customer_addresses', pk: 'address_id', ops: 'r' },
  inventory: { table: 'inventory', pk: 'product_id', ops: 'ru', cols: ['reorder_level'] },
  orders: { table: 'orders', pk: 'order_id', ops: 'r' },
  'order-items': { table: 'order_items', pk: 'order_item_id', ops: 'r' },
  payments: { table: 'payments', pk: 'payment_id', ops: 'r' },
  reviews: { table: 'product_reviews', pk: 'review_id', ops: 'rd' },
  forecasts: { table: 'demand_forecasts', pk: 'forecast_id', ops: 'r' },
  drivers: { table: 'drivers', pk: 'driver_id', ops: 'ru', cols: ['phone', 'vehicle', 'plate_no', 'service_area', 'is_active'] },
  deliveries: { table: 'deliveries', pk: 'delivery_id', ops: 'r' },
  'driver-ratings': { table: 'driver_ratings', pk: 'rating_id', ops: 'r' },
  'restock-requests': { table: 'restock_requests', pk: 'restock_id', ops: 'r' },
  'inventory-transactions': { table: 'inventory_transactions', pk: 'transaction_id', ops: 'r' },
};
const pick = (body, cols = []) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => cols.includes(k)));

for (const [name, e] of Object.entries(entities)) {
  const base = `/api/admin/data/${name}`;
  const select = e.select || '*';
  const notAllowed = (res) => res.status(405).json({ error: `This action is not allowed for ${name}` });

  app.get(base, adminOnly, wrap(async (req, res) => {
    const [rows] = await q(req, `SELECT ${select} FROM ${e.table} ORDER BY ${e.pk} DESC LIMIT 200`);
    res.json(rows);
  }));
  app.get(`${base}/:id`, adminOnly, wrap(async (req, res) => {
    const [rows] = await q(req, `SELECT ${select} FROM ${e.table} WHERE ${e.pk} = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  }));
  app.post(base, adminOnly, wrap(async (req, res) => {
    if (!e.ops.includes('c')) return notAllowed(res);
    const data = pick(req.body, e.cols);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields' });
    const [r] = await q(req, `INSERT INTO ${e.table} SET ?`, [data]);
    if (name === 'products') await q(req, 'INSERT INTO inventory (product_id, quantity_on_hand) VALUES (?, 0)', [r.insertId]);
    audit(req, 'create', name, r.insertId, data);
    const [rows] = await q(req, `SELECT ${select} FROM ${e.table} WHERE ${e.pk} = ?`, [r.insertId]);
    res.status(201).json(rows[0]);
  }));
  app.put(`${base}/:id`, adminOnly, wrap(async (req, res) => {
    if (!e.ops.includes('u')) return notAllowed(res);
    const data = pick(req.body, e.cols);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields' });
    const [r] = await q(req, `UPDATE ${e.table} SET ? WHERE ${e.pk} = ?`, [data, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    audit(req, 'update', name, req.params.id, data);
    const [rows] = await q(req, `SELECT ${select} FROM ${e.table} WHERE ${e.pk} = ?`, [req.params.id]);
    res.json(rows[0]);
  }));
  app.delete(`${base}/:id`, adminOnly, wrap(async (req, res) => {
    if (!e.ops.includes('d')) return notAllowed(res);
    const [r] = await q(req, `DELETE FROM ${e.table} WHERE ${e.pk} = ?`, [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    audit(req, 'delete', name, req.params.id);
    res.status(204).end();
  }));
}

// ===================== AI FRAUD CHECK (payments) =====================
// Model + rules live in ai/fraud.js. Here: getting the data, saving scores, staff routes.

const BAD_ORDER = (o) => o.status === 'CANCELLED' || ['FAILED', 'REFUNDED'].includes(o.payment_status);

// Every order with what the AI needs, oldest first
async function loadOrdersForAI(userId = null) {
  const [rows] = await sys(
    `SELECT o.order_id, o.user_id, o.order_date, o.status, pay.payment_method, pay.payment_status,
            COALESCE(pay.amount, 0) AS amount, u.created_at AS user_created, u.failed_logins,
            (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.order_id) AS quantity
     FROM orders o
     JOIN users u ON u.user_id = o.user_id
     LEFT JOIN payments pay ON pay.order_id = o.order_id
     WHERE (? IS NULL OR o.user_id = ?)
     ORDER BY o.order_date, o.order_id`, [userId, userId]);
  return rows;
}

// The signals for one order, using only that customer's EARLIER orders
function aiContext(order, earlier, includeLogins) {
  const t = new Date(order.order_date.replace(' ', 'T')).getTime();
  const created = order.user_created ? new Date(order.user_created.replace(' ', 'T')).getTime() : null;
  return {
    amount: Number(order.amount), method: order.payment_method, quantity: Number(order.quantity),
    hour: new Date(t).getHours(),
    accountAgeHours: created ? (t - created) / 3600000 : null,
    failedLogins: includeLogins ? order.failed_logins : 0,
    history: earlier.filter((o) => o.status !== 'PENDING').map((o) => ({ amount: Number(o.amount), bad: BAD_ORDER(o) })),
    ordersLast24h: earlier.filter((o) => t - new Date(o.order_date.replace(' ', 'T')).getTime() < 86400000).length,
  };
}

async function trainFraudModel() {
  const rows = await loadOrdersForAI();
  const byUser = new Map();
  const samples = [];
  for (const o of rows) {
    const earlier = byUser.get(o.user_id) || [];
    if (o.status !== 'PENDING') samples.push({ f: fraudAI.features(aiContext(o, earlier, false)), bad: BAD_ORDER(o) ? 1 : 0 });
    earlier.push(o);
    byUser.set(o.user_id, earlier);
  }
  const m = fraudAI.train(samples);
  log('info', 'AI fraud model trained', { version: m.version, samples: m.samples, accuracy: m.accuracy ?? null });
  return m;
}

async function scoreOrder(orderId) {
  const [own] = await sys('SELECT user_id FROM orders WHERE order_id = ?', [orderId]);
  if (!own.length) return null;
  const rows = await loadOrdersForAI(own[0].user_id);
  const idx = rows.findIndex((o) => o.order_id === Number(orderId));
  const result = fraudAI.score(aiContext(rows[idx], rows.slice(0, idx), true));
  await sys(
    `INSERT INTO payment_risk (order_id, risk_score, risk_level, reasons, model_version) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE risk_score = VALUES(risk_score), risk_level = VALUES(risk_level),
                             reasons = VALUES(reasons), model_version = VALUES(model_version)`,
    [orderId, result.score, result.level, result.reasons.slice(0, 600), result.version]);
  return { order_id: Number(orderId), ...result };
}

// Model info + how many orders are in each risk level
app.get('/api/staff/ai/fraud', staffOnly, wrap(async (req, res) => {
  const m = fraudAI.getModel();
  const [summary] = await q(req, `SELECT * FROM vw_payment_risk_summary ORDER BY FIELD(risk_level, 'HIGH', 'MEDIUM', 'LOW')`);
  res.json({
    model: m && { version: m.version, samples: m.samples, accuracy: m.accuracy ?? null, bad_rate: m.badRate,
      trained_at: m.trainedAt, note: m.note || null, weights: m.weights || null },
    summary,
  });
}));

// Check one order again (or see why it got its score)
app.post('/api/staff/ai/fraud/orders/:id', staffOnly, wrap(async (req, res) => {
  const r = await scoreOrder(toId(req.params.id));
  if (!r) return res.status(404).json({ error: 'Order not found' });
  res.json(r);
}));

// Retrain the model on the latest orders, then score all PENDING orders
app.post('/api/staff/ai/fraud/retrain', staffOnly, wrap(async (req, res) => {
  const m = await trainFraudModel();
  const [pending] = await sys("SELECT order_id FROM orders WHERE status = 'PENDING'");
  for (const o of pending) await scoreOrder(o.order_id);
  audit(req, 'ai_retrain', 'ai_model', null, { version: m.version, scored: pending.length });
  res.json({ version: m.version, samples: m.samples, accuracy: m.accuracy ?? null, scored: pending.length });
}));

async function startFraudAI() {
  try {
    await trainFraudModel();
    const [unscored] = await sys(
      `SELECT o.order_id FROM orders o LEFT JOIN payment_risk r ON r.order_id = o.order_id
       WHERE o.status = 'PENDING' AND r.order_id IS NULL`);
    for (const o of unscored) await scoreOrder(o.order_id);
    if (unscored.length) log('info', `AI fraud check scored ${unscored.length} pending order(s)`);
  } catch (err) {
    log('warn', 'AI fraud check is off (did you run database/11_saved_cart_and_ai_fraud.sql?)', { err: err.message });
  }
}
setInterval(() => trainFraudModel().catch(() => {}), 6 * 3600 * 1000).unref(); // retrain every 6 hours

// ===================== ERRORS =====================

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  let status = 500;
  let body = { error: 'Something went wrong. Please try again.' };

  if (err.code === 'LIMIT_FILE_SIZE') { status = 400; body = { error: 'Image is too large' }; }
  else if (err.type === 'entity.parse.failed') { status = 400; body = { error: 'Invalid JSON in request body' }; }
  else if (err.type === 'entity.too.large') { status = 413; body = { error: 'Request is too large' }; }
  else if (err.code === 'ER_DUP_ENTRY') { status = 409; body = { error: 'That value already exists' }; }
  else if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_ROW_IS_REFERENCED_2') { status = 409; body = { error: 'Linked record problem (foreign key)' }; }
  else if (err.sqlState === '45000') { status = 400; body = { error: err.sqlMessage }; } // SIGNAL from procedures/triggers (incl. RLS)
  else if (err.code === 'ER_TABLEACCESS_DENIED_ERROR' || err.code === 'ER_PROCACCESS_DENIED_ERROR') { status = 403; body = { error: 'Not allowed by database permissions' }; }
  else if (['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ETIMEDOUT'].includes(err.code)) {
    status = 503; body = { error: 'The database is not reachable right now. Please try again shortly.' };
  }
  body.request_id = req.id; // quote this ID when reporting a problem

  if (status >= 500) {
    log('error', err.message, { reqId: req.id, code: err.code, stack: err.stack, path: req.originalUrl });
    sys(`INSERT INTO error_log (request_id, method, path, status, message, stack, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.id, req.method, req.originalUrl.slice(0, 255), status, String(err.message).slice(0, 1000),
        IS_PROD ? null : String(err.stack || '').slice(0, 5000), req.user?.id ?? null]).catch(() => {});
  }
  res.status(status).json(body);
});

// ===================== START, CRASH SAFETY, SHUTDOWN =====================

// Sample accounts ship with a placeholder password: give them a real bcrypt hash of DEMO_PASSWORD
async function setDemoPasswords() {
  try {
    const [rows] = await sys('SELECT COUNT(*) AS n FROM users WHERE password_hash LIKE ?', [PLACEHOLDER_HASH]);
    if (!rows[0].n) return;
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    await sys('UPDATE users SET password_hash = ? WHERE password_hash LIKE ?', [hash, PLACEHOLDER_HASH]);
    log('info', `Set the demo password for ${rows[0].n} sample account(s)`);
  } catch (err) {
    log('warn', 'Could not set demo passwords (did you run database/10_security_rls.sql?)', { err: err.message });
  }
}

const server = app.listen(PORT, async () => {
  log('info', `Chomp Shop API on http://localhost:${PORT}`);
  await setDemoPasswords();
  await startFraudAI();
});

process.on('unhandledRejection', (err) => log('error', 'unhandledRejection', { err: String(err?.stack || err) }));
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException: restarting', { err: String(err?.stack || err) });
  process.exit(1); // Docker / PM2 restarts the app automatically
});

// Graceful shutdown: finish requests in progress, then close DB connections (used during deploys)
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `${signal} received: shutting down`);
  server.close(async () => {
    await Promise.allSettled([staffPool.end(), customerPool.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;