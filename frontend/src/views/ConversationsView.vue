<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import { deleteCachedConversation } from '../lib/conversationCache';
import { formatRelativeTime } from '../lib/display';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const search = ref('');
const deletingId = ref<string | null>(null);

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
  <v-container fluid class="pa-5 pa-md-8" style="max-width:1180px">
    <div class="d-flex align-end justify-space-between flex-wrap ga-4 mb-5">
      <div>
        <h1 class="text-h5 text-sm-h4 font-weight-bold">对话记录</h1>
      </div>
      <div class="d-flex align-center flex-wrap ga-3">
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索标题或消息内容..."
          density="compact"
          rounded="pill"
          clearable
          style="min-width:240px"
        />
        <v-btn color="primary" prepend-icon="mdi-chat-plus-outline" @click="store.openNewChat()">
          新建对话
        </v-btn>
      </div>
    </div>

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

    <v-card v-else-if="filtered.length" color="surface">
      <v-list lines="two" class="bg-transparent">
        <v-list-item
          v-for="conv in filtered"
          :key="conv.id"
          :to="`/chat/${conv.id}`"
          class="py-3"
        >
          <template #prepend>
            <v-avatar :color="conv.kind === 'group' ? 'secondary-container' : 'primary-container'" rounded="lg">
              <v-icon
                :icon="conv.kind === 'group' ? 'mdi-account-group-outline' : 'mdi-message-outline'"
                :color="conv.kind === 'group' ? 'on-secondary-container' : 'on-primary-container'"
              />
            </v-avatar>
          </template>
          <v-list-item-title class="font-weight-bold d-flex align-center ga-2">
            <span>{{ conv.title }}</span>
            <v-chip size="x-small" :color="conv.kind === 'group' ? 'secondary' : 'primary'" variant="tonal">
              {{ conv.kind === 'group' ? `群聊 · ${conv.characterIds.length} 人` : '私聊' }}
            </v-chip>
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ conv.lastMessage || '（尚无对话消息，点击继续）' }}
          </v-list-item-subtitle>
          <template #append>
            <span class="text-caption text-medium-emphasis mr-2">
              {{ formatRelativeTime(conv.updatedAt) }}
            </span>
            <v-btn
              icon="mdi-delete-outline"
              variant="text"
              size="small"
              color="error"
              :loading="deletingId === conv.id"
              @click.prevent="handleDelete(conv.id)"
            />
          </template>
        </v-list-item>
      </v-list>
    </v-card>

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
  </v-container>
</template>
