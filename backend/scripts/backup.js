// Database backup: npm run backup
// Saves backups/chompcart-YYYY-MM-DD_HHMM.sql (tables, data, views, procedures, triggers). Keeps the newest 14.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch { /* optional */ }
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const findMysqlTool = require('./mysql-bin');

const dir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
const file = path.join(dir, `chompcart-${stamp}.sql`);

const args = [
  '-h', process.env.DB_HOST || '127.0.0.1', '-P', String(process.env.DB_PORT || 3306),
  '-u', process.env.DB_USER || 'root',
  '--databases', process.env.DB_NAME || 'chompcart',
  '--single-transaction', '--routines', '--triggers', '--events', '--set-gtid-purged=OFF',
  '--default-character-set=utf8mb4',
];
const out = fs.createWriteStream(file);
const dump = spawn(findMysqlTool('mysqldump'), args, { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' } });
dump.stdout.pipe(out);
dump.stderr.on('data', (d) => process.stderr.write(d));
dump.on('error', (err) => { console.error('Could not run mysqldump:', err.message, '\nSet MYSQL_BIN in .env to your MySQL bin folder.'); process.exit(1); });
dump.on('close', (code) => {
  out.close();
  if (code !== 0) { fs.unlink(file, () => {}); console.error('Backup FAILED'); process.exit(code); }
  const size = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`Backup saved: ${file} (${size} MB)`);
  const old = fs.readdirSync(dir).filter((f) => /^chompcart-.*\.sql$/.test(f)).sort().reverse().slice(14);
  old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
  if (old.length) console.log(`Removed ${old.length} old backup(s)`);
});
