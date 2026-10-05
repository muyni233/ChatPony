import {
  adminCharacters,
  adminProviders,
  adminResetQuotas,
  adminStats,
  adminUsers,
  testProvider,
} from '@/lib/server/admin';
import {
  changePassword,
  currentUser,
  deleteAccount,
  forgotPassword,
  login,
  logout,
  register,
  requireAdmin,
  requireUser,
  resendVerification,
  resetPassword,
  updateProfile,
  verifyEmail,
} from '@/lib/server/auth';
import { sendMessage } from '@/lib/server/chat';
import { assertSameOrigin, errorResponse, HttpError, json } from '@/lib/server/http';
import {
  changeMemory,
  characters,
  createConversation,
  createMemory,
  deleteConversation,
  favorites,
  getConversation,
  listConversations,
  listMemories,
  providers,
  updateConversation,
} from '@/lib/server/repository';
import {
  adminSettings,
  bootstrapRequired,
  previewPromptMetadata,
  publicSettings,
  testEmail,
} from '@/lib/server/settings';
import { getQuotaStatus } from '@/lib/server/quota';
import { readAudit } from '@/lib/server/audit';
import { adminAnnouncements, userAnnouncements } from '@/lib/server/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 660;

async function dispatch(request: Request) {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const path = url.pathname.slice('/api/'.length).split('/').filter(Boolean);
    const resource = path[0],
      id = path[1],
      action = path[2],
      method = request.method;
    if (resource === 'session' && method === 'GET')
      return json({
        user: currentUser(request),
        bootstrapRequired: bootstrapRequired(),
        site: publicSettings(),
      });
    if (resource === 'characters' && method === 'GET' && !id)
      return json({ characters: characters() });
    if (resource === 'providers' && method === 'GET' && !id)
      return json({ providers: providers() });
    if (resource === 'auth') {
      if (method === 'POST') {
        if (id === 'register') return await register(request);
        if (id === 'login') return await login(request);
        if (id === 'logout') return logout(request);
        if (id === 'password') return await changePassword(request);
        if (id === 'forgot-password' || id === 'forgot') return await forgotPassword(request);
        if (id === 'reset-password' || id === 'reset') return await resetPassword(request);
        if (id === 'verify-email') return await verifyEmail(request);
        if (id === 'resend-verification') return await resendVerification(request);
      }
      if (method === 'PATCH' && id === 'profile') return await updateProfile(request);
    }
    if (resource === 'profile') {
      if (method === 'PATCH') return await updateProfile(request);
      if (method === 'DELETE') return await deleteAccount(request);
    }
    if (resource === 'admin') {
      const admin = requireAdmin(request);
      if (
        id === 'announcements' &&
        !path[3] &&
        ((!action && ['GET', 'POST'].includes(method)) ||
          (action && ['PATCH', 'DELETE'].includes(method)))
      )
        return await adminAnnouncements(request, action);
      if (id === 'audit' && !action && method === 'GET') return json(readAudit(url.searchParams));
      if (id === 'quotas' && action === 'reset' && !path[3] && method === 'POST')
        return await adminResetQuotas(request);
      if (id === 'stats' && method === 'GET') return adminStats();
      if (id === 'settings') {
        if (action === 'preview-metadata' && !path[3] && method === 'POST')
          return await previewPromptMetadata(request);
        if (action === 'test-email' && method === 'POST') return await testEmail(admin);
        if (!action && ['GET', 'PATCH'].includes(method)) return await adminSettings(request);
      }
      if (
        id === 'characters' &&
        ((!action && ['GET', 'POST'].includes(method)) ||
          (action && ['PATCH', 'DELETE'].includes(method)))
      )
        return await adminCharacters(request, action);
      if (id === 'providers') {
        if (action && path[3] === 'test' && method === 'POST')
          return await testProvider(request, admin, action);
        if (
          (!action && ['GET', 'POST'].includes(method)) ||
          (action && ['PATCH', 'DELETE'].includes(method))
        )
          return await adminProviders(request, action);
      }
      if (id === 'users' && ((!action && method === 'GET') || (action && method === 'PATCH')))
        return await adminUsers(request, admin, action);
    }
    if (resource === 'announcements' && !path[3])
      return await userAnnouncements(request, id, action);
    if (['conversations', 'memories', 'favorites', 'quota'].includes(resource)) {
      const user = requireUser(request);
      if (resource === 'quota' && !id && method === 'GET') return json(getQuotaStatus(user.id));
      if (resource === 'conversations') {
        if (!id && method === 'GET') return listConversations(user);
        if (!id && method === 'POST') return await createConversation(request, user);
        if (id && !action && method === 'GET') return getConversation(user, id);
        if (id && !action && method === 'PATCH') return await updateConversation(request, user, id);
        if (id && !action && method === 'DELETE') return deleteConversation(user, id);
        if (id && action === 'messages' && method === 'POST')
          return await sendMessage(request, user, id);
      }
      if (resource === 'memories') {
        if (!id && method === 'GET') return listMemories(user, url.searchParams.get('characterId'));
        if (!id && method === 'POST') return await createMemory(request, user);
        if (id && ['PATCH', 'DELETE'].includes(method))
          return await changeMemory(request, user, id);
      }
      if (resource === 'favorites' && ['GET', 'POST', 'DELETE'].includes(method))
        return await favorites(request, user, id);
    }
    throw new HttpError(404, '接口不存在或不支持此操作。', 'NOT_FOUND');
  } catch (error) {
    return errorResponse(error);
  }
}

export { dispatch as GET, dispatch as POST, dispatch as PATCH, dispatch as DELETE };
