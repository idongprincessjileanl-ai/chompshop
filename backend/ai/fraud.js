// Chomp Shop AI fraud check for payments
// ------------------------------------------------------------
// How it works:
//   1. For each order we measure "features" (signals), e.g. how big the order is compared to
//      the customer's usual orders, how many orders they placed in the last 24 hours, etc.
//   2. A logistic-regression model (a basic machine-learning model) is TRAINED on past orders:
//      orders that were cancelled / failed / refunded = "bad", paid / shipped / delivered = "good".
//   3. Expert rules give a second opinion, so the check still works when there is little history.
//   4. Final risk score 0-100 = blend of the model and the rules  ->  LOW / MEDIUM / HIGH,
//      with the top reasons written in plain words for the staff.
// Everything runs inside the server. No outside service or API key is needed.

const FEATURES = [
  { key: 'amountVsUsual', label: 'Order is much bigger than this customer usually spends' },
  { key: 'logAmount', label: 'High order amount' },
  { key: 'firstOrder', label: "Customer's first order" },
  { key: 'newAccount', label: 'Account was created less than 24 hours ago' },
  { key: 'velocity24h', label: 'Many orders from this customer in the last 24 hours' },
  { key: 'pastBadRate', label: 'Customer has cancelled / failed orders before' },
  { key: 'codHighValue', label: 'Large Cash-on-Delivery order' },
  { key: 'card', label: 'Card payment (chargeback risk)' },
  { key: 'bigQuantity', label: 'Unusually many items' },
  { key: 'lateNight', label: 'Placed between 12 AM and 5 AM' },
  { key: 'failedLogins', label: 'Recent wrong-password attempts on this account' },
];

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- 1. Features ----------
// ctx = { amount, method, quantity, hour, accountAgeHours, failedLogins,
//         history: [{ amount, bad }]  (the customer's EARLIER orders), ordersLast24h }
function features(ctx) {
  const prev = ctx.history || [];
  const prevAvg = prev.length ? prev.reduce((s, o) => s + o.amount, 0) / prev.length : null;
  const ratio = prevAvg ? ctx.amount / Math.max(prevAvg, 1) : 1;
  const bad = prev.filter((o) => o.bad).length;
  return {
    amountVsUsual: clamp(Math.log2(Math.max(ratio, 1)), 0, 5),           // 0 = normal, 1 = 2x, 2 = 4x ...
    logAmount: clamp(Math.log10(Math.max(ctx.amount, 1)) - 3, 0, 3),      // 0 below P1,000
    firstOrder: prev.length === 0 ? 1 : 0,
    newAccount: ctx.accountAgeHours != null && ctx.accountAgeHours < 24 ? 1 : 0,
    velocity24h: clamp(ctx.ordersLast24h || 0, 0, 6),
    pastBadRate: prev.length ? bad / prev.length : 0,
    codHighValue: ctx.method === 'COD' ? clamp((ctx.amount - 5000) / 10000, 0, 2) : 0,
    card: ctx.method === 'CARD' ? 1 : 0,
    bigQuantity: clamp((ctx.quantity - 5) / 5, 0, 3),
    lateNight: ctx.hour >= 0 && ctx.hour < 5 ? 1 : 0,
    failedLogins: clamp(ctx.failedLogins || 0, 0, 5),
  };
}

// ---------- 2. Expert rules (points out of 100) ----------
const RULE_POINTS = {
  amountVsUsual: 14, logAmount: 6, firstOrder: 8, newAccount: 14, velocity24h: 9,
  pastBadRate: 30, codHighValue: 14, card: 4, bigQuantity: 6, lateNight: 6, failedLogins: 7,
};
function ruleScore(f) {
  let s = 0;
  for (const k of Object.keys(RULE_POINTS)) s += RULE_POINTS[k] * f[k];
  return clamp(s, 0, 100);
}

// ---------- 3. Machine-learning model (logistic regression) ----------
let model = null; // { weights, bias, mean, std, samples, badRate, accuracy, trainedAt, version }

function train(samples) {
  // samples: [{ f: features, bad: 0|1 }]
  const keys = FEATURES.map((x) => x.key);
  const n = samples.length;
  const positives = samples.filter((s) => s.bad).length;
  if (n < 30 || positives < 3 || positives === n) {
    model = { weights: null, samples: n, badRate: n ? positives / n : 0, trainedAt: new Date().toISOString(),
      version: 'rules-only', note: 'Not enough past orders to train yet; using expert rules.' };
    return model;
  }
  const X = samples.map((s) => keys.map((k) => s.f[k]));
  const mean = keys.map((_, j) => X.reduce((a, r) => a + r[j], 0) / n);
  const std = keys.map((_, j) => Math.sqrt(X.reduce((a, r) => a + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  const y = samples.map((s) => (s.bad ? 1 : 0));
  // class weights so the rare "bad" orders are not ignored
  const wPos = n / (2 * positives), wNeg = n / (2 * (n - positives));

  let w = new Array(keys.length).fill(0), b = 0;
  const lr = 0.1, l2 = 0.01;
  for (let epoch = 0; epoch < 400; epoch++) {
    const gw = new Array(keys.length).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(Z[i].reduce((a, v, j) => a + v * w[j], b));
      const err = (p - y[i]) * (y[i] ? wPos : wNeg);
      for (let j = 0; j < w.length; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    w = w.map((wj, j) => wj - lr * (gw[j] / n + l2 * wj));
    b -= lr * (gb / n);
  }
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const p = sigmoid(Z[i].reduce((a, v, j) => a + v * w[j], b));
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
  }
  model = {
    weights: Object.fromEntries(keys.map((k, j) => [k, Number(w[j].toFixed(4))])),
    bias: b, mean, std, samples: n, badRate: positives / n, accuracy: correct / n,
    trainedAt: new Date().toISOString(), version: 'logreg-' + new Date().toISOString().slice(0, 10),
  };
  return model;
}

function modelProbability(f) {
  if (!model || !model.weights) return null;
  const keys = FEATURES.map((x) => x.key);
  const z = keys.reduce((a, k, j) => a + ((f[k] - model.mean[j]) / model.std[j]) * model.weights[k], model.bias);
  return sigmoid(z);
}

// ---------- 4. Final score ----------
function score(ctx) {
  const f = features(ctx);
  const rules = ruleScore(f);
  const p = modelProbability(f);
  // The model is trusted more when it has more data
  const trust = p == null ? 0 : clamp(model.samples / 500, 0.2, 0.6);
  const value = Math.round(clamp((1 - trust) * rules + trust * (p ?? 0) * 100, 0, 100));
  const level = value >= 60 ? 'HIGH' : value >= 30 ? 'MEDIUM' : 'LOW';

  // Reasons: the signals that added the most to the score
  const contrib = FEATURES.map(({ key, label }) => ({
    label,
    points: RULE_POINTS[key] * f[key] + (p == null || !model.weights[key] ? 0
      : Math.max(0, model.weights[key] * ((f[key] - model.mean[FEATURES.findIndex((x) => x.key === key)])
        / model.std[FEATURES.findIndex((x) => x.key === key)])) * 10),
  })).filter((c) => c.points >= 3).sort((a, b) => b.points - a.points).slice(0, 3);
  const reasons = contrib.length ? contrib.map((c) => c.label).join('; ') : 'Normal order for this customer';

  return { score: value, level, reasons, features: f, rules, model: p == null ? null : Math.round(p * 100),
    version: model ? model.version : 'rules-only' };
}

const getModel = () => model;

module.exports = { features, train, score, getModel, FEATURES };
