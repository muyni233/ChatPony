import { strict as assert } from 'node:assert';
import { join, resolve } from 'node:path';
import { getDb, closeDb } from '../../src/lib/db';
import { createSession, currentUser, assertMutationRequest } from '../../src/lib/auth';
import { encrypt, decrypt } from '../../src/lib/crypto';
import { finishCall, getQuota, reserveCall, resetQuota } from '../../src/lib/quota';
import { getSettings } from '../../src/lib/repository';
import { AppError } from '../../src/lib/errors';
import type { Row } from '../../src/lib/mappers';
import { GET, POST, PATCH, DELETE } from '../../src/app/api/[...path]/route';

const temp = process.env.CHATPONY_TEST_DIR;
assert.ok(temp, 'Run through bun test tests/backend.test.ts to allocate an isolated database.');
process.env.DATABASE_PATH = join(temp, 'test.db');
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

async function call(
  method: string,
  path: string,
  input?: unknown,
  session = '',
  origin = '',
  headers: Record<string, string> = {},
) {
  const request = new Request(`http://chatpony.test/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(session ? { Cookie: session.split(';')[0] } : {}),
      ...headers,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const handler =
    method === 'GET' ? GET : method === 'POST' ? POST : method === 'PATCH' ? PATCH : DELETE;
  const response = await handler(request, { params: Promise.resolve({ path: path.split('/') }) });
  const json = (await response.json()) as {
    data?: Record<string, unknown> | unknown[];
    error?: { code: string; message: string };
  };
  return {
    status: response.status,
    data: json.data as Record<string, unknown>,
    error: json.error,
    cookie: response.headers.get('set-cookie') || '',
    raw: json,
  };
}

try {
  const db = getDb();
  assert.equal((db.query('SELECT COUNT(*) AS n FROM users').get() as Row).n, 0);
  assert.equal((db.query('SELECT COUNT(*) AS n FROM characters').get() as Row).n, 0);
  assert.equal((db.query('SELECT COUNT(*) AS n FROM providers').get() as Row).n, 0);
  assert.equal((db.query('SELECT COUNT(*) AS n FROM suppliers').get() as Row).n, 0);
  assert.ok(getSettings().siteDescription.length > 0);
  assert.equal(getSettings().bubbleDelimiter, '');
  assert.deepEqual(getSettings().hiddenSymbols, []);
  const guest = await call('GET', 'bootstrap');
  assert.equal(guest.status, 200);
  assert.equal(guest.data.user, null);
  assert.deepEqual(guest.data.characters, []);

  assert.throws(
    () =>
      assertMutationRequest(
        new Request('http://chatpony.test/api/auth/register', { method: 'POST' }),
      ),
    (error) => error instanceof AppError && error.status === 415,
  );
  assert.doesNotThrow(() =>
    assertMutationRequest(
      new Request('https://another-host.test/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    ),
  );
  const csrf = await call('POST', 'auth/logout', undefined, '', 'https://other.test', {
    'Sec-Fetch-Site': 'cross-site',
  });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.error?.code, 'CROSS_SITE_REQUEST');
  assert.equal(
    (await call('POST', 'auth/logout', undefined, '', 'https://changed-origin.test')).status,
    200,
  );
  assert.equal((await call('POST', 'auth/logout', undefined)).status, 200);
  assert.equal(
    (await call('POST', 'auth/logout', undefined, '', '', { 'Content-Type': 'text/plain' })).status,
    415,
  );
  assert.equal(
    (
      await call('POST', 'auth/logout', undefined, '', '', {
        'Content-Type': 'application/x-www-form-urlencoded',
      })
    ).status,
    415,
  );
  assert.equal(
    (await call('POST', 'auth/logout', undefined, '', '', { 'Content-Type': '' })).status,
    415,
  );
  const changedHost = await POST(
    new Request('https://different-host.test/api/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://some-origin.test',
        'Sec-Fetch-Site': 'same-origin',
      },
    }),
    { params: Promise.resolve({ path: ['auth', 'logout'] }) },
  );
  assert.equal(changedHost.status, 200);
  assert.equal(changedHost.headers.get('Access-Control-Allow-Origin'), null);
  const created = await call('POST', 'auth/register', {
    name: 'Starlight',
    email: 'USER@example.test',
    password: 'strong-password-123',
    role: 'admin',
  });
  assert.equal(created.status, 201);
  const userId = String(created.data.id);
  const session = created.cookie;
  assert.equal(created.data.role, 'user');
  assert.equal(created.data.email, 'user@example.test');
  assert.ok(!('password_hash' in created.data));
  assert.ok(session.includes('HttpOnly') && session.includes('SameSite=Lax'));
  assert.ok(currentUser(new Request('http://chatpony.test', { headers: { Cookie: session } })));
  const duplicate = await call('POST', 'auth/register', {
    name: 'Another',
    email: 'USER@example.test',
    password: 'strong-password-123',
  });
  assert.equal(duplicate.status, 409);
  const invalidLogin = await call('POST', 'auth/login', {
    email: 'user@example.test',
    password: 'incorrect-password',
  });
  assert.equal(invalidLogin.status, 401);
  const logged = await call(
    'POST',
    'auth/login',
    {
      email: 'user@example.test',
      password: 'strong-password-123',
    },
    '',
    'http://chatpony.test',
    { 'Sec-Fetch-Site': 'same-origin' },
  );
  assert.equal(logged.status, 200);
  // Pause after the costly verification to deterministically simulate another
  // request changing the password before login/password-change can commit.
  const credentialRace = async (
    path: string,
    input: Record<string, unknown>,
    expectedStatus: number,
  ) => {
    const originalVerify = Bun.password.verify;
    const originalHash = String(
      (db.query('SELECT password_hash FROM users WHERE id=?').get(userId) as Row).password_hash,
    );
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    Bun.password.verify = async (...args) => {
      const result = await originalVerify(...args);
      started.resolve();
      await resume.promise;
      return result;
    };
    try {
      const pending = call(
        path === 'account' ? 'PATCH' : 'POST',
        path,
        input,
        path === 'account' ? session : '',
      );
      await started.promise;
      db.query("UPDATE users SET password_hash='changed-by-another-request' WHERE id=?").run(
        userId,
      );
      resume.resolve();
      assert.equal((await pending).status, expectedStatus);
      assert.equal(
        (db.query('SELECT password_hash FROM users WHERE id=?').get(userId) as Row).password_hash,
        'changed-by-another-request',
      );
    } finally {
      resume.resolve();
      Bun.password.verify = originalVerify;
      db.query('UPDATE users SET password_hash=? WHERE id=?').run(originalHash, userId);
    }
  };
  await credentialRace(
    'auth/login',
    { email: 'user@example.test', password: 'strong-password-123' },
    401,
  );
  await credentialRace(
    'account',
    { currentPassword: 'strong-password-123', password: 'other-password-123' },
    409,
  );
  assert.equal((await call('GET', 'admin/users', undefined, session)).status, 403);

  const child = Bun.spawn(
    [
      Bun.which('bun') || 'bun',
      resolve('scripts/create-admin.ts'),
      '--email',
      'admin@example.test',
      '--name',
      'Admin',
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CHATPONY_ADMIN_PASSWORD: 'admin-secure-password' },
    },
  );
  const [adminOutput, adminError, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, adminError);
  assert.ok(!adminOutput.includes('admin-secure-password'));
  const adminId = String((db.query("SELECT id FROM users WHERE role='admin'").get() as Row).id);
  const adminSession = createSession(adminId);
  const defaults = getSettings();
  assert.equal(defaults.compressionTriggerRounds, 24);
  assert.equal(defaults.compressionKeepRounds, 8);
  assert.equal(defaults.memorySummaryInterval, 8);
  assert.equal(defaults.automaticMemoryEnabled, true);
  assert.equal(defaults.metadataFields.length, 8);
  assert.equal(defaults.metadataTimezone, '');
  assert.equal(
    (await call('PATCH', 'admin/settings', { compressionTriggerRounds: 1 }, adminSession)).status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        { compressionTriggerRounds: 8, compressionKeepRounds: 8 },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { memorySummaryInterval: 0 }, adminSession)).status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { compressionModelId: 'missing-model' }, adminSession))
      .error?.code,
    'MAINTENANCE_MODEL_UNAVAILABLE',
  );
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        { metadataFields: ['date', 'unsupported'] },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { metadataTimezone: 'Invalid/Zone' }, adminSession))
      .status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { metadataCustom: 'x'.repeat(2001) }, adminSession))
      .status,
    400,
  );
  const metadataConfig = await call(
    'PATCH',
    'admin/settings',
    {
      compressionTriggerRounds: 2,
      compressionKeepRounds: 1,
      metadataEnabled: false,
      metadataFields: ['date', 'date'],
      metadataTimezone: 'UTC',
      metadataCustom: 'Literal ${date}\n第二行',
      automaticMemoryEnabled: false,
    },
    adminSession,
  );
  assert.equal(metadataConfig.status, 200);
  assert.deepEqual(metadataConfig.data.metadataFields, ['date']);
  assert.equal(metadataConfig.data.metadataCustom, 'Literal ${date}\n第二行');
  const metadataPublic = (await call('GET', 'bootstrap')).data.settings as Record<string, unknown>;
  assert.equal(metadataPublic.metadataEnabled, false);
  assert.equal(metadataPublic.metadataTimezone, 'UTC');
  await call(
    'PATCH',
    'admin/settings',
    {
      compressionTriggerRounds: 24,
      compressionKeepRounds: 8,
      metadataEnabled: true,
      metadataFields: defaults.metadataFields,
      metadataTimezone: '',
      metadataCustom: '',
      automaticMemoryEnabled: true,
    },
    adminSession,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        { bubbleDelimiter: ' || ', hiddenSymbols: ['*', '<hidden>', ' '] },
        session,
      )
    ).status,
    403,
  );
  const displaySettings = await call(
    'PATCH',
    'admin/settings',
    { bubbleDelimiter: ' || ', hiddenSymbols: ['*', '<hidden>', ' '] },
    adminSession,
  );
  assert.equal(displaySettings.status, 200);
  assert.equal(displaySettings.data.bubbleDelimiter, ' || ');
  assert.deepEqual(displaySettings.data.hiddenSymbols, ['*', '<hidden>', ' ']);
  assert.equal(
    (await call('PATCH', 'admin/settings', { bubbleDelimiter: 'x'.repeat(33) }, adminSession))
      .status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { hiddenSymbols: [''] }, adminSession)).status,
    400,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { hiddenSymbols: ['x'.repeat(21)] }, adminSession))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        { hiddenSymbols: Array.from({ length: 21 }, (_, index) => String(index)) },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal((await call('GET', 'admin/embeddings', undefined, session)).status, 403);
  assert.equal(
    (await call('GET', 'admin/embeddings', undefined, adminSession)).data.enabled,
    false,
  );
  assert.equal(
    (await call('POST', 'memories/reindex', {}, session)).error?.code,
    'EMBEDDING_DISABLED',
  );
  assert.equal(
    (await call('PATCH', 'admin/embeddings', { enabled: true }, adminSession)).status,
    400,
  );
  assert.equal(
    (await call('PATCH', `admin/users/${adminId}`, { role: 'user' }, adminSession)).error?.code,
    'LAST_ADMIN',
  );
  assert.equal(
    (await call('PATCH', `admin/users/${adminId}`, { disabled: true }, adminSession)).error?.code,
    'LAST_ADMIN',
  );

  const secret = '[redacted]';
  assert.equal((await call('GET', 'admin/suppliers', undefined, session)).status, 403);
  const supplier = await call(
    'POST',
    'admin/suppliers',
    { name: 'Local supplier', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: secret },
    adminSession,
  );
  assert.equal(supplier.status, 201);
  const supplierId = String(supplier.data.id);
  assert.equal(supplier.data.hasKey, true);
  assert.ok(!JSON.stringify(supplier.raw).includes(secret));
  const provider = await call(
    'POST',
    'admin/models',
    {
      supplierId,
      name: 'Local test',
      model: 'test',
      contextWindow: 8192,
      maxOutput: 1024,
    },
    adminSession,
  );
  assert.equal(provider.status, 201);
  const providerId = String(provider.data.id);
  assert.equal(provider.data.hasKey, true);
  assert.equal(provider.data.supplierId, supplierId);
  assert.equal(provider.data.supplierActive, true);
  assert.equal(provider.data.supplierName, 'Local supplier');
  assert.ok(!JSON.stringify(provider.raw).includes(secret));
  const sibling = await call(
    'POST',
    'admin/models',
    { supplierId, name: 'Second model', model: 'second' },
    adminSession,
  );
  assert.equal(sibling.status, 201);
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        { compressionModelId: providerId, memorySummaryModelId: String(sibling.data.id) },
        adminSession,
      )
    ).status,
    200,
  );
  assert.equal(sibling.data.protocol, 'openai-completions');
  assert.equal(
    (await call('PATCH', `admin/models/${providerId}`, { protocol: 'gemini' }, adminSession))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/suppliers/${supplierId}`,
        { protocol: 'openai-responses' },
        adminSession,
      )
    ).status,
    200,
  );
  const inheritedModels = (await call('GET', 'admin/models', undefined, adminSession))
    .data as unknown as { protocol: string }[];
  assert.ok(inheritedModels.every((model) => model.protocol === 'openai-responses'));
  assert.ok(
    (db.query('SELECT protocol FROM providers WHERE supplier_id=?').all(supplierId) as Row[]).every(
      (model) => model.protocol === 'openai-responses',
    ),
  );
  await call(
    'PATCH',
    `admin/suppliers/${supplierId}`,
    { protocol: 'openai-completions' },
    adminSession,
  );
  assert.equal((await call('GET', 'admin/models', undefined, adminSession)).data.length, 2);
  assert.equal((await call('GET', 'admin/providers', undefined, adminSession)).data.length, 2);
  const encrypted = String(
    (db.query('SELECT api_key FROM suppliers WHERE id=?').get(supplierId) as Row).api_key,
  );
  assert.deepEqual(db.query('SELECT base_url,api_key FROM providers WHERE id=?').get(providerId), {
    base_url: '',
    api_key: '',
  });
  assert.notEqual(encrypted, secret);
  assert.equal(decrypt(encrypted), secret);
  assert.equal(decrypt(encrypt('roundtrip')), 'roundtrip');
  assert.throws(() => decrypt(`${encrypted.slice(0, -4)}AAAA`));
  assert.equal(
    (await call('PATCH', `admin/providers/${providerId}`, { name: 'Updated' }, adminSession)).data
      .hasKey,
    true,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/suppliers/${supplierId}`,
        { name: 'Renamed supplier' },
        adminSession,
      )
    ).data.hasKey,
    true,
  );
  const models = (await call('GET', 'admin/models', undefined, adminSession)).data as unknown as {
    supplierName: string;
    baseUrl: string;
    hasKey: boolean;
  }[];
  assert.ok(
    models.every(
      (model) =>
        model.supplierName === 'Renamed supplier' &&
        model.baseUrl === 'http://127.0.0.1:9999/v1' &&
        model.hasKey,
    ),
  );
  assert.equal(
    (
      await call(
        'POST',
        'admin/suppliers',
        { name: 'Bad', baseUrl: 'file:///etc/passwd' },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'POST',
        'admin/models',
        {
          supplierId,
          name: 'Bad',
          model: 'x',
          apiKey: 'not-allowed',
        },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'PATCH',
        `admin/models/${providerId}`,
        { baseUrl: 'https://override.test/v1' },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'POST',
        'admin/models',
        { supplierId: 'missing', name: 'Bad', model: 'x' },
        adminSession,
      )
    ).status,
    404,
  );

  const character = await call(
    'POST',
    'admin/characters',
    {
      name: 'Configured character',
      slug: 'configured',
      personality: 'A private administrator-authored personality.',
      providerId,
      active: true,
      greeting: 'Welcome.',
    },
    adminSession,
  );
  assert.equal(character.status, 201);
  const characterId = String(character.data.id);
  const publicCharacters = await call('GET', 'characters');
  assert.ok(!JSON.stringify(publicCharacters.raw).includes('personality'));
  assert.ok(!JSON.stringify(publicCharacters.raw).includes('providerId'));
  assert.equal(
    (
      await call(
        'POST',
        'admin/characters',
        { name: 'Bad', slug: 'invalid slug', personality: 'test' },
        adminSession,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('PATCH', `admin/suppliers/${supplierId}`, { active: false }, adminSession)).status,
    200,
  );
  assert.equal(
    (await call('PATCH', 'admin/settings', { memorySummaryModelId: providerId }, adminSession))
      .error?.code,
    'MAINTENANCE_MODEL_UNAVAILABLE',
  );
  assert.equal((await call('GET', 'characters')).data.length, 0);
  assert.equal(
    (await call('POST', 'conversations', { kind: 'private', characterIds: [characterId] }, session))
      .status,
    404,
  );
  assert.equal(
    (await call('PATCH', `admin/characters/${characterId}`, { active: true }, adminSession)).status,
    400,
  );
  assert.equal(
    (await call('PATCH', `admin/models/${providerId}`, { active: true }, adminSession)).data
      .supplierActive,
    false,
  );
  assert.equal(
    (await call('PATCH', `admin/suppliers/${supplierId}`, { active: true }, adminSession)).status,
    200,
  );
  assert.equal((await call('GET', 'characters')).data.length, 1);

  const conversation = await call(
    'POST',
    'conversations',
    { kind: 'private', characterIds: [characterId] },
    session,
  );
  assert.equal(conversation.status, 201);
  const conversationId = String(conversation.data.id);
  assert.equal(getQuota(userId).fiveHour.used, 0);
  const detail = await call('GET', `conversations/${conversationId}`, undefined, session);
  assert.equal((detail.data.messages as unknown[]).length, 1);
  const originalMessage = (detail.data.messages as { id: string; content: string }[])[0];
  await call(
    'PATCH',
    'admin/settings',
    { bubbleDelimiter: ' || ', hiddenSymbols: ['Welcome.'] },
    adminSession,
  );
  const rawMessage = (await call('GET', `conversations/${conversationId}`, undefined, session)).data
    .messages as { content: string }[];
  assert.equal(rawMessage[0].content, 'Welcome.');
  assert.equal(
    (db.query('SELECT content FROM messages WHERE id=?').get(originalMessage.id) as Row).content,
    'Welcome.',
  );
  const resetDisplay = await call(
    'PATCH',
    'admin/settings',
    { bubbleDelimiter: '', hiddenSymbols: [] },
    adminSession,
  );
  assert.equal(resetDisplay.data.bubbleDelimiter, '');
  assert.deepEqual(resetDisplay.data.hiddenSymbols, []);
  const second = await call('POST', 'auth/register', {
    name: 'Other',
    email: 'other@example.test',
    password: 'strong-password-456',
  });
  const secondId = String(second.data.id);
  assert.equal(
    (await call('GET', `conversations/${conversationId}`, undefined, second.cookie)).status,
    404,
  );
  assert.equal(
    (await call('DELETE', `conversations/${conversationId}`, undefined, second.cookie)).status,
    404,
  );
  const memory = await call(
    'POST',
    'memories',
    { characterId, content: 'Remember my favorite color.' },
    session,
  );
  assert.equal(memory.status, 201);
  assert.equal(memory.data.vectorStatus, 'disabled');
  assert.equal(
    (await call('PATCH', `memories/${memory.data.id}`, { content: 'stolen' }, second.cookie))
      .status,
    404,
  );
  assert.equal(
    (await call('DELETE', `memories/${memory.data.id}`, undefined, second.cookie)).status,
    404,
  );
  const privateMemory = await call(
    'POST',
    'memories',
    { characterId, content: 'Private second-user memory.' },
    second.cookie,
  );
  const indexedInputs: string[] = [];
  const vectorServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const payload = (await request.json()) as { input: string[] };
      indexedInputs.push(...payload.input);
      return Response.json({
        data: payload.input.map((_, index) => ({ index, embedding: [1, index + 1, 0.5] })),
      });
    },
  });
  let vectorSupplierId = '';
  try {
    const vectorSupplier = await call(
      'POST',
      'admin/suppliers',
      {
        name: 'Embedding supplier',
        protocol: 'openai-completions',
        baseUrl: `http://127.0.0.1:${vectorServer.port}/v1`,
        apiKey: 'private-embedding-key',
      },
      adminSession,
    );
    assert.equal(vectorSupplier.status, 201);
    vectorSupplierId = String(vectorSupplier.data.id);
    const vectorModel = await call(
      'POST',
      'admin/models',
      {
        supplierId: vectorSupplierId,
        name: 'Embedding model',
        kind: 'embedding',
        model: 'embedding-test',
      },
      adminSession,
    );
    assert.equal(vectorModel.status, 201);
    const config = await call(
      'PATCH',
      'admin/embeddings',
      {
        enabled: true,
        modelId: String(vectorModel.data.id),
        topK: 6,
        minSimilarity: 0.3,
      },
      adminSession,
    );
    assert.equal(config.status, 200);
    assert.equal(config.data.protocol, 'openai');
    assert.equal(config.data.supplierId, vectorSupplierId);
    assert.equal(
      (await call('PATCH', 'admin/embeddings', { protocol: 'gemini' }, adminSession)).status,
      400,
    );
    assert.equal(config.data.hasKey, true);
    assert.ok(!JSON.stringify(config.raw).includes('private-embedding-key'));
    const indexed = await call('POST', 'memories/reindex', {}, session);
    assert.equal(indexed.status, 200);
    assert.equal(indexed.data.indexed, 1);
    assert.ok(!indexedInputs.includes('Private second-user memory.'));
    assert.equal(
      (
        db
          .query('SELECT status FROM memory_vectors WHERE memory_id=?')
          .get(String(memory.data.id)) as Row
      ).status,
      'ready',
    );
    assert.equal(
      db
        .query('SELECT memory_id FROM memory_vectors WHERE memory_id=?')
        .get(String(privateMemory.data.id)),
      null,
    );
    assert.equal(
      (await call('POST', 'admin/embeddings/reindex', {}, adminSession)).data.indexed,
      1,
    );
    const edited = await call(
      'PATCH',
      `memories/${memory.data.id}`,
      { content: 'My preference changed.' },
      session,
    );
    assert.equal(edited.data.vectorStatus, 'pending');
    assert.equal((await call('POST', 'memories/reindex', {}, session)).data.indexed, 1);
    assert.equal(
      (await call('DELETE', `memories/${privateMemory.data.id}`, undefined, second.cookie)).status,
      200,
    );
    assert.equal(
      db
        .query('SELECT memory_id FROM memory_vectors WHERE memory_id=?')
        .get(String(privateMemory.data.id)),
      null,
    );
  } finally {
    await call('PATCH', 'admin/embeddings', { enabled: false, modelId: '' }, adminSession);
    if (vectorSupplierId)
      await call('DELETE', `admin/suppliers/${vectorSupplierId}`, undefined, adminSession);
    vectorServer.stop(true);
  }

  assert.equal(
    (await call('PATCH', `admin/users/${userId}`, { limit5h: 2, limit7d: 3 }, adminSession)).status,
    200,
  );
  const first = reserveCall(userId, conversationId, characterId);
  const secondCall = reserveCall(userId, conversationId, characterId);
  finishCall(secondCall, true);
  assert.equal(getQuota(userId).fiveHour.used, 2);
  assert.throws(
    () => reserveCall(userId, conversationId, characterId),
    (error) => error instanceof AppError && error.code === 'QUOTA_EXCEEDED',
  );
  finishCall(secondCall, false); // Settled reservations cannot be refunded by a second finish.
  assert.equal(getQuota(userId).fiveHour.used, 2);
  assert.equal(resetQuota(userId), 1);
  assert.equal(getQuota(userId).fiveHour.used, 1);
  finishCall(first, true);
  assert.equal(getQuota(userId).fiveHour.used, 1);
  const refunded = reserveCall(userId, conversationId, characterId);
  finishCall(refunded, false);
  assert.equal(getQuota(userId).fiveHour.used, 1);

  db.query(
    "UPDATE users SET quota_reset_at='1970-01-01T00:00:00.000Z',limit_5h=10,limit_7d=2 WHERE id=?",
  ).run(userId);
  db.query("UPDATE api_calls SET status='failed' WHERE user_id=?").run(userId);
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const insertCall = db.query(
    "INSERT INTO api_calls(id,user_id,conversation_id,character_id,status,created_at,counted_at) VALUES(?,?,?,?,'success',?,?)",
  );
  for (const [callId, timestamp] of [
    ['old', eightDaysAgo],
    ['weekly-one', sixHoursAgo],
    ['weekly-two', sixHoursAgo],
  ])
    insertCall.run(callId, userId, conversationId, characterId, timestamp, timestamp);
  assert.equal(getQuota(userId).fiveHour.used, 0);
  assert.equal(getQuota(userId).sevenDay.used, 2);
  assert.throws(
    () => reserveCall(userId, conversationId, characterId),
    (error) => error instanceof AppError && error.code === 'QUOTA_EXCEEDED',
  );

  resetQuota(userId);
  db.query('UPDATE users SET limit_5h=3,limit_7d=3 WHERE id=?').run(userId);
  const workers = Array.from({ length: 8 }, () =>
    Bun.spawn(
      [
        Bun.which('bun') || 'bun',
        resolve('tests/fixtures/quota-worker.ts'),
        userId,
        conversationId,
        characterId,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: process.env },
    ),
  );
  const outputs = await Promise.all(
    workers.map(async (worker) => {
      const [stdout, stderr, status] = await Promise.all([
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
        worker.exited,
      ]);
      assert.equal(status, 0, stderr);
      return stdout.trim();
    }),
  );
  assert.equal(outputs.filter((value) => value === 'reserved').length, 3);
  assert.equal(outputs.filter((value) => value === 'limited').length, 5);
  assert.equal(getQuota(userId).fiveHour.used, 3);
  assert.equal((await call('POST', 'admin/quotas/reset', {}, adminSession)).data.count, 3);
  assert.equal(getQuota(userId).fiveHour.used, 3); // All pending reservations survive all-user reset.
  db.query("UPDATE api_calls SET status='success' WHERE user_id=? AND status='pending'").run(
    userId,
  );
  assert.equal(
    (await call('DELETE', `conversations/${conversationId}`, undefined, session)).status,
    200,
  );
  assert.equal(getQuota(userId).fiveHour.used, 3); // Removing a transcript cannot erase billed calls.

  const announcement = await call(
    'POST',
    'admin/announcements',
    { title: 'A draft', content: 'Draft content.' },
    adminSession,
  );
  assert.equal((await call('GET', 'announcements')).data.length, 0);
  await call(
    'PATCH',
    `admin/announcements/${announcement.data.id}`,
    { published: true, pinned: true },
    adminSession,
  );
  assert.equal((await call('GET', 'announcements')).data.length, 1);
  assert.equal(
    (
      await call(
        'PATCH',
        'admin/settings',
        { registrationOpen: false, siteDescription: 'Updated description' },
        adminSession,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call('POST', 'auth/register', {
        name: 'Closed',
        email: 'closed@example.test',
        password: 'strong-password-789',
      })
    ).status,
    403,
  );
  assert.equal(
    (await call('PATCH', `admin/users/${secondId}`, { disabled: true }, adminSession)).status,
    200,
  );
  assert.throws(
    () => createSession(secondId),
    (error) => error instanceof AppError && error.code === 'ACCOUNT_DISABLED',
  );
  assert.equal((await call('GET', 'quota', undefined, second.cookie)).status, 401);

  assert.equal(
    (await call('PATCH', 'account', { timezone: 'Invalid/Timezone' }, session)).status,
    400,
  );
  const account = await call(
    'PATCH',
    'account',
    { name: 'New name', currentPassword: 'strong-password-123', password: 'changed-password-123' },
    session,
  );
  assert.equal(account.status, 200);
  assert.equal((await call('GET', 'quota', undefined, session)).status, 401);
  assert.equal((await call('GET', 'quota', undefined, account.cookie)).status, 200);
  assert.equal((await call('POST', 'auth/logout', undefined, account.cookie)).status, 200);
  assert.equal((await call('GET', 'quota', undefined, account.cookie)).status, 401);
  await call(
    'PATCH',
    'admin/settings',
    { compressionModelId: String(sibling.data.id), memorySummaryModelId: String(sibling.data.id) },
    adminSession,
  );
  assert.equal(
    (await call('DELETE', `admin/models/${sibling.data.id}`, undefined, adminSession)).status,
    200,
  );
  assert.equal((await call('GET', 'admin/models', undefined, adminSession)).data.length, 1);
  assert.equal(getSettings().compressionModelId, '');
  assert.equal(getSettings().memorySummaryModelId, '');
  await call(
    'PATCH',
    'admin/settings',
    { compressionModelId: providerId, memorySummaryModelId: providerId },
    adminSession,
  );
  assert.equal((await call('GET', 'admin/suppliers', undefined, adminSession)).data.length, 1);
  assert.equal(
    (await call('DELETE', `admin/suppliers/${supplierId}`, undefined, adminSession)).status,
    200,
  );
  assert.equal(getSettings().compressionModelId, '');
  assert.equal(getSettings().memorySummaryModelId, '');
  assert.equal(
    (db.query('SELECT active FROM characters WHERE id=?').get(characterId) as Row).active,
    0,
  );
  assert.equal(
    (db.query('SELECT api_key FROM suppliers WHERE id=?').get(supplierId) as Row).api_key,
    '',
  );
  assert.equal((await call('GET', 'characters')).data.length, 0);
  assert.equal((await call('GET', 'admin/suppliers', undefined, adminSession)).data.length, 0);
  assert.equal((await call('GET', 'admin/providers', undefined, adminSession)).data.length, 0);
  assert.equal(
    (await call('POST', 'admin/models', { supplierId, name: 'Orphan', model: 'x' }, adminSession))
      .status,
    404,
  );
  assert.equal(
    (await call('DELETE', `admin/characters/${characterId}`, undefined, adminSession)).status,
    200,
  );
  console.log(
    'Backend integration passed: empty installation, auth/CSRF, CLI admin, encrypted secrets, ownership, CRUD, persistent quotas, 8-process contention, reset, account revocation.',
  );
} finally {
  closeDb();
}
