// Links product pictures to products automatically:  node scripts/link-images.js
//
// Looks for pictures anywhere inside frontend/public/ (e.g. images/products/) and matches them to products by
//   1. SKU            e.g.  MCU-001.jpg
//   2. product name   e.g.  "Arduino Uno R3 (CH340 Compatible).jpg"  or  "Arduino Uno R3.png"
//   3. description    e.g.  "Reliable PSU for gaming builds.jpg"
// Then saves the picture path in products.image_url, so the website shows it.
// Add  --dry  to only see the matches without saving.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const PUBLIC = path.join(__dirname, '..', '..', 'frontend', 'public');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);
const SKIP_DIRS = new Set(['uploads']);
const SKIP_FILES = new Set(['logo.jpg', 'logo-chip.png', 'logo-clear.png', 'withbackground.jpg']);
const DRY = process.argv.includes('--dry');

// lower case, letters and numbers only:  "Arduino Uno R3 (CH340)" -> "arduinounor3ch340"
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

function findImages(dir, rel = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) found.push(...findImages(path.join(dir, entry.name), relPath));
    } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(entry.name.toLowerCase())) {
      found.push({ relPath, key: norm(path.basename(entry.name, path.extname(entry.name))) });
    }
  }
  return found;
}

// Higher score = better match. 0 = no match.
function score(product, img) {
  const name = norm(product.product_name);
  const shortName = norm(product.product_name.split(' (')[0]); // name without "(...)"
  if (img.key === norm(product.sku)) return 100;
  if (img.key === name) return 90;
  if (img.key === shortName) return 85;
  if (img.key.length >= 10 && name.startsWith(img.key)) return 70;   // file name cut short
  if (img.key.length >= 10 && img.key.startsWith(shortName)) return 60; // file name has extra words
  if (product.description && img.key === norm(product.description)) return 50; // named after the description
  return 0;
}

(async () => {
  const images = findImages(PUBLIC);
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chompcart',
  });
  const [products] = await db.query('SELECT product_id, sku, product_name, description, image_url FROM products ORDER BY product_id');

  const used = new Set();
  const matched = [];
  const missing = [];
  for (const p of products) {
    let best = null;
    let bestScore = 0;
    for (const img of images) {
      const s = score(p, img);
      if (s > bestScore) { best = img; bestScore = s; }
    }
    if (best) {
      used.add(best.relPath);
      const url = '/' + best.relPath.split('/').map(encodeURIComponent).join('/');
      matched.push({ p, url, file: best.relPath });
    } else {
      missing.push(p);
    }
  }

  console.log(`\nFound ${images.length} picture(s) in frontend/public/\n`);
  console.log(`MATCHED (${matched.length}):`);
  matched.forEach(({ p, file }) => console.log(`  ${p.sku.padEnd(8)} ${p.product_name.padEnd(42)} <- ${file}`));

  if (missing.length) {
    console.log(`\nNO PICTURE FOUND (${missing.length}):  name a file with the SKU or the product name`);
    missing.forEach((p) => console.log(`  ${p.sku.padEnd(8)} ${p.product_name}`));
  }
  const unused = images.filter((i) => !used.has(i.relPath));
  if (unused.length) {
    console.log(`\nPICTURES NOT USED (${unused.length}):  their names do not match any product`);
    unused.forEach((i) => console.log(`  ${i.relPath}`));
  }

  if (DRY) {
    console.log('\n--dry: nothing was saved.');
  } else {
    for (const { p, url } of matched) {
      await db.query('UPDATE products SET image_url = ? WHERE product_id = ?', [url, p.product_id]);
    }
    console.log(`\nSaved ${matched.length} picture link(s). Refresh the website (Ctrl + F5).`);
  }
  await db.end();
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
