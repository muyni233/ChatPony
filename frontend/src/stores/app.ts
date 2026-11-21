import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { api, ApiError } from '../lib/api';
import { clearConversationCache } from '../lib/conversationCache';
import type { Bootstrap, PlatformSettings, QuotaSnapshot, User } from '../lib/types';

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'primary' | 'error';
}

export interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

const DEFAULT_SETTINGS: PlatformSettings = {
  registrationOpen: true,
  defaultLimit5h: 50,
  defaultLimit7d: 500,
  defaultCharacterSlots: 3,
  maxGroupRounds: 6,
  siteDescription: '多角色 AI 对话平台，支持单聊、群聊与长期记忆。',
  bubbleDelimiter: '',
  hiddenSymbols: [],
  requireEmailVerification: false,
  emailDomainMode: 'any',
  emailDomains: [],
  auditCaptureContent: false,
  auditRetentionDays: 7,
  compressionTriggerRounds: 24,
  compressionKeepRounds: 8,
  compressionModelId: '',
  memorySummaryInterval: 8,
  memorySummaryModelId: '',
  automaticMemoryEnabled: true,
  metadataEnabled: true,
  metadataFields: [],
  metadataTimezone: '',
  metadataCustom: '',
  streamingEnabled: true,
  imageInputEnabled: true,
  maxImagesPerMessage: 4,
  actionStyleEnabled: true,
  actionMarkers: ['*', '（）', '()'],
  actionHideMarkers: false,
  memoryStructuredExtraction: true,
  memoryRecallTopK: 6,
  memoryKeywordWeight: 0.45,
  memoryDecayRate: 0.08,
  memoryArchiveThreshold: 0.25,
};

function resolveInitialTheme(): 'light' | 'dark' {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('chatpony-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    }
  } catch {
    // Ignore storage access errors
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function syncDocumentTheme(next: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', next === 'dark' ? '#0E1513' : '#F5FBF7');
  }
}

export const useAppStore = defineStore('app', () => {
  const bootstrap = ref<Bootstrap | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const theme = ref<'light' | 'dark'>(resolveInitialTheme());
  const authDialogMode = ref<'login' | 'register' | null>(null);
  const newChatModalOpen = ref(false);
  const newChatPreselectId = ref<string | null>(null);
  const toast = ref<ToastMessage | null>(null);
  let toastSeq = 1;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const confirmState = ref<ConfirmState>({
    open: false,
    title: '',
    message: '',
    confirmText: '确认',
    cancelText: '取消',
    tone: 'primary',
  });
  let confirmResolver: ((ok: boolean) => void) | null = null;

  const user = computed<User | null>(() => bootstrap.value?.user ?? null);
  const isAdmin = computed(() => bootstrap.value?.user?.role === 'admin');
  const characters = computed(() => bootstrap.value?.characters ?? []);
  const conversations = computed(() => bootstrap.value?.conversations ?? []);
  const announcements = computed(() => bootstrap.value?.announcements ?? []);
  const quota = computed(() => bootstrap.value?.quota ?? null);
  const settings = computed(() => bootstrap.value?.settings ?? DEFAULT_SETTINGS);
  const stats = computed(
    () => bootstrap.value?.stats ?? { conversations: 0, messages: 0, memories: 0 }
  );

  function applyTheme(next: 'light' | 'dark', persist = true) {
    theme.value = next;
    syncDocumentTheme(next);
    if (persist) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('chatpony-theme', next);
        }
      } catch {
        // Ignore storage write errors
      }
    }
  }

  function initTheme() {
    applyTheme(resolveInitialTheme(), false);
  }

  function toggleTheme() {
    applyTheme(theme.value === 'dark' ? 'light' : 'dark');
  }

  function dismissToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.value = null;
  }

  function notify(text: string, tone: 'info' | 'success' | 'error' = 'info') {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    const id = toastSeq++;
    toast.value = { id, text, tone };
    toastTimer = setTimeout(() => {
      if (toast.value?.id === id) {
        toast.value = null;
      }
      toastTimer = null;
    }, tone === 'error' ? 4200 : 3200);
  }

  function confirm(options: ConfirmOptions): Promise<boolean> {
    if (confirmResolver) {
      confirmResolver(false);
      confirmResolver = null;
    }
    confirmState.value = {
      open: true,
      title: options.title,
      message: options.message,
      confirmText: options.confirmText ?? '确认',
      cancelText: options.cancelText ?? '取消',
      tone: options.tone ?? 'primary',
    };
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function resolveConfirm(ok: boolean) {
    confirmState.value.open = false;
    const fn = confirmResolver;
    confirmResolver = null;
    fn?.(ok);
  }

  async function refresh() {
    error.value = null;
    try {
      bootstrap.value = await api.bootstrap();
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载站点数据';
    } finally {
      loading.value = false;
    }
  }

  function setQuota(q: QuotaSnapshot) {
    if (bootstrap.value) {
      bootstrap.value = { ...bootstrap.value, quota: q };
    }
  }

  function setUser(u: User | null) {
    if (bootstrap.value) {
      bootstrap.value = { ...bootstrap.value, user: u };
    }
  }

  function openAuth(mode: 'login' | 'register' = 'login') {
    authDialogMode.value = mode;
  }

  function closeAuth() {
    authDialogMode.value = null;
  }

  function openNewChat(preselectCharId?: string) {
    if (!user.value) {
      openAuth('login');
      return;
    }
    newChatPreselectId.value = preselectCharId ?? null;
    newChatModalOpen.value = true;
  }

  function closeNewChat() {
    newChatModalOpen.value = false;
    newChatPreselectId.value = null;
  }

  async function logout() {
    try {
      await api.logout();
      clearConversationCache();
      await refresh();
      notify('已安全退出登录', 'info');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '退出登录失败，请稍后重试', 'error');
    }
  }

  return {
    bootstrap,
    loading,
    error,
    theme,
    authDialogMode,
    newChatModalOpen,
    newChatPreselectId,
    toast,
    confirmState,
    user,
    isAdmin,
    characters,
    conversations,
    announcements,
    quota,
    settings,
    stats,
    initTheme,
    applyTheme,
    toggleTheme,
    notify,
    dismissToast,
    confirm,
    resolveConfirm,
    refresh,
    setQuota,
    setUser,
    openAuth,
    closeAuth,
    openNewChat,
    closeNewChat,
    logout,
  };
});
