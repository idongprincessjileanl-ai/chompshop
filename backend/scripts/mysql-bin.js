// Finds mysql / mysqldump: MYSQL_BIN in .env, then the PATH, then the usual Windows install folders
const fs = require('fs');
const path = require('path');

module.exports = function findMysqlTool(tool) {
  const exe = process.platform === 'win32' ? tool + '.exe' : tool;
  if (process.env.MYSQL_BIN) return path.join(process.env.MYSQL_BIN, exe);
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\MySQL', 'C:\\Program Files (x86)\\MySQL']) {
      if (!fs.existsSync(base)) continue;
      const servers = fs.readdirSync(base).filter((d) => d.startsWith('MySQL Server')).sort().reverse();
      for (const s of servers) {
        const candidate = path.join(base, s, 'bin', exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return exe; // hope it is on the PATH
};
