import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { getDb, closeDb, now } from '../../src/lib/db';
import { toUser, type Row } from '../../src/lib/mappers';
import { summarizeMemories } from '../../src/lib/ai/maintenance';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory);
process.env.DATABASE_PATH = join(directory, 'maintenance-legacy.db');
process.env.ENCRYPTION_KEY = 'b7'.repeat(32);
const timestamp = now();

try {
  const legacy = getDb();
  legacy
    .query(
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('user','u@example.test','User','unused',?)",
    )
    .run(timestamp);
  legacy
    .query(
      "INSERT INTO suppliers(id,name,protocol,base_url,created_at) VALUES('supplier','Supplier','openai-completions','https://example.test/v1',?)",
    )
    .run(timestamp);
  legacy
    .query(
      "INSERT INTO providers(id,name,protocol,supplier_id,model,created_at) VALUES('model','Model','openai-completions','supplier','test-model',?)",
    )
    .run(timestamp);
  legacy
    .query(
      "INSERT INTO characters(id,name,slug,personality,provider_id,active,created_at) VALUES('character','Character','character','Role','model',1,?)",
    )
    .run(timestamp);
  const conversation = legacy.query(
    "INSERT INTO conversations(id,user_id,title,kind,character_ids,created_at,updated_at) VALUES(?,'user','Conversation','private','[\"character\"]',?,?)",
  );
  for (const key of ['conversation-one', 'conversation-two'])
    conversation.run(key, timestamp, timestamp);
  const message = legacy.query(
    'INSERT INTO messages(rowid,id,conversation_id,role,character_id,content,created_at) VALUES(?,?,?,?,?,?,?)',
  );
  message.run(10, 'greeting', 'conversation-one', 'assistant', 'character', 'Greeting', timestamp);
  message.run(20, 'user-one', 'conversation-one', 'user', null, 'One', timestamp);
  message.run(
    30,
    'assistant-one',
    'conversation-one',
    'assistant',
    'character',
    'First generated reply',
    timestamp,
  );
  message.run(40, 'user-two', 'conversation-two', 'user', null, 'Two', timestamp);
  message.run(
    45,
    'untracked-assistant',
    'conversation-two',
    'assistant',
    'character',
    'Not a successful generated response',
    timestamp,
  );
  message.run(
    50,
    'assistant-two',
    'conversation-two',
    'assistant',
    'character',
    'Second generated reply',
    timestamp,
  );
  const request = legacy.query(
    "INSERT INTO chat_requests(conversation_id,request_id,user_message_id,status,response_ids,rounds,created_at,updated_at) VALUES(?,?,?,'complete',?,1,?,?)",
  );
  request.run(
    'conversation-one',
    'request-one',
    'user-one',
    '["assistant-one"]',
    timestamp,
    timestamp,
  );
  request.run(
    'conversation-two',
    'request-two',
    'user-two',
    '["assistant-two"]',
    timestamp,
    timestamp,
  );
  request.run(
    'conversation-two',
    'invalid-old-json',
    'user-two',
    'not valid json',
    timestamp,
    timestamp,
  );
  legacy.exec(
    'DROP TABLE memory_summary_state; DROP TABLE memory_summary_events; PRAGMA user_version=8;',
  );
  closeDb();
  const db = getDb();
  const events = db.query('SELECT * FROM memory_summary_events ORDER BY seq').all() as Row[];
  assert.deepEqual(
    events.map((event) => event.message_id),
    ['assistant-one', 'assistant-two'],
  );
  assert.ok(
    events.every((event) => event.user_id === 'user' && event.character_id === 'character'),
  );
  const cursor = Number(events.at(-1)!.seq);
  db.query(
    "INSERT INTO memory_summary_state(user_id,character_id,last_event_seq,updated_at) VALUES('user','character',?,?)",
  ).run(cursor, timestamp);
  db.query("DELETE FROM conversations WHERE id='conversation-two'").run();
  db.query(
    "INSERT INTO messages(id,conversation_id,role,character_id,content,created_at) VALUES('new-after-delete','conversation-one','assistant','character','New reply',?)",
  ).run(timestamp);
  const rawRowid = Number(
    (db.query("SELECT rowid AS seq FROM messages WHERE id='new-after-delete'").get() as Row).seq,
  );
  assert.ok(rawRowid < 50);
  db.query(
    "INSERT INTO memory_summary_events(message_id,user_id,character_id,created_at) VALUES('new-after-delete','user','character',?)",
  ).run(timestamp);
  const event = db
    .query("SELECT seq FROM memory_summary_events WHERE message_id='new-after-delete'")
    .get() as Row;
  assert.ok(Number(event.seq) > cursor);
  assert.equal(
    (
      db
        .query(
          "SELECT last_event_seq FROM memory_summary_state WHERE user_id='user' AND character_id='character'",
        )
        .get() as Row
    ).last_event_seq,
    cursor,
  );
  assert.deepEqual(db.query('PRAGMA foreign_key_check').all(), []);
  // A version-10 database receives only an additive pending-batch column.
  // Existing memory cursors and message/event sequences must remain untouched.
  db.exec(
    'ALTER TABLE memory_summary_state DROP COLUMN pending_through_seq; PRAGMA user_version=10;',
  );
  closeDb();
  const migrated = getDb();
  assert.equal((migrated.query('PRAGMA user_version').get() as Row).user_version, 13);
  assert.deepEqual(
    migrated
      .query(
        "SELECT last_event_seq,pending_through_seq FROM memory_summary_state WHERE user_id='user' AND character_id='character'",
      )
      .get(),
    { last_event_seq: cursor, pending_through_seq: 0 },
  );
  migrated.query("UPDATE settings SET value='100' WHERE key='memorySummaryInterval'").run();
  migrated
    .query(
      "UPDATE memory_summary_state SET pending_through_seq=?,lock_token='interrupted-process',lock_expires_at=? WHERE user_id='user' AND character_id='character'",
    )
    .run(Number(event.seq), '2000-01-01T00:00:00.000Z');
  closeDb();
  // After a restart and expired lease, one remaining event resumes even though
  // it is below the newly configured interval of 100.
  const restarted = getDb();
  assert.equal(
    (
      restarted
        .query(
          "SELECT pending_through_seq FROM memory_summary_state WHERE user_id='user' AND character_id='character'",
        )
        .get() as Row
    ).pending_through_seq,
    event.seq,
  );
  assert.ok(
    await summarizeMemories({
      user: toUser(restarted.query("SELECT * FROM users WHERE id='user'").get() as Row),
      characterId: 'character',
      conversationId: 'conversation-one',
      requestId: 'restart-summary',
      resolveModel: () => {
        throw new Error('Local summaries must not request a provider');
      },
      status: () => {},
    }),
  );
  assert.deepEqual(
    restarted
      .query(
        "SELECT last_event_seq,pending_through_seq,lock_token FROM memory_summary_state WHERE user_id='user' AND character_id='character'",
      )
      .get(),
    { last_event_seq: event.seq, pending_through_seq: 0, lock_token: null },
  );
  assert.equal(
    (getDb().query('SELECT COUNT(*) AS count FROM memory_summary_events').get() as Row).count,
    2,
  );
  console.log('Maintenance migration passed');
} finally {
  closeDb();
}
