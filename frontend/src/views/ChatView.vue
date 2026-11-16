<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError, copyText, newRequestId, streamChatMessage } from '../lib/api';
import {
  deleteCachedConversation,
  getCachedConversation,
  setCachedConversation,
} from '../lib/conversationCache';
import { formatDateTime, messageBubbles, parseActionSegments } from '../lib/display';
import type { Attachment, Character, ConversationDetail, Message } from '../lib/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const convId = computed(() => String(route.params.id ?? ''));
const detail = ref<ConversationDetail | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const draft = ref('');
const pendingAttachments = ref<Attachment[]>([]);
const uploadingImg = ref(false);
const streaming = ref(false);
const statusText = ref('');
const liveStream = ref<{ streamId: string; characterId: string; text: string } | null>(null);
const errorBanner = ref('');
const copiedMsgId = ref<string | null>(null);
const lightboxUrl = ref<string | null>(null);
const inspectorOpen = ref(false);
const draggingFile = ref(false);
const settingsForm = ref({ title: '', maxRounds: 4, summary: '' });
const savingSettings = ref(false);

const messagesEndEl = ref<HTMLElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
let abortCtrl: AbortController | null = null;

onUnmounted(() => {
  abortCtrl?.abort();
});

const charMap = computed(() => {
  const m = new Map<string, Character>();
  for (const c of detail.value?.characters ?? []) {
    m.set(c.id, c);
  }
  return m;
});

const supportsImageInput = computed(() => {
  if (!store.settings.imageInputEnabled) return false;
  return (detail.value?.characters ?? []).some((c) => c.imageInput !== false);
});

async function loadConversation(id: string) {
  if (!id || !store.user) {
    loading.value = false;
    return;
  }
  errorBanner.value = '';
  const cached = getCachedConversation(id);
  if (cached) {
    detail.value = cached;
    loading.value = false;
  } else {
    loading.value = true;
  }

  try {
    const fresh = await api.getConversation(id, { limit: 60 });
    detail.value = fresh;
    setCachedConversation(id, fresh);
    settingsForm.value = {
      title: fresh.conversation.title,
      maxRounds: fresh.conversation.maxRounds,
      summary: fresh.conversation.summary,
    };
    await nextTick();
    scrollToBottom();
  } catch (err) {
    errorBanner.value = err instanceof ApiError ? err.message : '加载对话失败';
  } finally {
    loading.value = false;
  }
}

watch(
  [convId, () => store.user?.id],
  ([id]) => {
    abortCtrl?.abort();
    streaming.value = false;
    liveStream.value = null;
    statusText.value = '';
    pendingAttachments.value = [];
    loadConversation(id);
  },
  { immediate: true }
);

function scrollToBottom() {
  messagesEndEl.value?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function loadEarlier() {
  if (!detail.value || !detail.value.hasMore || loadingMore.value) return;
  const firstId = detail.value.messages[0]?.id;
  if (!firstId) return;
  loadingMore.value = true;
  try {
    const older = await api.getConversation(convId.value, { limit: 60, before: firstId });
    detail.value = {
      ...detail.value,
      messages: [...older.messages, ...detail.value.messages],
      hasMore: older.hasMore,
    };
    setCachedConversation(convId.value, detail.value);
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '加载更早消息失败', 'error');
  } finally {
    loadingMore.value = false;
  }
}

function insertMention(name: string) {
  const suffix = draft.value && !draft.value.endsWith(' ') ? ` @${name} ` : `@${name} `;
  draft.value += suffix;
}

async function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) await uploadFiles(files);
}

function onDropFiles(e: DragEvent) {
  draggingFile.value = false;
  if (!supportsImageInput.value || streaming.value) return;
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length) uploadFiles(files);
}

function onPasteComposer(e: ClipboardEvent) {
  if (!supportsImageInput.value || streaming.value) return;
  const files: File[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
}

async function uploadFiles(files: File[]) {
  const maxAllowed = store.settings.maxImagesPerMessage || 4;
  if (pendingAttachments.value.length + files.length > maxAllowed) {
    store.notify(`单条消息最多附加 ${maxAllowed} 张图片`, 'error');
    return;
  }
  uploadingImg.value = true;
  try {
    for (const f of files) {
      const att = await api.uploadAttachment(convId.value, f);
      pendingAttachments.value.push(att);
    }
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '图片上传失败', 'error');
  } finally {
    uploadingImg.value = false;
  }
}

function removePendingAtt(id: string) {
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id);
}

async function handleSend(retryOfId?: string) {
  if (!detail.value || streaming.value) return;
  const text = retryOfId ? '' : draft.value.trim();
  const attIds = retryOfId ? [] : pendingAttachments.value.map((a) => a.id);
  if (!retryOfId && !text && !attIds.length) return;

  errorBanner.value = '';
  streaming.value = true;
  statusText.value = '正在准备回复...';
  const reqId = newRequestId();
  const savedDraft = draft.value;
  const savedAtts = [...pendingAttachments.value];

  if (!retryOfId) {
    draft.value = '';
    pendingAttachments.value = [];
  }

  abortCtrl = new AbortController();

  try {
    await streamChatMessage(
      convId.value,
      { content: text, requestId: reqId, attachmentIds: attIds, retryOf: retryOfId },
      async (ev) => {
        if (!detail.value) return;
        if (ev.type === 'user') {
          if (!detail.value.messages.some((m) => m.id === ev.message.id)) {
            detail.value.messages.push(ev.message);
          }
          await nextTick();
          scrollToBottom();
        } else if (ev.type === 'status') {
          statusText.value = ev.text;
        } else if (ev.type === 'stream-start') {
          statusText.value = '';
          liveStream.value = { streamId: ev.streamId, characterId: ev.characterId, text: '' };
          await nextTick();
          scrollToBottom();
        } else if (ev.type === 'delta') {
          if (liveStream.value?.streamId === ev.streamId) {
            liveStream.value.text += ev.text;
          }
          scrollToBottom();
        } else if (ev.type === 'stream-end') {
          liveStream.value = null;
        } else if (ev.type === 'message') {
          liveStream.value = null;
          if (!detail.value.messages.some((m) => m.id === ev.message.id)) {
            detail.value.messages.push(ev.message);
          }
          setCachedConversation(convId.value, detail.value);
          await nextTick();
          scrollToBottom();
        } else if (ev.type === 'error') {
          errorBanner.value = ev.message;
        } else if (ev.type === 'done') {
          statusText.value = '';
          liveStream.value = null;
          store.setQuota(ev.quota);
          if (ev.limited) {
            store.notify('本轮群聊已达最大连续响应轮数上限', 'info');
          }
          await store.refresh();
        }
      },
      abortCtrl.signal
    );
    if (retryOfId) {
      await loadConversation(convId.value);
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      errorBanner.value = err instanceof ApiError ? err.message : '发送消息时出现网络异常';
      if (!retryOfId) {
        draft.value = savedDraft;
        pendingAttachments.value = savedAtts;
      }
    }
  } finally {
    streaming.value = false;
    statusText.value = '';
    liveStream.value = null;
    abortCtrl = null;
  }
}

function stopStreaming() {
  abortCtrl?.abort();
  streaming.value = false;
  liveStream.value = null;
  statusText.value = '';
}

function onKeydownComposer(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

async function onCopyMessage(m: Message) {
  const ok = await copyText(m.content);
  if (ok) {
    copiedMsgId.value = m.id;
    setTimeout(() => {
      if (copiedMsgId.value === m.id) copiedMsgId.value = null;
    }, 1500);
  }
}

async function saveDialogueSettings() {
  savingSettings.value = true;
  try {
    const updated = await api.updateConversation(convId.value, {
      title: settingsForm.value.title,
      maxRounds: settingsForm.value.maxRounds,
      summary: settingsForm.value.summary,
    });
    if (detail.value) {
      detail.value.conversation = updated;
      setCachedConversation(convId.value, detail.value);
    }
    await store.refresh();
    store.notify('会话设置已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存设置失败', 'error');
  } finally {
    savingSettings.value = false;
  }
}

async function clearMessages() {
  if (!window.confirm('确定清空当前会话的全部消息与摘要吗？此操作无法撤销。')) return;
  try {
    await api.clearConversationMessages(convId.value);
    await loadConversation(convId.value);
    await store.refresh();
    store.notify('已清空会话消息', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '清空失败', 'error');
  }
}

async function deleteConv() {
  if (!window.confirm('确定删除整条会话记录吗？')) return;
  try {
    await api.deleteConversation(convId.value);
    deleteCachedConversation(convId.value);
    await store.refresh();
    router.push('/conversations');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

function isContinuation(idx: number): boolean {
  const list = detail.value?.messages ?? [];
  const cur = list[idx];
  const prev = list[idx - 1];
  if (!cur || !prev) return false;
  if (cur.role !== prev.role) return false;
  if (cur.role === 'assistant' && cur.characterId !== prev.characterId) return false;
  return Date.parse(cur.createdAt) - Date.parse(prev.createdAt) < 5 * 60 * 1000;
}

function autoGrow(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

watch(draft, (v) => {
  if (!v) {
    nextTick(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.cp-composer-input');
      if (el) el.style.height = 'auto';
    });
  }
});

function bubblesForMessage(m: Message): string[] {
  return messageBubbles(
    m.content,
    m.role === 'assistant' ? store.settings.bubbleDelimiter : '',
    store.settings.hiddenSymbols
  );
}
</script>

<template>
  <div
    class="cp-chat-root"
    @dragover.prevent="draggingFile = true"
    @dragleave.self="draggingFile = false"
    @drop.prevent="onDropFiles"
  >
    <div v-if="!store.user" class="cp-page cp-page--narrow">
      <EmptyState icon="mdi-message-text-outline" title="登录后开始对话" description="登录账号即可继续对话、管理群聊与长期记忆。">
        <template #action>
          <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
        </template>
      </EmptyState>
    </div>

    <template v-else-if="detail">
      <!-- Header -->
      <header class="cp-chat-head">
        <v-btn
          icon="mdi-arrow-left"
          variant="text"
          size="small"
          class="d-md-none"
          aria-label="返回对话列表"
          @click="router.push('/conversations')"
        />
        <div class="cp-stack">
          <AvatarBadge
            v-for="c in detail.characters.slice(0, 3)"
            :key="c.id"
            :name="c.name"
            :avatar="c.avatar"
            :color="c.color"
            :size="34"
            ring
          />
        </div>
        <div class="flex-grow-1 min-width-0">
          <div class="d-flex align-center ga-2">
            <span class="cp-chat-head__title text-truncate">{{ detail.conversation.title }}</span>
            <span v-if="detail.conversation.kind === 'group'" class="cp-pill cp-pill--secondary cp-pill--hide-xs">
              群聊 · {{ detail.characters.length }}
            </span>
            <span v-if="supportsImageInput" class="cp-pill cp-pill--hide-xs" title="支持识图">
              <v-icon icon="mdi-image-outline" size="12" />识图
            </span>
          </div>
          <div class="cp-chat-head__sub text-truncate">
            {{ detail.characters.map((c) => c.name).join('、') }}
          </div>
        </div>
        <v-btn
          icon
          variant="text"
          size="small"
          aria-label="会话详情"
          :color="inspectorOpen ? 'primary' : undefined"
          @click="inspectorOpen = !inspectorOpen"
        >
          <v-icon icon="mdi-dock-right" size="20" />
          <v-tooltip activator="parent" location="bottom">会话详情</v-tooltip>
        </v-btn>
      </header>

      <!-- Messages -->
      <div class="cp-chat-scroll">
        <div class="cp-chat-thread">
          <div v-if="detail.hasMore" class="text-center mb-2">
            <v-btn variant="text" size="small" :loading="loadingMore" prepend-icon="mdi-history" @click="loadEarlier">
              加载更早消息
            </v-btn>
          </div>

          <div v-if="detail.conversation.summary" class="cp-summary">
            <div class="cp-summary__label">
              <v-icon icon="mdi-book-open-page-variant-outline" size="14" />
              前情摘要
            </div>
            <div class="cp-summary__body">{{ detail.conversation.summary }}</div>
          </div>

          <div
            v-if="!detail.messages.length && !liveStream"
            class="cp-chat-intro"
          >
            <div class="cp-stack mb-4">
              <AvatarBadge
                v-for="c in detail.characters.slice(0, 4)"
                :key="c.id"
                :name="c.name"
                :avatar="c.avatar"
                :color="c.color"
                :size="56"
                ring
              />
            </div>
            <div class="text-title-medium font-weight-bold mb-1">{{ detail.conversation.title }}</div>
            <div class="text-body-medium cp-muted">
              {{ detail.characters.length > 1 ? '在下方输入消息，用 @ 点名让某位角色回应。' : '说点什么，开启你们的故事吧。' }}
            </div>
          </div>

          <div
            v-for="(msg, idx) in detail.messages"
            :key="msg.id"
            class="cp-msg"
            :class="[`cp-msg--${msg.role === 'user' ? 'user' : 'ai'}`, { 'is-cont': isContinuation(idx) }]"
          >
            <!-- User -->
            <template v-if="msg.role === 'user'">
              <div class="cp-msg__col align-end">
                <div v-if="msg.attachments?.length" class="d-flex flex-wrap ga-2 justify-end">
                  <v-img
                    v-for="att in msg.attachments"
                    :key="att.id"
                    :src="`/api/attachments/${att.id}`"
                    width="160"
                    height="160"
                    cover
                    rounded="lg"
                    class="cp-msg__img"
                    @click="lightboxUrl = `/api/attachments/${att.id}`"
                  />
                </div>
                <div v-if="msg.content" class="cp-bubble cp-bubble--user">{{ msg.content }}</div>
                <div class="cp-msg__meta">
                  <span>{{ formatDateTime(msg.createdAt) }}</span>
                </div>
              </div>
            </template>

            <!-- Assistant -->
            <template v-else>
              <div class="cp-msg__avatar">
                <AvatarBadge
                  v-if="!isContinuation(idx)"
                  :name="charMap.get(msg.characterId ?? '')?.name ?? '角色'"
                  :avatar="charMap.get(msg.characterId ?? '')?.avatar"
                  :color="charMap.get(msg.characterId ?? '')?.color"
                  :size="34"
                />
              </div>
              <div class="cp-msg__col align-start">
                <span v-if="!isContinuation(idx)" class="cp-msg__name">
                  {{ charMap.get(msg.characterId ?? '')?.name ?? '角色' }}
                </span>
                <div v-for="(bubble, bIdx) in bubblesForMessage(msg)" :key="bIdx" class="cp-bubble cp-bubble--ai">
                  <template
                    v-for="(seg, sIdx) in parseActionSegments(
                      bubble,
                      store.settings.actionStyleEnabled,
                      store.settings.actionMarkers,
                      store.settings.actionHideMarkers
                    )"
                    :key="sIdx"
                  >
                    <span v-if="seg.action" class="cp-action-text">{{ seg.text }}</span>
                    <span v-else>{{ seg.text }}</span>
                  </template>
                </div>
                <div class="cp-msg__meta">
                  <span>{{ formatDateTime(msg.createdAt) }}</span>
                  <button type="button" class="cp-msg__act" @click="onCopyMessage(msg)">
                    <v-icon :icon="copiedMsgId === msg.id ? 'mdi-check' : 'mdi-content-copy'" size="13" />
                    {{ copiedMsgId === msg.id ? '已复制' : '复制' }}
                  </button>
                  <button type="button" class="cp-msg__act" :disabled="streaming" @click="handleSend(msg.id)">
                    <v-icon icon="mdi-refresh" size="13" />
                    重新生成
                  </button>
                </div>
              </div>
            </template>
          </div>

          <!-- Live streaming reply -->
          <div v-if="liveStream" class="cp-msg cp-msg--ai">
            <div class="cp-msg__avatar">
              <AvatarBadge
                :name="charMap.get(liveStream.characterId)?.name ?? '角色'"
                :avatar="charMap.get(liveStream.characterId)?.avatar"
                :color="charMap.get(liveStream.characterId)?.color"
                :size="34"
              />
            </div>
            <div class="cp-msg__col align-start">
              <span class="cp-msg__name">{{ charMap.get(liveStream.characterId)?.name ?? '角色' }}</span>
              <div class="cp-bubble cp-bubble--ai">
                <template v-if="liveStream.text">
                  <template
                    v-for="(seg, sIdx) in parseActionSegments(
                      liveStream.text,
                      store.settings.actionStyleEnabled,
                      store.settings.actionMarkers,
                      store.settings.actionHideMarkers
                    )"
                    :key="sIdx"
                  >
                    <span v-if="seg.action" class="cp-action-text">{{ seg.text }}</span>
                    <span v-else>{{ seg.text }}</span>
                  </template>
                  <span class="cp-caret" />
                </template>
                <span v-else class="cp-typing" aria-label="正在输入"><i /><i /><i /></span>
              </div>
            </div>
          </div>

          <div v-if="statusText" class="cp-status">
            <span class="cp-typing cp-typing--sm"><i /><i /><i /></span>
            {{ statusText }}
          </div>

          <v-alert
            v-if="errorBanner"
            type="error"
            variant="tonal"
            density="compact"
            closable
            class="mt-2"
            @click:close="errorBanner = ''"
          >
            {{ errorBanner }}
          </v-alert>

          <div ref="messagesEndEl" style="height:4px" />
        </div>
      </div>

      <!-- Composer -->
      <div class="cp-composer-wrap">
        <div class="cp-composer-inner">
          <div v-if="pendingAttachments.length" class="d-flex flex-wrap ga-2 mb-2">
            <div v-for="att in pendingAttachments" :key="att.id" class="cp-pending">
              <v-img :src="`/api/attachments/${att.id}`" width="64" height="64" cover rounded="lg" />
              <button type="button" class="cp-pending__x" aria-label="移除图片" @click="removePendingAtt(att.id)">
                <v-icon icon="mdi-close" size="12" />
              </button>
            </div>
          </div>

          <div class="cp-composer" :class="{ 'is-busy': streaming }">
            <div v-if="detail.conversation.kind === 'group'" class="cp-mentions">
              <button
                v-for="c in detail.characters"
                :key="c.id"
                type="button"
                class="cp-mention"
                @click="insertMention(c.name)"
              >
                <span class="cp-mention__dot" :style="{ background: c.color || 'rgb(var(--v-theme-primary))' }" />
                @{{ c.name }}
              </button>
            </div>

            <input
              ref="fileInputEl"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              style="display:none"
              @change="onPickFiles"
            />

            <textarea
              v-model="draft"
              class="cp-composer-input"
              rows="1"
              :placeholder="detail.conversation.kind === 'group' ? '发消息，或 @ 点名某位角色…' : `给 ${detail.characters[0]?.name ?? '角色'} 发消息…`"
              @input="autoGrow"
              @keydown="onKeydownComposer"
              @paste="onPasteComposer"
            />

            <div class="cp-composer__bar">
              <v-btn
                v-if="supportsImageInput"
                icon
                variant="text"
                size="small"
                density="comfortable"
                :disabled="uploadingImg || streaming"
                :loading="uploadingImg"
                aria-label="添加图片"
                @click="fileInputEl?.click()"
              >
                <v-icon icon="mdi-image-plus-outline" size="20" />
                <v-tooltip activator="parent">添加图片（也可粘贴或拖入）</v-tooltip>
              </v-btn>
              <span class="cp-composer__hint d-none d-sm-inline">Enter 发送 · Shift+Enter 换行 · 以「记住：」开头可写入记忆</span>
              <v-spacer />
              <v-btn
                v-if="streaming"
                variant="tonal"
                size="small"
                prepend-icon="mdi-stop-circle-outline"
                @click="stopStreaming"
              >
                停止
              </v-btn>
              <v-btn
                v-else
                icon
                color="primary"
                variant="flat"
                size="small"
                :disabled="(!draft.trim() && pendingAttachments.length === 0) || uploadingImg"
                aria-label="发送消息"
                class="cp-send"
                @click="handleSend()"
              >
                <v-icon icon="mdi-arrow-up" size="20" />
              </v-btn>
            </div>
          </div>
        </div>
      </div>

      <!-- Inspector -->
      <v-navigation-drawer
        v-model="inspectorOpen"
        location="right"
        temporary
        width="360"
        color="surface"
        class="cp-inspector"
      >
        <div class="d-flex flex-column fill-height">
          <div class="cp-inspector__head">
            <div class="text-title-medium font-weight-bold">会话详情</div>
            <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="inspectorOpen = false" />
          </div>

          <div class="cp-inspector__body">
            <div class="cp-inspector__label">参与角色</div>
            <div class="d-flex flex-column ga-1 mb-6">
              <div v-for="c in detail.characters" :key="c.id" class="cp-member">
                <AvatarBadge :name="c.name" :avatar="c.avatar" :color="c.color" :size="36" rounded="lg" />
                <div class="flex-grow-1 min-width-0">
                  <div class="text-title-small font-weight-bold">{{ c.name }}</div>
                  <div class="text-body-small cp-muted text-truncate">{{ c.description || `@${c.slug}` }}</div>
                </div>
                <v-btn to="/memories" icon variant="text" size="small" aria-label="查看记忆档案">
                  <v-icon icon="mdi-brain" size="18" />
                  <v-tooltip activator="parent">记忆档案</v-tooltip>
                </v-btn>
              </div>
            </div>

            <div class="cp-inspector__label">设置</div>
            <v-form class="d-flex flex-column ga-4" @submit.prevent="saveDialogueSettings">
              <v-text-field v-model="settingsForm.title" label="会话标题" required maxlength="80" />
              <div v-if="detail.conversation.kind === 'group'">
                <div class="d-flex justify-space-between text-body-small cp-muted mb-1">
                  <span>单轮最大响应数</span>
                  <strong>{{ settingsForm.maxRounds }}</strong>
                </div>
                <v-slider
                  v-model="settingsForm.maxRounds"
                  :min="1"
                  :max="store.settings.maxGroupRounds"
                  :step="1"
                  color="primary"
                  hide-details
                />
              </div>
              <v-textarea v-model="settingsForm.summary" label="前情摘要" rows="5" maxlength="4000" auto-grow />
              <v-btn type="submit" color="primary" variant="flat" :loading="savingSettings">保存设置</v-btn>
            </v-form>
          </div>

          <div class="cp-inspector__foot">
            <div class="cp-inspector__label">危险操作</div>
            <div class="d-flex ga-2">
              <v-btn variant="outlined" class="flex-grow-1 cp-btn-quiet" prepend-icon="mdi-broom" @click="clearMessages">
                清空消息
              </v-btn>
              <v-btn color="error" variant="tonal" class="flex-grow-1" prepend-icon="mdi-trash-can-outline" @click="deleteConv">
                删除会话
              </v-btn>
            </div>
          </div>
        </div>
      </v-navigation-drawer>
    </template>

    <div v-else-if="loading" class="cp-chat-loading">
      <v-progress-circular indeterminate color="primary" size="28" width="3" />
    </div>

    <div v-else class="cp-page cp-page--narrow">
      <EmptyState icon="mdi-message-off-outline" title="会话不存在或无权访问" description="可能已被删除或链接无效。">
        <template #action>
          <v-btn color="primary" @click="router.push('/conversations')">返回对话列表</v-btn>
        </template>
      </EmptyState>
    </div>

    <!-- Drag overlay -->
    <transition name="fade-transition">
      <div v-if="draggingFile && supportsImageInput" class="cp-drop">
        <div class="cp-drop__inner">
          <v-icon icon="mdi-tray-arrow-down" size="28" />
          <span>松开即可附加图片</span>
        </div>
      </div>
    </transition>

    <!-- Lightbox -->
    <v-dialog :model-value="lightboxUrl !== null" max-width="960" @update:model-value="lightboxUrl = null">
      <div v-if="lightboxUrl" class="cp-lightbox" @click="lightboxUrl = null">
        <v-img :src="lightboxUrl" max-height="88dvh" contain rounded="lg" />
      </div>
    </v-dialog>
  </div>
</template>

<style scoped>
.cp-chat-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100dvh;
}
@media (max-width: 959px) {
  .cp-chat-root {
    height: calc(100dvh - var(--v-layout-top, 0px));
  }
  .cp-chat-head {
    padding: 8px 8px 8px 4px;
    gap: 8px;
  }
  .cp-chat-thread {
    padding: 16px 14px 8px;
  }
  .cp-msg__col {
    max-width: 84%;
  }
  .cp-composer-wrap {
    padding: 6px 10px calc(10px + env(safe-area-inset-bottom));
  }
}

/* Header */
.cp-chat-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 10px 16px 10px 20px;
  background: rgba(var(--v-theme-background), 0.82);
  backdrop-filter: saturate(1.4) blur(14px);
  border-bottom: 1px solid var(--cp-hairline);
}
.cp-chat-head__title {
  font-size: 0.9375rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.cp-chat-head__sub {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.55);
}
.cp-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 6px;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.1);
}
@media (max-width: 599px) {
  .cp-pill--hide-xs {
    display: none;
  }
}
.cp-pill--secondary {
  color: rgb(var(--v-theme-secondary));
  background: rgba(var(--v-theme-secondary), 0.12);
}

/* Thread */
.cp-chat-scroll {
  flex: 1;
  overflow-y: auto;
}
.cp-chat-thread {
  max-width: 780px;
  margin: 0 auto;
  padding: 32px 18px 16px;
  display: flex;
  flex-direction: column;
}
.cp-chat-intro {
  text-align: center;
  padding: 48px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.cp-summary {
  margin-bottom: 24px;
  padding: 14px 16px;
  border-radius: var(--cp-radius-md);
  background: rgba(var(--v-theme-secondary), 0.07);
  border: 1px solid rgba(var(--v-theme-secondary), 0.16);
}
.cp-summary__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  color: rgb(var(--v-theme-secondary));
  margin-bottom: 4px;
}
.cp-summary__body {
  font-size: 0.875rem;
  line-height: 1.65;
  color: rgba(var(--v-theme-on-surface), 0.75);
  white-space: pre-wrap;
}

.cp-msg {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  animation: cp-rise 0.3s var(--cp-ease) both;
}
.cp-msg.is-cont {
  margin-top: -4px;
}
.cp-msg--user + .cp-msg--ai,
.cp-msg--ai + .cp-msg--user {
  margin-top: 14px;
}
.cp-msg.is-cont .cp-msg__col {
  gap: 4px;
}
.cp-msg--user {
  justify-content: flex-end;
}
.cp-msg__avatar {
  width: 34px;
  flex-shrink: 0;
}
.cp-msg__col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(78%, 620px);
  min-width: 0;
}
.cp-msg__name {
  font-size: 0.75rem;
  font-weight: 700;
  color: rgba(var(--v-theme-on-surface), 0.6);
  padding-left: 2px;
}
.cp-msg__img {
  cursor: zoom-in;
  border: 1px solid var(--cp-hairline);
}

.cp-bubble {
  padding: 10px 14px;
  font-size: 0.9375rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 18px;
}
.cp-bubble--ai {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--cp-hairline);
  border-top-left-radius: 6px;
}
.cp-bubble--ai + .cp-bubble--ai {
  border-top-left-radius: 6px;
}
.cp-bubble--user {
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
  border-top-right-radius: 6px;
}
.cp-bubble--user ::selection {
  background: rgba(255, 255, 255, 0.3);
}

.cp-msg__meta {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 18px;
  margin-top: -2px;
  font-size: 0.6875rem;
  color: rgba(var(--v-theme-on-surface), 0.42);
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.cp-msg:hover .cp-msg__meta,
.cp-msg:focus-within .cp-msg__meta,
.cp-msg:last-of-type .cp-msg__meta {
  opacity: 1;
}
@media (hover: none) {
  .cp-msg__meta {
    opacity: 1;
  }
}
.cp-msg__meta > span {
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
}
.cp-msg__act {
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.cp-msg__act:hover:not(:disabled) {
  background: rgba(var(--v-theme-on-surface), 0.06);
  color: rgb(var(--v-theme-on-surface));
}
.cp-msg__act:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Typing indicator */
.cp-typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 1.7em;
}
.cp-typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.4);
  animation: cp-blink 1.2s infinite ease-in-out both;
}
.cp-typing i:nth-child(2) {
  animation-delay: 0.15s;
}
.cp-typing i:nth-child(3) {
  animation-delay: 0.3s;
}
.cp-typing--sm i {
  width: 4px;
  height: 4px;
}
@keyframes cp-blink {
  0%,
  80%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}
.cp-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.12em;
  background: rgb(var(--v-theme-primary));
  animation: cp-caret 1s steps(2) infinite;
}
@keyframes cp-caret {
  50% {
    opacity: 0;
  }
}
.cp-status {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0 0 46px;
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

/* Composer */
.cp-composer-wrap {
  padding: 8px 16px 18px;
  background: linear-gradient(180deg, rgba(var(--v-theme-background), 0) 0%, rgb(var(--v-theme-background)) 30%);
}
.cp-composer-inner {
  max-width: 780px;
  margin: 0 auto;
}
.cp-composer {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--cp-hairline);
  border-radius: 20px;
  box-shadow: var(--cp-shadow-md);
  padding: 10px 10px 8px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cp-composer:focus-within {
  border-color: rgba(var(--v-theme-primary), 0.45);
  box-shadow: 0 0 0 4px rgba(var(--v-theme-primary), 0.08), var(--cp-shadow-md);
}
.cp-composer-input {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  resize: none;
  font: inherit;
  font-size: 0.9375rem;
  line-height: 1.6;
  padding: 4px 2px;
  min-height: 28px;
  max-height: 200px;
}
.cp-composer-input::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.4);
}
.cp-composer__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  margin-left: -6px;
}
.cp-composer__hint {
  font-size: 0.6875rem;
  color: rgba(var(--v-theme-on-surface), 0.38);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-send {
  border-radius: 12px !important;
}
.cp-mentions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
  margin-bottom: 4px;
  border-bottom: 1px dashed var(--cp-hairline);
}
.cp-mention {
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.72);
  background: rgba(var(--v-theme-on-surface), 0.05);
  cursor: pointer;
  transition: background 0.15s;
}
.cp-mention:hover {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.cp-mention__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.cp-pending {
  position: relative;
}
.cp-pending__x {
  border: 0;
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: rgba(0, 0, 0, 0.7);
  cursor: pointer;
}

/* Inspector */
.cp-inspector {
  border-left: 1px solid var(--cp-hairline) !important;
}
.cp-inspector__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 12px 12px 20px;
  border-bottom: 1px solid var(--cp-hairline);
}
.cp-inspector__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
.cp-inspector__foot {
  padding: 16px 20px 20px;
  border-top: 1px solid var(--cp-hairline);
}
.cp-inspector__label {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  margin-bottom: 10px;
}
.cp-member {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  margin: 0 -8px;
  border-radius: 12px;
  transition: background 0.15s;
}
.cp-member:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.cp-btn-quiet {
  border-color: var(--cp-hairline) !important;
}

/* Misc */
.cp-chat-loading {
  flex: 1;
  display: grid;
  place-items: center;
}
.cp-drop {
  position: absolute;
  inset: 12px;
  z-index: 20;
  display: grid;
  place-items: center;
  border-radius: 24px;
  border: 2px dashed rgba(var(--v-theme-primary), 0.5);
  background: rgba(var(--v-theme-background), 0.85);
  backdrop-filter: blur(6px);
  pointer-events: none;
}
.cp-drop__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  color: rgb(var(--v-theme-primary));
}
.cp-lightbox {
  cursor: zoom-out;
}
</style>
