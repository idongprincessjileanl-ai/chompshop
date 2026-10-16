// Smoke and security tests. Run against a running server:
//   BASE_URL=http://localhost:3001 npm test
// CI starts a fresh MySQL + server and runs these on every push.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const PASSWORD = process.env.DEMO_PASSWORD || 'chomp123';

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

// Fetch a CAPTCHA and solve the math question so automated logins/registrations can pass.
async function solveCaptcha() {
  const r = await call('GET', '/api/captcha');
  assert.equal(r.status, 200, 'could not fetch a CAPTCHA');
  const [x, op, y] = String(r.data.question).split(' ');
  const a = Number(x), b = Number(y);
  const answer = op === '+' ? a + b : op === 'x' ? a * b : a - b;
  return { captcha_token: r.data.token, captcha_answer: answer };
}

const login = async (email) => {
  const cap = await solveCaptcha();
  const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD, ...cap } });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
};

let customer1, customer2, staff, admin, rider1;
before(async () => {
  customer1 = await login('customer1@example.com');
  customer2 = await login('customer2@example.com');
  staff = await login('staff1@chompcart.example');
  admin = await login('admin@chompcart.example');
  rider1 = await login('rider1@chompcart.example');
});

test('health check reports the database is up', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.db, 'ok');
});

test('public catalog works without logging in', async () => {
  const r = await call('GET', '/api/products');
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 50);
  assert.ok('price' in r.data[0] && 'stock' in r.data[0]);
});

test('rate limit headers are sent', async () => {
  const r = await call('GET', '/api/products');
  assert.ok(r.headers.get('ratelimit-policy') || r.headers.get('ratelimit'), 'missing RateLimit headers');
});

// ---------- CAPTCHA ----------

test('CAPTCHA: a login with no CAPTCHA is rejected', async () => {
  const r = await call('POST', '/api/auth/login', {
    body: { email: 'customer1@example.com', password: PASSWORD },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'CAPTCHA_FAILED');
});

test('CAPTCHA: a wrong answer is rejected', async () => {
  const cap = await solveCaptcha();
  const r = await call('POST', '/api/auth/login', {
    body: { email: 'customer1@example.com', password: PASSWORD, captcha_token: cap.captcha_token, captcha_answer: cap.captcha_answer + 1 },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'CAPTCHA_FAILED');
});

test('CAPTCHA: a token cannot be reused', async () => {
  const cap = await solveCaptcha();
  const first = await call('POST', '/api/auth/login', {
    body: { email: 'customer2@example.com', password: PASSWORD, ...cap },
  });
  assert.equal(first.status, 200, 'first use should log in');
  // Same token + answer again -> must be rejected as reused
  const second = await call('POST', '/api/auth/login', {
    body: { email: 'customer2@example.com', password: PASSWORD, ...cap },
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.code, 'CAPTCHA_FAILED');
});

test('wrong password is rejected (with a valid CAPTCHA)', async () => {
  const cap = await solveCaptcha();
  const r = await call('POST', '/api/auth/login', {
    body: { email: 'customer3@example.com', password: 'wrong-password', ...cap },
  });
  assert.equal(r.status, 401);
});

// ---------- Authentication / authorization ----------

test('my orders needs a login', async () => {
  const r = await call('GET', '/api/me/orders');
  assert.equal(r.status, 401);
});

test('RLS: a customer only sees their own orders', async () => {
  const mine = await call('GET', '/api/me/orders', { token: customer1 });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.orders.length > 0, 'sample customer 1 should have orders');

  // customer 2 asks for one of customer 1's orders: it must not exist for them
  const someoneElses = mine.data.orders[0].order_id;
  const r = await call('GET', `/api/orders/${someoneElses}/details`, { token: customer2 });
  assert.equal(r.status, 404);

  // staff can see it
  const s = await call('GET', `/api/orders/${someoneElses}/details`, { token: staff });
  assert.equal(s.status, 200);
});

test('permissions: customers cannot use staff or admin routes', async () => {
  assert.equal((await call('GET', '/api/staff/orders?status=PENDING', { token: customer1 })).status, 403);
  assert.equal((await call('GET', '/api/reports/daily-sales', { token: customer1 })).status, 403);
  assert.equal((await call('GET', '/api/admin/errors', { token: staff })).status, 403);
  assert.equal((await call('GET', '/api/admin/errors', { token: admin })).status, 200);
});

test('riders only see their own deliveries', async () => {
  const r = await call('GET', '/api/staff/orders?status=SHIPPED', { token: rider1 });
  assert.equal(r.status, 200);
  const me = await call('GET', '/api/auth/me', { token: rider1 });
  for (const o of r.data.orders) assert.equal(o.driver_id, me.data.driver_id);
  const pending = await call('GET', '/api/staff/orders?status=PENDING', { token: rider1 });
  assert.equal(pending.data.orders.length, 0);
});

test('checkout places an order for the logged-in customer only', async () => {
  const products = (await call('GET', '/api/products')).data;
  const cheap = products.filter((p) => p.stock > 5).sort((a, b) => a.price - b.price)[0];
  const r = await call('POST', '/api/checkout', {
    token: customer1,
    body: { payment_method: 'GCASH', items: [{ product_id: cheap.product_id, quantity: 1 }], user_id: 99 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const details = await call('GET', `/api/orders/${r.data.order_id}/details`, { token: customer1 });
  assert.equal(details.status, 200);
  assert.equal(details.data.user_id, (await call('GET', '/api/auth/me', { token: customer1 })).data.user_id);
});

// ---------- Inventory race (the e-commerce "double-booking") ----------

test('concurrent checkouts cannot oversell the last units of a product', async () => {
  const products = (await call('GET', '/api/products')).data;
  // Pick an in-stock product with a small stock so a short burst can exceed it.
  const target = products.filter((p) => p.stock >= 1).sort((a, b) => a.stock - b.stock)[0];
  assert.ok(target, 'need at least one in-stock product');
  const stock = target.stock;
  const attempts = Math.min(stock + 2, 8); // more attempts than stock, but within the checkout rate limit

  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      call('POST', '/api/checkout', {
        token: customer1,
        body: { payment_method: 'GCASH', items: [{ product_id: target.product_id, quantity: 1 }] },
      })
    )
  );
  const placed = results.filter((r) => r.status === 201).length;
  // The inventory lock must never let more orders succeed than there was stock.
  assert.ok(placed <= stock, `oversold: ${placed} orders placed but only ${stock} in stock`);
});

test('registration rejects junk / incomplete information', async () => {
  const base = {
    first_name: 'Juan', last_name: 'Dela Cruz', email: `t${Date.now()}@example.com`,
    password: 'chomp123', phone: '09171234567',
    street: 'Blk 1 Lot 2 Main St', barangay: 'Santolan', city: 'Pasig',
  };
  const send = async (over) => {
    const cap = await solveCaptcha();
    return call('POST', '/api/auth/register', { body: { ...base, ...over, ...cap } });
  };
  // Each of these must be refused with 400 (no account created)
  assert.equal((await send({ first_name: 'asdf123' })).status, 400, 'numeric name');
  assert.equal((await send({ last_name: 'aaaa' })).status, 400, 'repeated-char name');
  assert.equal((await send({ email: 'notanemail' })).status, 400, 'bad email');
  assert.equal((await send({ phone: '123' })).status, 400, 'junk phone');
  assert.equal((await send({ phone: '' })).status, 400, 'missing phone');
  assert.equal((await send({ street: 'aa' })).status, 400, 'too-short street');
  assert.equal((await send({ barangay: '1111' })).status, 400, 'all-digit barangay');
  assert.equal((await send({ password: 'abcdefgh' })).status, 400, 'password with no number');
});

test('unknown API routes return 404 JSON', async () => {
  const r = await call('GET', '/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.ok(r.data.error);
});
