import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { backupDatabase } from '../../scripts/backup';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
const source = join(directory, 'source.db');
const destination = join(directory, 'backup.db');
const db = new Database(source, { create: true });
try {
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(id TEXT PRIMARY KEY,content TEXT);',
  );
  db.query("INSERT INTO messages(rowid,id,content) VALUES(1,'first','old')").run();
  db.query("INSERT INTO messages(rowid,id,content) VALUES(417,'latest','committed in WAL')").run();
  assert.ok(statSync(`${source}-wal`).size > 0);
  const result = backupDatabase(destination, source);
  assert.ok(result.bytes > 0);
  const backup = new Database(destination, { readonly: true });
  try {
    assert.deepEqual(
      backup.query('SELECT rowid AS sequence,id,content FROM messages ORDER BY rowid').all(),
      [
        { sequence: 1, id: 'first', content: 'old' },
        { sequence: 417, id: 'latest', content: 'committed in WAL' },
      ],
    );
  } finally {
    backup.close();
  }
  assert.throws(() => backupDatabase(destination, source), /已存在/);
  assert.throws(() => backupDatabase(source, source), /相同/);
  assert.throws(
    () => backupDatabase(join(directory, 'missing-copy.db'), join(directory, 'missing.db')),
    /不存在/,
  );
  console.log('Backup check passed');
} finally {
  db.close();
}
