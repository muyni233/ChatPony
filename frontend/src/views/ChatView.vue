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
    <v-container v-if="!store.user" class="pa-8" style="max-width:560px">
      <EmptyState icon="mdi-message-text-outline" title="登录后开始对话" description="登录账号即可继续对话、管理群聊与长期记忆。">
        <template #action>
          <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
        </template>
      </EmptyState>
    </v-container>

    <template v-else-if="detail">
      <!-- Top Conversation Toolbar -->
      <v-toolbar color="surface-light" density="comfortable" class="px-3">
        <div class="d-flex align-center ga-3 flex-grow-1" style="min-width:0">
          <div class="d-flex align-center">
            <AvatarBadge
              v-for="c in detail.characters.slice(0, 3)"
              :key="c.id"
              :name="c.name"
              :avatar="c.avatar"
              :color="c.color"
              :size="34"
              rounded="lg"
              class="mr-1"
            />
          </div>
          <div style="min-width:0">
            <div class="d-flex align-center ga-2">
              <span class="text-subtitle-1 font-weight-bold text-truncate">{{ detail.conversation.title }}</span>
              <v-chip size="x-small" :color="detail.conversation.kind === 'group' ? 'secondary' : 'primary'" variant="tonal">
                {{ detail.conversation.kind === 'group' ? `群聊 · ${detail.characters.length} 人` : '私聊' }}
              </v-chip>
              <v-chip v-if="supportsImageInput" size="x-small" color="success" variant="tonal">识图</v-chip>
            </div>
            <div class="text-caption text-medium-emphasis text-truncate">
              {{ detail.characters.map((c) => c.name).join(' · ') }}
            </div>
          </div>
        </div>

        <v-btn
          variant="tonal"
          color="primary"
          size="small"
          prepend-icon="mdi-tune-variant"
          @click="inspectorOpen = !inspectorOpen"
        >
          会话详情
        </v-btn>
      </v-toolbar>

      <!-- Messages Stream -->
      <div class="cp-chat-scroll">
        <v-container style="max-width:820px" class="py-4 d-flex flex-column ga-4">
          <div v-if="detail.hasMore" class="text-center">
            <v-btn variant="tonal" size="small" :loading="loadingMore" @click="loadEarlier">
              加载更早消息
            </v-btn>
          </div>

          <v-alert
            v-if="detail.conversation.summary"
            color="secondary"
            variant="tonal"
            density="comfortable"
            icon="mdi-book-open-page-variant-outline"
          >
            <strong>剧情摘要：</strong>{{ detail.conversation.summary }}
          </v-alert>

          <div
            v-for="msg in detail.messages"
            :key="msg.id"
            class="d-flex ga-3"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <template v-if="msg.role === 'user'">
              <div class="d-flex flex-column align-end ga-1" style="max-width:78%">
                <div v-if="msg.attachments?.length" class="d-flex flex-wrap ga-2 justify-end">
                  <v-img
                    v-for="att in msg.attachments"
                    :key="att.id"
                    :src="`/api/attachments/${att.id}`"
                    width="148"
                    height="148"
                    cover
                    rounded="lg"
                    class="cursor-pointer elevation-1"
                    @click="lightboxUrl = `/api/attachments/${att.id}`"
                  />
                </div>
                <v-sheet
                  v-if="msg.content"
                  color="primary"
                  rounded="xl"
                  class="px-4 py-3 text-body-1"
                  style="white-space:pre-wrap;word-break:break-word;border-bottom-right-radius:6px !important"
                >
                  {{ msg.content }}
                </v-sheet>
                <span class="text-caption text-medium-emphasis px-1">{{ formatDateTime(msg.createdAt) }}</span>
              </div>
              <AvatarBadge :name="store.user.name" :avatar="store.user.avatar" :size="36" />
            </template>

            <template v-else>
              <AvatarBadge
                :name="charMap.get(msg.characterId ?? '')?.name ?? '角色'"
                :avatar="charMap.get(msg.characterId ?? '')?.avatar"
                :color="charMap.get(msg.characterId ?? '')?.color"
                :size="36"
                rounded="lg"
              />
              <div class="d-flex flex-column align-start ga-1" style="max-width:78%">
                <span class="text-caption font-weight-bold text-medium-emphasis px-1">
                  {{ charMap.get(msg.characterId ?? '')?.name ?? '角色' }}
                </span>
                <v-card
                  v-for="(bubble, idx) in bubblesForMessage(msg)"
                  :key="idx"
                  color="surface"
                  elevation="1"
                  class="px-4 py-3 text-body-1"
                  style="white-space:pre-wrap;word-break:break-word;border-top-left-radius:6px !important"
                >
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
                </v-card>
                <div class="d-flex align-center ga-1 text-caption text-medium-emphasis">
                  <span class="px-1">{{ formatDateTime(msg.createdAt) }}</span>
                  <v-btn
                    size="x-small"
                    variant="text"
                    :prepend-icon="copiedMsgId === msg.id ? 'mdi-check' : 'mdi-content-copy'"
                    @click="onCopyMessage(msg)"
                  >
                    {{ copiedMsgId === msg.id ? '已复制' : '复制' }}
                  </v-btn>
                  <v-btn
                    size="x-small"
                    variant="text"
                    prepend-icon="mdi-refresh"
                    :disabled="streaming"
                    @click="handleSend(msg.id)"
                  >
                    重新生成
                  </v-btn>
                </div>
              </div>
            </template>
          </div>

          <!-- Live Streaming Reply -->
          <div v-if="liveStream" class="d-flex ga-3 justify-start">
            <AvatarBadge
              :name="charMap.get(liveStream.characterId)?.name ?? '角色'"
              :avatar="charMap.get(liveStream.characterId)?.avatar"
              :color="charMap.get(liveStream.characterId)?.color"
              :size="36"
              rounded="lg"
            />
            <div class="d-flex flex-column align-start ga-1" style="max-width:78%">
              <span class="text-caption font-weight-bold text-medium-emphasis px-1">
                {{ charMap.get(liveStream.characterId)?.name ?? '角色' }}
              </span>
              <v-card color="surface" elevation="1" class="px-4 py-3 text-body-1" style="white-space:pre-wrap">
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
                </template>
                <span v-else class="text-medium-emphasis">正在组织语言…</span>
              </v-card>
            </div>
          </div>

          <v-chip v-if="statusText" color="secondary" variant="tonal" class="align-self-start">
            <v-progress-circular indeterminate size="14" width="2" class="mr-2" />
            {{ statusText }}
          </v-chip>

          <v-alert v-if="errorBanner" type="error" variant="tonal" density="comfortable">
            {{ errorBanner }}
          </v-alert>

          <div ref="messagesEndEl" style="height:4px" />
        </v-container>
      </div>

      <!-- Composer Bar -->
      <div class="pa-3 pt-1">
        <v-container style="max-width:820px" class="pa-0">
          <div v-if="detail.conversation.kind === 'group'" class="d-flex align-center flex-wrap ga-1 mb-2">
            <span class="text-caption text-medium-emphasis mr-1">@点名：</span>
            <v-chip
              v-for="c in detail.characters"
              :key="c.id"
              size="small"
              variant="tonal"
              color="primary"
              @click="insertMention(c.name)"
            >
              @{{ c.name }}
            </v-chip>
          </div>

          <div v-if="pendingAttachments.length" class="d-flex flex-wrap ga-2 mb-2">
            <div v-for="att in pendingAttachments" :key="att.id" style="position:relative">
              <v-img :src="`/api/attachments/${att.id}`" width="64" height="64" cover rounded="lg" />
              <v-btn
                icon="mdi-close"
                size="x-small"
                color="error"
                style="position:absolute;top:-6px;right:-6px"
                aria-label="移除图片"
                @click="removePendingAtt(att.id)"
              />
            </div>
          </div>

          <v-card color="surface" elevation="2" rounded="xl" class="pa-2 d-flex align-end ga-2">
            <input
              ref="fileInputEl"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              style="display:none"
              @change="onPickFiles"
            />
            <v-btn
              v-if="supportsImageInput"
              icon="mdi-image-plus-outline"
              variant="text"
              :disabled="uploadingImg || streaming"
              title="上传或粘贴图片"
              @click="fileInputEl?.click()"
            />

            <textarea
              v-model="draft"
              class="cp-composer-input"
              rows="2"
              placeholder="写下你的消息…（Enter 发送，Shift+Enter 换行；可以说「记住：…」记录长期记忆）"
              @keydown="onKeydownComposer"
              @paste="onPasteComposer"
            />

            <v-btn
              v-if="streaming"
              color="error"
              variant="tonal"
              size="small"
              prepend-icon="mdi-stop"
              @click="stopStreaming"
            >
              停止
            </v-btn>
            <v-btn
              v-else
              icon="mdi-arrow-up"
              color="primary"
              :disabled="(!draft.trim() && pendingAttachments.length === 0) || uploadingImg"
              aria-label="发送消息"
              @click="handleSend()"
            />
          </v-card>
        </v-container>
      </div>

      <!-- Conversation Inspector Drawer -->
      <v-navigation-drawer v-model="inspectorOpen" location="right" temporary width="340" color="surface">
        <div class="pa-4 d-flex flex-column ga-4 fill-height">
          <div class="d-flex align-center justify-space-between">
            <div class="text-subtitle-1 font-weight-bold">会话详情与设置</div>
            <v-btn icon="mdi-close" variant="text" size="small" @click="inspectorOpen = false" />
          </div>

          <div>
            <div class="text-caption font-weight-bold text-medium-emphasis mb-2">参与角色</div>
            <v-list density="compact" class="pa-0 bg-transparent">
              <v-list-item v-for="c in detail.characters" :key="c.id" class="px-1">
                <template #prepend>
                  <AvatarBadge :name="c.name" :avatar="c.avatar" :color="c.color" :size="36" rounded="lg" class="mr-3" />
                </template>
                <v-list-item-title class="font-weight-bold text-body-2">{{ c.name }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ c.description || c.slug }}</v-list-item-subtitle>
                <template #append>
                  <v-btn to="/memories" icon="mdi-brain" variant="text" size="small" title="查看记忆档案" />
                </template>
              </v-list-item>
            </v-list>
          </div>

          <v-divider />

          <v-form class="d-flex flex-column ga-3" @submit.prevent="saveDialogueSettings">
            <v-text-field v-model="settingsForm.title" label="会话标题" required maxlength="80" />
            <div v-if="detail.conversation.kind === 'group'">
              <div class="text-caption text-medium-emphasis">单轮最大响应数：{{ settingsForm.maxRounds }}</div>
              <v-slider v-model="settingsForm.maxRounds" :min="1" :max="store.settings.maxGroupRounds" :step="1" />
            </div>
            <v-textarea v-model="settingsForm.summary" label="剧情前情摘要" rows="4" maxlength="4000" />
            <v-btn type="submit" color="primary" :loading="savingSettings">保存会话设置</v-btn>
          </v-form>

          <div class="mt-auto d-flex ga-2 pt-3">
            <v-btn variant="outlined" class="flex-grow-1" size="small" @click="clearMessages">清空消息</v-btn>
            <v-btn color="error" variant="tonal" size="small" prepend-icon="mdi-delete-outline" @click="deleteConv">
              删除
            </v-btn>
          </div>
        </div>
      </v-navigation-drawer>
    </template>

    <v-container v-else-if="loading" class="pa-8">
      <v-progress-linear indeterminate color="primary" rounded />
    </v-container>

    <v-container v-else class="pa-8" style="max-width:560px">
      <EmptyState icon="mdi-message-off-outline" title="会话不存在或无权访问" description="可能已被删除或链接无效。">
        <template #action>
          <v-btn color="primary" @click="router.push('/conversations')">返回对话列表</v-btn>
        </template>
      </EmptyState>
    </v-container>

    <!-- Drag Overlay -->
    <v-overlay :model-value="draggingFile && supportsImageInput" contained class="align-center justify-center">
      <v-card class="pa-5 font-weight-bold" color="surface">松开即可附加图片到此对话</v-card>
    </v-overlay>

    <!-- Image Lightbox -->
    <v-dialog :model-value="lightboxUrl !== null" max-width="920" @update:model-value="lightboxUrl = null">
      <v-card v-if="lightboxUrl" color="surface" class="pa-2">
        <v-img :src="lightboxUrl" max-height="85dvh" contain rounded="lg" />
      </v-card>
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
.cp-chat-scroll {
  flex: 1;
  overflow-y: auto;
}
.cp-composer-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  resize: none;
  font-size: 14.5px;
  line-height: 1.5;
  padding: 6px 4px;
  max-height: 160px;
}
@media (max-width: 959px) {
  .cp-chat-root {
    height: calc(100dvh - 56px);
  }
}
</style>
