<script setup lang="ts">
import { computed, ref } from 'vue';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import { deleteCachedConversation } from '../lib/conversationCache';
import { formatRelativeTime } from '../lib/display';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const search = ref('');
const deletingId = ref<string | null>(null);

const charById = computed(() => {
  const m = new Map<string, (typeof store.characters)[number]>();
  for (const c of store.characters) m.set(c.id, c);
  return m;
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return store.conversations;
  return store.conversations.filter(
    (c) => c.title.toLowerCase().includes(q) || c.lastMessage.toLowerCase().includes(q)
  );
});

async function handleDelete(id: string) {
  deletingId.value = id;
  try {
    await api.deleteConversation(id);
    deleteCachedConversation(id);
    await store.refresh();
    store.notify('对话已删除', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  } finally {
    deletingId.value = null;
  }
}
</script>

<template>
  <div class="cp-page cp-page--narrow">
    <header class="cp-page-header">
      <div>
        <h1 class="cp-page-title">对话记录</h1>
        <p v-if="store.user" class="cp-page-subtitle">共 {{ store.conversations.length }} 段对话，按最近活跃排序。</p>
      </div>
      <div class="d-flex align-center flex-wrap ga-2">
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索标题或消息"
          density="compact"
          clearable
          class="cp-search"
        />
        <v-btn color="primary" variant="flat" height="40" prepend-icon="mdi-plus" @click="store.openNewChat()">
          新建
        </v-btn>
      </div>
    </header>

    <EmptyState
      v-if="!store.user"
      icon="mdi-message-text-outline"
      title="登录后查看对话记录"
      description="你的全部单聊、群聊记录和摘要都会安全保存在个人账号下。"
    >
      <template #action>
        <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
      </template>
    </EmptyState>

    <div v-else-if="filtered.length" class="cp-seglist">
      <router-link
        v-for="conv in filtered"
        :key="conv.id"
        :to="`/chat/${conv.id}`"
        v-ripple
        class="cp-conv-row"
      >
        <div class="cp-conv-av" :class="{ 'is-group': conv.characterIds.length > 1 }">
          <AvatarBadge
            v-for="cid in conv.characterIds.slice(0, conv.characterIds.length > 1 ? 2 : 1)"
            :key="cid"
            :name="charById.get(cid)?.name ?? '角'"
            :avatar="charById.get(cid)?.avatar"
            :color="charById.get(cid)?.color"
            :size="conv.characterIds.length > 1 ? 30 : 44"
            :ring="conv.characterIds.length > 1"
          />
        </div>
        <div class="flex-grow-1" style="min-width:0">
          <div class="d-flex align-center ga-2">
            <span class="text-title-small font-weight-bold text-truncate">{{ conv.title }}</span>
            <span v-if="conv.kind === 'group'" class="cp-kind">群聊 · {{ conv.characterIds.length }}</span>
          </div>
          <div class="text-body-medium cp-muted text-truncate">
            {{ conv.lastMessage || '尚无消息，点击开始' }}
          </div>
        </div>
        <span class="text-body-small cp-faint flex-shrink-0">{{ formatRelativeTime(conv.updatedAt) }}</span>
        <v-btn
          icon="mdi-trash-can-outline"
          variant="text"
          size="small"
          density="comfortable"
          class="cp-conv-row__del"
          aria-label="删除对话"
          :loading="deletingId === conv.id"
          @click.prevent.stop="handleDelete(conv.id)"
        />
      </router-link>
    </div>

    <EmptyState
      v-else-if="search"
      icon="mdi-magnify"
      title="没有匹配的对话"
      description="换个关键词试试。"
    />

    <EmptyState
      v-else
      icon="mdi-chat-plus-outline"
      title="还没有对话记录"
      description="去角色馆挑选一位伙伴，写下你们的第一页吧。"
    >
      <template #action>
        <v-btn color="primary" @click="store.openNewChat()">开启第一段对话</v-btn>
      </template>
    </EmptyState>
  </div>
</template>

<style scoped>
.cp-conv-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 76px;
  padding: 14px 10px 14px 16px;
  color: inherit;
  text-decoration: none;
}
.cp-conv-row:hover {
  --cp-ring: rgb(var(--v-theme-surface-container));
}
.cp-conv-av {
  position: relative;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
}
.cp-conv-av.is-group > :first-child {
  position: absolute;
  top: 0;
  left: 0;
}
.cp-conv-av.is-group > :nth-child(2) {
  position: absolute;
  right: 0;
  bottom: 0;
}
.cp-conv-row__del {
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0;
  transition: opacity 0.15s;
}
.cp-conv-row:hover .cp-conv-row__del,
.cp-conv-row__del:focus-visible {
  opacity: 1;
}
.cp-conv-row__del:hover {
  color: rgb(var(--v-theme-error));
}
@media (hover: none) {
  .cp-conv-row__del {
    opacity: 1;
  }
}
.cp-kind {
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  padding: 2px 8px;
  border-radius: var(--cp-radius-sm);
  color: rgb(var(--v-theme-on-secondary-container));
  background: rgb(var(--v-theme-secondary-container));
}
</style>
