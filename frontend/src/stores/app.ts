import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '../lib/api';
import { clearConversationCache } from '../lib/conversationCache';
import type { Bootstrap, PlatformSettings, QuotaSnapshot, User } from '../lib/types';

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
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

export const useAppStore = defineStore('app', () => {
  const bootstrap = ref<Bootstrap | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const theme = ref<'light' | 'dark'>('light');
  const authDialogMode = ref<'login' | 'register' | null>(null);
  const newChatModalOpen = ref(false);
  const newChatPreselectId = ref<string | null>(null);
  const toasts = ref<ToastMessage[]>([]);
  let toastSeq = 1;

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

  function applyTheme(next: 'light' | 'dark') {
    theme.value = next;
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = next;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('chatpony-theme', next);
    }
  }

  function initTheme() {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('chatpony-theme');
      if (saved === 'dark' || saved === 'light') {
        applyTheme(saved);
        return;
      }
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
    } else {
      applyTheme('light');
    }
  }

  function toggleTheme() {
    applyTheme(theme.value === 'dark' ? 'light' : 'dark');
  }

  function notify(text: string, tone: 'info' | 'success' | 'error' = 'info') {
    const id = toastSeq++;
    toasts.value.push({ id, text, tone });
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, 3600);
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
    await api.logout();
    clearConversationCache();
    await refresh();
    notify('已安全退出登录', 'info');
  }

  return {
    bootstrap,
    loading,
    error,
    theme,
    authDialogMode,
    newChatModalOpen,
    newChatPreselectId,
    toasts,
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
