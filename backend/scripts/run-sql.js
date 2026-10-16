// Runs a .sql file on the database from .env (no MySQL Workbench needed):
//   node scripts/run-sql.js database/11_saved_cart_and_ai_fraud.sql
// Understands DELIMITER $$ blocks (procedures, triggers, functions).
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch { /* optional */ }
const fs = require('fs');
const mysql = require('mysql2/promise');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/run-sql.js database/<file>.sql');
  process.exit(1);
}

function splitStatements(sql) {
  const out = [];
  let delimiter = ';';
  let buf = '';
  for (const line of sql.split(/\r?\n/)) {
    const m = line.trim().match(/^DELIMITER\s+(\S+)/i);
    if (m) { delimiter = m[1]; continue; }
    if (!buf.trim() && line.trim().startsWith('--')) continue;
    buf += line + '\n';
    if (buf.trimEnd().endsWith(delimiter)) {
      const stmt = buf.trimEnd().slice(0, -delimiter.length).trim();
      if (stmt) out.push(stmt);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chompcart',
  });
  const statements = splitStatements(fs.readFileSync(file, 'utf8'));
  console.log(`Running ${statements.length} statement(s) from ${file} ...`);
  for (const [i, stmt] of statements.entries()) {
    try {
      const [result] = await db.query(stmt);
      if (Array.isArray(result) && result.length && !Array.isArray(result[0])) console.table(result);
    } catch (err) {
      console.error(`\nError in statement ${i + 1}:\n${stmt.slice(0, 300)}\n-> ${err.message}`);
      await db.end();
      process.exit(1);
    }
  }
  await db.end();
  console.log('Done. Restart the server (Ctrl + C, then node server.js).');
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
