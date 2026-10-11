import {
  assertMutationRequest,
  createSession,
  currentUser,
  destroySession,
  login,
  rateLimit,
  register,
  requireAdmin,
  requireUser,
} from '@/lib/auth';
import { chatResponse, testProvider } from '@/lib/chat';
import { AppError, errorResponse } from '@/lib/errors';
import { getQuota, resetQuota } from '@/lib/quota';
import {
  getMailConfig,
  sendVerificationCode,
  sendTestMail,
  testMail,
  updateMailConfig,
} from '@/lib/mail';
import { listMailDeliveries } from '@/lib/mail-diagnostics';
import { normalizeEmail } from '@/lib/email-policy';
import { AVATAR_JSON_BYTES, avatarResponse, uploadAvatar } from '@/lib/avatars';
import { saveCharacterWithAvatar } from '@/lib/character-avatars';
import { deleteUserCharacter, getUserCharacters, saveUserCharacter } from '@/lib/user-characters';
import { getAudit, getAuditStats, listAudit } from '@/lib/audit';
import {
  getEmbeddingSettings,
  reindexMemories,
  testEmbedding,
  updateEmbeddingSettings,
} from '@/lib/ai/embeddings';
import {
  createConversation,
  createMemory,
  deleteAnnouncement,
  deleteCharacter,
  deleteConversation,
  deleteMemory,
  deleteProvider,
  deleteSupplier,
  getBootstrap,
  getConversation,
  getOverview,
  getSettings,
  getPersona,
  listAnnouncements,
  listCharacters,
  listConversations,
  listMemories,
  listProviders,
  listSuppliers,
  listUsers,
  saveAnnouncement,
  saveProvider,
  saveSupplier,
  updateAccount,
  updateConversation,
  updateMemory,
  updateSettings,
  updatePersona,
  updateUser,
} from '@/lib/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };
const MAX_JSON_BYTES = 128 * 1024;

function json(data: unknown, status = 200, sessionCookie?: string): Response {
  return Response.json(
    { data },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(sessionCookie ? { 'Set-Cookie': sessionCookie } : {}),
      },
    },
  );
}

async function body(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求需使用 application/json 格式。');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过长。');
  if (!request.body) throw new AppError(400, 'INVALID_JSON', '请求内容不可为空。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过长。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(400, 'INVALID_JSON', '请求内容不是有效的 JSON。');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new AppError(400, 'INVALID_JSON', '请求内容必须是 JSON 对象。');
  return result as Record<string, unknown>;
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { path } = await context.params;
    const route = path.join('/');
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD') assertMutationRequest(request);

    if (method === 'GET' && route === 'bootstrap') return json(getBootstrap(currentUser(request)));
    if (method === 'GET' && route === 'characters')
      return json(listCharacters(false, currentUser(request)?.id));
    if (method === 'GET' && route === 'announcements') return json(listAnnouncements());
    if (method === 'GET' && path[0] === 'avatars' && path.length === 2)
      return await avatarResponse(path[1], currentUser(request)?.id);
    if (method === 'POST' && route === 'auth/register') {
      const user = await register(request, await body(request));
      return json(user, 201, createSession(user.id, request));
    }
    if (method === 'POST' && route === 'auth/verification/send') {
      const input = await body(request);
      const email = normalizeEmail(input.email);
      rateLimit(request, 'verification-global', 300, 60 * 60 * 1000, 'platform');
      rateLimit(request, 'verification-client', 20, 60 * 60 * 1000);
      rateLimit(request, 'verification-email', 5, 60 * 60 * 1000, email);
      rateLimit(request, 'verification-resend', 1, 60 * 1000, email);
      return json(await sendVerificationCode(email));
    }
    if (method === 'POST' && route === 'auth/login') {
      const result = await login(request, await body(request));
      return json(result.user, 200, result.sessionCookie);
    }
    if (method === 'POST' && route === 'auth/logout')
      return json({ ok: true }, 200, destroySession(request));

    if (path[0] === 'admin') {
      const admin = requireAdmin(request);
      if (method === 'GET' && route === 'admin/overview') return json(getOverview());
      if (route === 'admin/mail') {
        if (method === 'GET') return json(getMailConfig());
        if (method === 'PATCH') return json(updateMailConfig(await body(request)));
      }
      if (method === 'POST' && route === 'admin/mail/test') {
        rateLimit(request, 'mail-test', 10, 60 * 1000, admin.id);
        return json(await testMail());
      }
      if (method === 'POST' && route === 'admin/mail/send-test') {
        rateLimit(request, 'mail-send-test', 5, 60 * 1000, admin.id);
        return json(await sendTestMail(await body(request)));
      }
      if (method === 'GET' && route === 'admin/mail/deliveries')
        return json(listMailDeliveries(Object.fromEntries(new URL(request.url).searchParams)));
      if (method === 'GET' && route === 'admin/requests')
        return json(listAudit(Object.fromEntries(new URL(request.url).searchParams)));
      if (method === 'GET' && route === 'admin/requests/stats')
        return json(getAuditStats(new URL(request.url).searchParams.get('period') || undefined));
      if (method === 'GET' && path[1] === 'requests' && path.length === 3)
        return json(getAudit(path[2]));
      if (route === 'admin/embeddings') {
        if (method === 'GET') return json(getEmbeddingSettings());
        if (method === 'PATCH') return json(updateEmbeddingSettings(await body(request)));
      }
      if (method === 'POST' && route === 'admin/embeddings/test') {
        rateLimit(request, 'embedding-test', 10, 60 * 1000, admin.id);
        return json(await testEmbedding(admin.id));
      }
      if (method === 'POST' && route === 'admin/embeddings/reindex') {
        rateLimit(request, 'embedding-admin-reindex', 3, 60 * 1000, admin.id);
        return json(await reindexMemories(undefined, admin.id));
      }
      if (route === 'admin/settings') {
        if (method === 'GET') return json(getSettings());
        if (method === 'PATCH') return json(updateSettings(await body(request)));
      }
      if (path[1] === 'characters') {
        if (path.length === 2 && method === 'GET') return json(listCharacters(true));
        if ((path.length === 2 && method === 'POST') || (path.length === 3 && method === 'PATCH')) {
          const input = await body(request, AVATAR_JSON_BYTES);
          if (input.avatarDataUrl !== undefined)
            rateLimit(request, 'character-avatar-upload', 10, 60 * 1000, admin.id);
          return json(
            await saveCharacterWithAvatar(method === 'POST' ? null : path[2], input),
            method === 'POST' ? 201 : 200,
          );
        }
        if (path.length === 3 && method === 'DELETE') {
          deleteCharacter(path[2]);
          return json({ ok: true });
        }
      }
      if (path[1] === 'suppliers') {
        if (path.length === 2 && method === 'GET') return json(listSuppliers());
        if (path.length === 2 && method === 'POST')
          return json(saveSupplier(null, await body(request)), 201);
        if (path.length === 3 && method === 'PATCH')
          return json(saveSupplier(path[2], await body(request)));
        if (path.length === 3 && method === 'DELETE') {
          deleteSupplier(path[2]);
          return json({ ok: true });
        }
      }
      // /providers is a compatibility alias for models; supplier credentials have their own API.
      if (path[1] === 'models' || path[1] === 'providers') {
        if (path.length === 2 && method === 'GET') return json(listProviders());
        if (path.length === 2 && method === 'POST')
          return json(saveProvider(null, await body(request)), 201);
        if (path.length === 3 && method === 'PATCH')
          return json(saveProvider(path[2], await body(request)));
        if (path.length === 3 && method === 'DELETE') {
          deleteProvider(path[2]);
          return json({ ok: true });
        }
        if (path.length === 4 && path[3] === 'test' && method === 'POST') {
          rateLimit(request, 'provider-test', 20, 60 * 1000, admin.id);
          return json(await testProvider(path[2], admin.id));
        }
      }
      if (path[1] === 'announcements') {
        if (path.length === 2 && method === 'GET') return json(listAnnouncements(true));
        if (path.length === 2 && method === 'POST')
          return json(saveAnnouncement(null, await body(request)), 201);
        if (path.length === 3 && method === 'PATCH')
          return json(saveAnnouncement(path[2], await body(request)));
        if (path.length === 3 && method === 'DELETE') {
          deleteAnnouncement(path[2]);
          return json({ ok: true });
        }
      }
      if (method === 'GET' && route === 'admin/users') return json(listUsers());
      if (method === 'PATCH' && path.length === 3 && path[1] === 'users')
        return json(updateUser(path[2], await body(request)));
      if (method === 'POST' && route === 'admin/quotas/reset') {
        const input = await body(request);
        if (Object.keys(input).some((key) => key !== 'userId'))
          throw new AppError(400, 'VALIDATION_ERROR', '限额重置请求包含无效字段。');
        if (
          input.userId !== undefined &&
          (typeof input.userId !== 'string' || !input.userId || input.userId.length > 100)
        )
          throw new AppError(400, 'VALIDATION_ERROR', '用户标识无效。');
        return json({ ok: true, count: resetQuota(input.userId as string | undefined) });
      }
      throw new AppError(404, 'NOT_FOUND', '请求的接口不存在。');
    }

    const user = requireUser(request);
    if (path[0] === 'account' && path[1] === 'characters') {
      if (path.length === 2 && method === 'GET') return json(getUserCharacters(user.id));
      if ((path.length === 2 && method === 'POST') || (path.length === 3 && method === 'PATCH')) {
        rateLimit(request, 'user-character-save', 30, 60 * 1000, user.id);
        const input = await body(request, AVATAR_JSON_BYTES);
        if (input.avatarDataUrl !== undefined)
          rateLimit(request, 'character-avatar-upload', 10, 60 * 1000, user.id);
        return json(
          await saveUserCharacter(user.id, method === 'POST' ? null : path[2], input),
          method === 'POST' ? 201 : 200,
        );
      }
      if (path.length === 3 && method === 'DELETE') {
        deleteUserCharacter(user.id, path[2]);
        return json({ ok: true });
      }
    }
    if (route === 'account/persona') {
      if (method === 'GET') return json(getPersona(user.id));
      if (method === 'PATCH') return json(updatePersona(user.id, await body(request)));
    }
    if (method === 'POST' && route === 'account/avatar') {
      rateLimit(request, 'avatar-upload', 3, 60 * 1000, user.id);
      return json(await uploadAvatar(user.id, await body(request, AVATAR_JSON_BYTES)));
    }
    if (method === 'PATCH' && route === 'account') {
      const input = await body(request);
      const updated = await updateAccount(request, user, input);
      return json(
        updated,
        200,
        input.password !== undefined ? createSession(user.id, request) : undefined,
      );
    }
    if (method === 'GET' && route === 'quota') return json(getQuota(user.id));
    if (route === 'conversations') {
      if (method === 'GET') return json(listConversations(user.id));
      if (method === 'POST') {
        rateLimit(request, 'new-conversation', 30, 60 * 1000, user.id);
        return json(createConversation(user.id, await body(request)), 201);
      }
    }
    if (path[0] === 'conversations' && path.length === 2) {
      if (method === 'GET') return json(getConversation(user.id, path[1]));
      if (method === 'PATCH')
        return json(updateConversation(user.id, path[1], await body(request)));
      if (method === 'DELETE') {
        deleteConversation(user.id, path[1]);
        return json({ ok: true });
      }
    }
    if (
      method === 'POST' &&
      path[0] === 'conversations' &&
      path.length === 3 &&
      path[2] === 'messages'
    ) {
      rateLimit(request, 'chat', 60, 60 * 1000, user.id);
      return await chatResponse(request, user, path[1]);
    }
    if (route === 'memories') {
      if (method === 'GET') return json(listMemories(user.id));
      if (method === 'POST') return json(createMemory(user.id, await body(request)), 201);
    }
    if (method === 'POST' && route === 'memories/reindex') {
      rateLimit(request, 'embedding-user-reindex', 3, 60 * 1000, user.id);
      return json(await reindexMemories(user.id, user.id));
    }
    if (path[0] === 'memories' && path.length === 2) {
      if (method === 'PATCH') return json(updateMemory(user.id, path[1], await body(request)));
      if (method === 'DELETE') {
        deleteMemory(user.id, path[1]);
        return json({ ok: true });
      }
    }
    throw new AppError(404, 'NOT_FOUND', '请求的接口不存在。');
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
