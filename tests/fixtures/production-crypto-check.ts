import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encrypt, decrypt } from '../../src/lib/crypto';
import { getDb, closeDb } from '../../src/lib/db';
import { AppError, errorResponse } from '../../src/lib/errors';
import { saveSupplier } from '../../src/lib/repository';
import { POST } from '../../src/app/api/[...path]/route';
import { createSession } from '../../src/lib/auth';
import type { Row } from '../../src/lib/mappers';

const directory = process.env.CHATPONY_TEST_DIR;
assert.ok(directory, 'An isolated fixture directory is required');
const mode = process.argv[2];
const keyPath = join(directory, '.encryption-key');
const statePath = join(directory, 'crypto-state.json');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const writeState = (value: unknown) =>
  writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 });
type State = { supplierId: string; initial: string; replacement: string; keyDigest: string };

async function verifySafeError(
  operation: () => unknown,
  expectedCode: string,
  forbidden: string[] = [],
) {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AppError, 'Expected a safe application error');
  assert.equal(failure.status, 503);
  assert.equal(failure.code, expectedCode);
  const response = errorResponse(failure);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(body.includes(expectedCode), 'The API must preserve the safe error code');
  assert.ok(
    forbidden.every((value) => !body.includes(value)),
    'The error must not expose credentials',
  );
}

try {
  if (mode === 'create') {
    assert.equal(process.env.NODE_ENV, 'development');
    assert.equal(existsSync(keyPath), false);
    const initial = randomBytes(28).toString('base64url');
    const replacement = randomBytes(28).toString('base64url');
    const supplier = saveSupplier(null, {
      name: 'Persistent fixture',
      protocol: 'openai-completions',
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: initial,
    });
    const ciphertext = String(
      (getDb().query('SELECT api_key FROM suppliers WHERE id=?').get(supplier.id) as Row).api_key,
    );
    assert.ok(decrypt(ciphertext) === initial, 'Development credential did not round-trip');
    assert.equal(readFileSync(keyPath).byteLength, 32);
    writeState({
      supplierId: supplier.id,
      initial,
      replacement,
      keyDigest: digest(readFileSync(keyPath)),
    });
    console.log('Crypto create passed');
  } else if (mode === 'update' || mode === 'restart') {
    assert.equal(process.env.NODE_ENV, 'production');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as State;
    const ciphertext = String(
      (getDb().query('SELECT api_key FROM suppliers WHERE id=?').get(state.supplierId) as Row)
        .api_key,
    );
    const expected = mode === 'update' ? state.initial : state.replacement;
    assert.ok(
      decrypt(ciphertext) === expected,
      'Credential was not readable across process/build changes',
    );
    assert.ok(
      digest(readFileSync(keyPath)) === state.keyDigest,
      'Persisted key unexpectedly changed',
    );
    if (mode === 'update') {
      const supplier = saveSupplier(state.supplierId, { apiKey: state.replacement });
      assert.equal(supplier.hasKey, true);
      const updated = String(
        (getDb().query('SELECT api_key FROM suppliers WHERE id=?').get(state.supplierId) as Row)
          .api_key,
      );
      assert.ok(
        decrypt(updated) === state.replacement,
        'Production credential update did not round-trip',
      );
    }
    console.log(`Crypto ${mode} passed`);
  } else if (mode === 'concurrent') {
    const worker = Number(process.env.CHATPONY_CRYPTO_WORKER);
    assert.ok(Number.isInteger(worker) && worker >= 0 && worker < 8);
    const remaining = Number(process.env.CHATPONY_CRYPTO_BARRIER) - Date.now();
    if (remaining > 0) await Bun.sleep(remaining);
    const plaintext = `concurrent fixture ${worker}`;
    const ciphertext = encrypt(plaintext);
    assert.ok(
      decrypt(ciphertext) === plaintext,
      'Concurrent creator could not use the published key',
    );
    writeFileSync(
      join(directory, `worker-${worker}.json`),
      JSON.stringify({ ciphertext, keyDigest: digest(readFileSync(keyPath)) }),
      { flag: 'wx', mode: 0o600 },
    );
    console.log('Concurrent crypto worker passed');
  } else if (mode === 'verify-concurrent') {
    const key = readFileSync(keyPath);
    assert.equal(key.byteLength, 32);
    for (let worker = 0; worker < 8; worker++) {
      const record = JSON.parse(readFileSync(join(directory, `worker-${worker}.json`), 'utf8')) as {
        ciphertext: string;
        keyDigest: string;
      };
      assert.ok(
        record.keyDigest === digest(key),
        'Concurrent workers used different persistent keys',
      );
      assert.ok(
        decrypt(record.ciphertext) === `concurrent fixture ${worker}`,
        'Fresh process could not decrypt a concurrent worker result',
      );
    }
    assert.ok(
      !readdirSync(directory).some((file) => file.endsWith('.tmp')),
      'Temporary key files were left behind',
    );
    console.log('Concurrent crypto verification passed');
  } else if (mode === 'invalid') {
    const probe = randomBytes(18).toString('base64url');
    for (const length of [0, 1, 31, 33, 64]) {
      const target = join(directory, `invalid-file-${length}`);
      mkdirSync(target);
      process.env.DATABASE_PATH = join(target, 'test.db');
      process.env.ENCRYPTION_KEY = '';
      const invalidPath = join(target, '.encryption-key');
      const invalid = randomBytes(length);
      writeFileSync(invalidPath, invalid);
      const before = digest(readFileSync(invalidPath));
      await verifySafeError(() => encrypt(probe), 'ENCRYPTION_KEY_FILE_INVALID', [probe]);
      assert.ok(
        digest(readFileSync(invalidPath)) === before,
        'Damaged persistent key was overwritten',
      );
      assert.equal(readdirSync(target).length, 1);
    }
    const validDirectory = join(directory, 'valid-file');
    mkdirSync(validDirectory);
    process.env.DATABASE_PATH = join(validDirectory, 'test.db');
    process.env.ENCRYPTION_KEY = '';
    const ciphertext = encrypt(probe);
    const validPath = join(validDirectory, '.encryption-key');
    const before = digest(readFileSync(validPath));
    for (const invalidEnvironment of [
      'invalid-key-format',
      'a'.repeat(63),
      'g'.repeat(64),
      randomBytes(31).toString('base64'),
      'A'.repeat(44),
    ]) {
      process.env.ENCRYPTION_KEY = invalidEnvironment;
      await verifySafeError(() => encrypt(probe), 'ENCRYPTION_KEY_INVALID', [
        probe,
        invalidEnvironment,
      ]);
      await verifySafeError(() => decrypt(ciphertext), 'ENCRYPTION_KEY_INVALID', [
        probe,
        invalidEnvironment,
      ]);
      assert.ok(
        digest(readFileSync(validPath)) === before,
        'Invalid override replaced the persisted key',
      );
    }
    process.env.ENCRYPTION_KEY = '';
    assert.ok(
      decrypt(ciphertext) === probe,
      'Persistent key did not recover after removing invalid override',
    );

    const explicitDirectory = join(directory, 'explicit-key');
    mkdirSync(explicitDirectory);
    process.env.DATABASE_PATH = join(explicitDirectory, 'test.db');
    const explicit = randomBytes(32);
    process.env.ENCRYPTION_KEY = explicit.toString('hex');
    const explicitCiphertext = encrypt(probe);
    process.env.ENCRYPTION_KEY = explicit.toString('base64');
    assert.ok(
      decrypt(explicitCiphertext) === probe,
      'Equivalent hex/Base64 overrides are incompatible',
    );
    assert.equal(existsSync(join(explicitDirectory, '.encryption-key')), false);

    const inaccessible = join(directory, 'key-is-directory');
    mkdirSync(inaccessible);
    mkdirSync(join(inaccessible, '.encryption-key'));
    process.env.DATABASE_PATH = join(inaccessible, 'test.db');
    process.env.ENCRYPTION_KEY = '';
    await verifySafeError(() => encrypt(probe), 'ENCRYPTION_KEY_READ_FAILED', [probe]);
    assert.equal(readdirSync(join(inaccessible, '.encryption-key')).length, 0);

    // A validly formatted but incorrect override must fail without returning the
    // ciphertext, key or provider credential through the actual admin API.
    process.env.DATABASE_PATH = join(validDirectory, 'test.db');
    process.env.ENCRYPTION_KEY = '';
    const supplier = saveSupplier(null, {
      name: 'Wrong-key fixture',
      protocol: 'openai-completions',
      baseUrl: 'https://never-contact.invalid/v1',
      apiKey: probe,
    });
    const db = getDb();
    db.query(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('admin','admin@fixture.test','Admin','unused','admin',?)",
    ).run(new Date().toISOString());
    db.query(
      "INSERT INTO providers(id,name,protocol,supplier_id,model,created_at) VALUES('model','Model','openai-completions',?,'test-model',?)",
    ).run(supplier.id, new Date().toISOString());
    const session = createSession('admin');
    const wrongKey = randomBytes(32).toString('hex');
    process.env.ENCRYPTION_KEY = wrongKey;
    const response = await POST(
      new Request('http://fixture.test/api/admin/models/model/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.split(';')[0] },
      }),
      { params: Promise.resolve({ path: ['admin', 'models', 'model', 'test'] }) },
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(body.includes('PROVIDER_KEY'), 'Provider decryption error was not sanitized');
    assert.ok(
      !body.includes(probe) && !body.includes(wrongKey) && !body.includes(ciphertext),
      'Provider error exposed private material',
    );
    assert.ok(digest(readFileSync(validPath)) === before, 'Wrong override modified persisted key');
    console.log('Crypto invalid-key checks passed');
  } else throw new Error('Unknown crypto fixture mode');
} finally {
  closeDb();
}
