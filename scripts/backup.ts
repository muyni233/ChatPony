import { Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A read-transaction snapshot includes committed WAL pages and preserves rowids. */
export function backupDatabase(
  destination: string,
  source = process.env.DATABASE_PATH || './data/chatpony.db',
): { path: string; bytes: number } {
  if (source === ':memory:') throw new Error('内存数据库不能通过独立备份脚本读取。');
  const input = resolve(source);
  const output = resolve(destination);
  if (input.toLowerCase() === output.toLowerCase())
    throw new Error('备份路径不能与数据库路径相同。');
  if (!existsSync(input) || !statSync(input).isFile())
    throw new Error('源数据库不存在，请检查 DATABASE_PATH。');
  if (existsSync(output)) throw new Error('备份文件已存在。为避免覆盖，请提供一个新文件名。');
  mkdirSync(dirname(output), { recursive: true });
  const db = new Database(input, { readonly: true, strict: true });
  let snapshot: Buffer;
  try {
    db.exec('PRAGMA busy_timeout=10000; BEGIN DEFERRED;');
    const establish = db.prepare('SELECT COUNT(*) FROM sqlite_schema');
    establish.get();
    establish.finalize();
    snapshot = db.serialize();
    db.exec('COMMIT;');
  } finally {
    db.close();
  }

  const partial = `${output}.partial-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(partial, 'wx', 0o600);
    writeFileSync(descriptor, snapshot);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const check = new Database(partial, { readonly: true });
    try {
      const statement = check.prepare('PRAGMA quick_check');
      const results = statement.values();
      statement.finalize();
      if (results.length !== 1 || results[0][0] !== 'ok')
        throw new Error('备份完整性检查失败，未生成最终备份文件。');
    } finally {
      check.close();
    }
    // Creating a hard link is atomic and fails if the destination already exists.
    linkSync(partial, output);
    return { path: output, bytes: snapshot.byteLength };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(partial) && dirname(partial) === dirname(output)) unlinkSync(partial);
  }
}

if (import.meta.main) {
  try {
    const destination = process.argv[2];
    if (!destination || destination === '--help') {
      console.log(
        '用法：bun scripts/backup.ts ./backups/chatpony-2026-10-11.db\n使用 DATABASE_PATH 指定源数据库。可在线备份；不会覆盖已有文件。请同时独立保管 ENCRYPTION_KEY 或开发环境的 .encryption-key。',
      );
      if (!destination) process.exitCode = 1;
    } else {
      const result = backupDatabase(destination);
      console.log(`备份成功：${result.path} (${result.bytes} bytes，完整性检查通过)`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : '备份失败。');
    process.exitCode = 1;
  }
}
