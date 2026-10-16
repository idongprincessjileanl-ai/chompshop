// Creates the Skyline Market database from schema.sql and upgrade.sql.
// Run once:  node setup-db.js     (MySQL must be running)
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Splits a .sql file into statements, understanding DELIMITER lines (triggers, procedures)
function split(sql) {
  const out = [];
  let delim = ';';
  let buf = '';
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim();
    if (/^DELIMITER\s+/i.test(t)) { delim = t.split(/\s+/)[1]; continue; }
    if (t.startsWith('--') && !buf.trim()) continue;
    buf += line + '\n';
    if (t.endsWith(delim)) {
      const stmt = buf.trim().slice(0, -delim.length).trim();
      if (stmt) out.push(stmt);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function findFile(name) {
  for (const p of [path.join(__dirname, name), path.join(__dirname, 'database', name)]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Cannot find ${name}. Put it in this folder (next to server.js).`);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  for (const name of ['schema.sql', 'upgrade.sql']) {
    const file = findFile(name);
    const statements = split(fs.readFileSync(file, 'utf8'));
    console.log(`Running ${name} (${statements.length} statements)...`);
    for (const s of statements) await conn.query(s);
  }
  // Make sure the picture column exists (older schema.sql files may lack it)
  const [c] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = 'skyline_market' AND table_name = 'products' AND column_name = 'image_url'");
  if (!c[0].n) await conn.query('ALTER TABLE skyline_market.products ADD COLUMN image_url VARCHAR(255) NULL');
  await conn.end();
  console.log('Database ready. Now run: node server.js');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Setup failed:', e.message);
    process.exit(1);
  });
}
module.exports = { split };
