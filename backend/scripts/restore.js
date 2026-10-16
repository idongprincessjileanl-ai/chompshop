// Restore the database from a backup: npm run restore -- --yes [file]
// Without a file name, the newest backup in backups/ is used. This REPLACES the current data.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch { /* optional */ }
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const findMysqlTool = require('./mysql-bin');

const args = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'backups');
let file = args.find((a) => !a.startsWith('--'));
if (!file) {
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^chompcart-.*\.sql$/.test(f)).sort() : [];
  if (!all.length) { console.error('No backups found in', dir); process.exit(1); }
  file = path.join(dir, all[all.length - 1]);
}
if (!fs.existsSync(file)) { console.error('File not found:', file); process.exit(1); }
if (!args.includes('--yes')) {
  console.log(`This will REPLACE the database with:\n  ${file}\nRun again with --yes to continue:  npm run restore -- --yes`);
  process.exit(0);
}

console.log('Restoring from', file, '...');
const mysql = spawn(findMysqlTool('mysql'), [
  '-h', process.env.DB_HOST || '127.0.0.1', '-P', String(process.env.DB_PORT || 3306),
  '-u', process.env.DB_USER || 'root', '--default-character-set=utf8mb4',
], { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' } });
fs.createReadStream(file).pipe(mysql.stdin);
mysql.stderr.on('data', (d) => process.stderr.write(d));
mysql.on('error', (err) => { console.error('Could not run mysql:', err.message); process.exit(1); });
mysql.on('close', (code) => {
  if (code === 0) console.log('Restore complete. Restart the server: node server.js');
  else console.error('Restore FAILED (code ' + code + ')');
  process.exit(code);
});
