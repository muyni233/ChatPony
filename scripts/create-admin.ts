/** Optional local recovery utility. Ordinary setup uses the first web registration. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

async function hiddenPassword() {
  if (!stdin.isTTY) throw new Error('请在交互式终端中运行，以安全输入密码。');
  stdout.write('新密码（10–128 字符，输入不可见）：');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolvePassword, reject) => {
    let value = '';
    const onData = (buffer: Buffer) => {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('操作已取消。'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolvePassword(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < 128) value += character;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    stdin.on('data', onData);
  });
}

const rl = createInterface({ input: stdin, output: stdout });
console.log('ChatPony 本地管理员恢复工具。常规安装请直接注册首个账号。');
const email = (argument('email') || (await rl.question('管理员邮箱：'))).trim().toLowerCase();
const username = (argument('username') || (await rl.question('管理员用户名：'))).trim();
const confirm = await rl.question(
  '此操作将创建管理员或重置该邮箱账号的密码并授予管理员权限。输入 YES 继续：',
);
rl.close();
if (confirm !== 'YES') {
  console.log('操作已取消。');
  process.exit(0);
}
if (
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  email.length > 254 ||
  username.length < 2 ||
  username.length > 32
)
  throw new Error('邮箱或用户名格式无效。');
const password = await hiddenPassword();
if (password.length < 10 || password.length > 128) throw new Error('密码需要 10–128 个字符。');
const salt = randomBytes(16).toString('hex');
const encoded = `scrypt:${salt}:${((await promisify(scrypt)(password, salt, 64)) as Buffer).toString('hex')}`;
const path = resolve(process.env.DATABASE_PATH || 'data/chatpony.sqlite');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path);
db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),disabled INTEGER NOT NULL DEFAULT 0,email_verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);`);
const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
if (!columns.some((column) => column.name === 'email_verified'))
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
db.exec('BEGIN IMMEDIATE');
try {
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email) as
    { id: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE users SET username=?,password_hash=?,role='admin',disabled=0,email_verified=1 WHERE id=?",
    ).run(username, encoded, existing.id);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get())
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
  } else
    db.prepare(
      "INSERT INTO users(id,username,email,password_hash,role,email_verified,created_at) VALUES (?,?,?,?,'admin',1,?)",
    ).run(randomUUID(), username, email, encoded, new Date().toISOString());
  db.exec('COMMIT');
  console.log('管理员账号已就绪，请在网页登录。');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
