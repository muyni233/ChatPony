import { createInterface } from 'node:readline/promises';
import { getDb, id, now, closeDb } from '../src/lib/db';
import { validEmail, validName, validPassword } from '../src/lib/auth';
import { getSettings } from '../src/lib/repository';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function hiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('非交互环境请设置 CHATPONY_ADMIN_PASSWORD 环境变量。');
  process.stdout.write(label);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish(new Error('已取消。'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 129) value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      '创建管理员：bun run admin:create --email admin@example.com --name 管理员\n密码将安全地交互输入，也可通过 CHATPONY_ADMIN_PASSWORD 环境变量提供。已有账号不会被覆盖。',
    );
    return;
  }
  if (process.argv.includes('--password'))
    throw new Error('请使用安全的密码提示或 CHATPONY_ADMIN_PASSWORD，避免密码出现在命令历史中。');
  let emailInput = option('--email');
  let nameInput = option('--name');
  if (!emailInput) {
    if (!process.stdin.isTTY) throw new Error('请通过 --email 提供管理员邮箱。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    emailInput = await prompt.question('管理员邮箱：');
    nameInput ??= (await prompt.question('昵称（默认：管理员）：')) || '管理员';
    prompt.close();
  }
  const email = validEmail(emailInput);
  const name = validName(nameInput || '管理员');
  const supplied = process.env.CHATPONY_ADMIN_PASSWORD;
  delete process.env.CHATPONY_ADMIN_PASSWORD;
  const password = validPassword(
    supplied || (await hiddenPassword('管理员密码（至少 10 位，不显示输入）：')),
  );
  if (!supplied && password !== (await hiddenPassword('再次输入密码：')))
    throw new Error('两次密码不一致。');
  const db = getDb();
  if (db.query('SELECT id FROM users WHERE email=?').get(email))
    throw new Error(
      '此邮箱已存在。脚本不会覆盖或提升已有账号权限，请使用另一邮箱或由现有管理员操作。',
    );
  const passwordHash = await Bun.password.hash(password, {
    algorithm: 'argon2id',
    memoryCost: 19456,
    timeCost: 2,
  });
  const settings = getSettings();
  db.query(
    "INSERT INTO users(id,email,name,password_hash,role,limit_5h,limit_7d,created_at) VALUES(?,?,?,?,'admin',?,?,?)",
  ).run(id(), email, name, passwordHash, settings.defaultLimit5h, settings.defaultLimit7d, now());
  console.log(`管理员已创建：${email}。现在可在登录页面登录。`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : '管理员创建失败。');
  process.exitCode = 1;
} finally {
  closeDb();
}
