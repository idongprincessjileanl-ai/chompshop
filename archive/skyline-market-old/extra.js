// Extra routes: shopping cart, checkout, shipment lookup, semantic search, recommendations
module.exports = (app, pool, wrap) => {
  async function cartDetails(id) {
    const [items] = await pool.query(
      `SELECT ci.cart_item_id, p.product_id, p.name, p.price, p.image_url, ci.quantity,
              p.price * ci.quantity AS line_total
       FROM cart_items ci JOIN products p ON p.product_id = ci.product_id
       WHERE ci.cart_id = ? ORDER BY ci.cart_item_id`, [id]);
    const total = items.reduce((s, i) => s + Number(i.line_total), 0);
    return { cart_id: Number(id), items, total };
  }

  app.get('/api/carts/:id/details', wrap(async (req, res) => res.json(await cartDetails(req.params.id))));

  app.post('/api/carts/:id/add', wrap(async (req, res) => {
    const { product_id, quantity = 1 } = req.body || {};
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    await pool.query(
      `INSERT INTO cart_items(cart_id, product_id, quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [req.params.id, product_id, Number(quantity)]);
    res.status(201).json(await cartDetails(req.params.id));
  }));

  // Checkout calls the stored procedure (order + items + shipment in one transaction)
  app.post('/api/carts/:id/checkout', wrap(async (req, res) => {
    const [results] = await pool.query('CALL sp_checkout_cart(?)', [req.params.id]);
    const orderId = results[0][0].order_id;
    const [ship] = await pool.query('SELECT * FROM shipments WHERE order_id = ?', [orderId]);
    res.status(201).json({ order_id: orderId, shipment: ship[0] });
  }));

  app.get('/api/orders/:id/shipment', wrap(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM shipments WHERE order_id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No shipment for this order' });
    res.json(rows[0]);
  }));

  app.get('/api/vendors/:id/products', wrap(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM products WHERE vendor_id = ?', [req.params.id]);
    res.json(rows);
  }));

  // ---- Semantic search: describe what you want instead of exact keywords ----
  // Relevance = TF-IDF over name + description + category, plus a concept map that
  // expands words ("music" -> earbuds, headphones). Add more concepts as needed.
  const CONCEPTS = {
    music: ['audio', 'earbuds', 'headphones', 'speaker'], listen: ['audio', 'earbuds', 'headphones'],
    workout: ['earbuds', 'sport', 'fitness'], call: ['earbuds', 'phone'],
    coffee: ['mug', 'cup'], tea: ['mug', 'cup'], drink: ['mug', 'cup', 'bottle'],
    carry: ['bag', 'tote', 'backpack'], shopping: ['bag', 'tote'], grocery: ['bag', 'tote'],
    wear: ['shirt', 'jacket', 'shoe'], gift: ['set', 'mug'], kitchen: ['mug', 'cup', 'plate'],
  };
  const STOP = new Set(['a', 'an', 'the', 'for', 'to', 'of', 'and', 'or', 'with', 'in', 'on', 'my', 'i', 'want', 'need', 'something', 'that', 'can', 'is', 'it']);
  const toks = (s) => (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => !STOP.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, '') : w));

  app.get('/api/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const [products] = await pool.query(
      `SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.category_id = p.category_id`);
    const docs = products.map((p) => toks(`${p.name} ${p.description || ''} ${p.category}`));
    const N = docs.length;
    const df = {};
    docs.forEach((d) => new Set(d).forEach((t) => (df[t] = (df[t] || 0) + 1)));
    const terms = {};
    toks(q).forEach((t) => {
      terms[t] = 1;
      (CONCEPTS[t] || []).forEach((x) => { const k = toks(x)[0]; if (!terms[k]) terms[k] = 0.5; });
    });
    const scored = products.map((p, i) => {
      let score = 0;
      for (const [t, w] of Object.entries(terms)) {
        const tf = docs[i].filter((x) => x === t).length;
        if (tf) score += w * tf * Math.log(1 + N / (1 + (df[t] || 0)));
      }
      return { ...p, score: Math.round(score * 100) / 100 };
    }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
    res.json(scored);
  }));

  // ---- Recommendations ----
  app.get('/api/recommendations/product/:id', wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT p.*, COUNT(*) AS bought_together
       FROM order_items a
       JOIN order_items b ON b.order_id = a.order_id AND b.product_id <> a.product_id
       JOIN products p ON p.product_id = b.product_id
       WHERE a.product_id = ? GROUP BY p.product_id ORDER BY bought_together DESC LIMIT 5`,
      [req.params.id]);
    res.json(rows);
  }));

  app.get('/api/recommendations/customer/:id', wrap(async (req, res) => {
    const id = req.params.id;
    const bought = `SELECT oi.product_id FROM orders o JOIN order_items oi ON oi.order_id = o.order_id WHERE o.customer_id = ?`;
    const popular = `(SELECT product_id, SUM(quantity) AS units FROM order_items GROUP BY product_id) pop`;
    // 1) popular items from categories this customer already buys, not yet purchased
    let [rows] = await pool.query(
      `SELECT p.*, COALESCE(pop.units, 0) AS popularity FROM products p
       LEFT JOIN ${popular} ON pop.product_id = p.product_id
       WHERE p.category_id IN (SELECT DISTINCT p2.category_id FROM orders o
             JOIN order_items oi ON oi.order_id = o.order_id
             JOIN products p2 ON p2.product_id = oi.product_id WHERE o.customer_id = ?)
         AND p.product_id NOT IN (${bought})
       ORDER BY popularity DESC LIMIT 5`, [id, id]);
    // 2) fallback: best sellers the customer has not bought
    if (!rows.length) {
      [rows] = await pool.query(
        `SELECT p.*, COALESCE(pop.units, 0) AS popularity FROM products p
         LEFT JOIN ${popular} ON pop.product_id = p.product_id
         WHERE p.product_id NOT IN (${bought}) ORDER BY popularity DESC LIMIT 5`, [id]);
    }
    res.json(rows);
  }));
};
