<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../lib/api';
import { useAppStore } from '../stores/app';
import AvatarBadge from './m3/AvatarBadge.vue';

const store = useAppStore();
const router = useRouter();

const selectedIds = ref<string[]>([]);
const title = ref('');
const maxRounds = ref(4);
const scope = ref<'all' | 'public' | 'private'>('all');
const busy = ref(false);
const errorMsg = ref('');

const open = computed({
  get: () => store.newChatModalOpen,
  set: (v: boolean) => {
    if (!v) store.closeNewChat();
  },
});

watch(
  () => store.newChatModalOpen,
  (isOpen) => {
    if (!isOpen) return;
    errorMsg.value = '';
    title.value = '';
    maxRounds.value = Math.min(4, store.settings.maxGroupRounds);
    selectedIds.value = store.newChatPreselectId ? [store.newChatPreselectId] : [];
  }
);

const filteredChars = computed(() =>
  store.characters.filter((c) => {
    if (scope.value === 'public') return c.ownerId === null;
    if (scope.value === 'private') return c.ownerId !== null;
    return true;
  })
);

function toggleChar(id: string) {
  errorMsg.value = '';
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((x) => x !== id);
  } else if (selectedIds.value.length < 8) {
    selectedIds.value = [...selectedIds.value, id];
  } else {
    errorMsg.value = '单次群聊最多同时邀请 8 位角色';
  }
}

async function handleCreate() {
  if (!selectedIds.value.length) {
    errorMsg.value = '请至少选择 1 位角色';
    return;
  }
  busy.value = true;
  errorMsg.value = '';
  try {
    const conv = await api.createConversation({
      characterIds: selectedIds.value,
      title: title.value.trim() || undefined,
      maxRounds: selectedIds.value.length > 1 ? maxRounds.value : undefined,
    });
    await store.refresh();
    store.closeNewChat();
    router.push(`/chat/${conv.id}`);
  } catch (err) {
    errorMsg.value = err instanceof ApiError ? err.message : '创建对话失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="760">
    <v-card class="pa-6" color="surface">
      <div class="d-flex align-start justify-space-between mb-4">
        <div>
          <h3 class="text-headline-small font-weight-bold">发起新对话</h3>
          <div class="text-body-medium text-medium-emphasis mt-1">选择 1 位角色开启单聊，或多选 2～8 位角色组建群聊</div>
        </div>
        <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭弹窗" @click="store.closeNewChat()" />
      </div>

      <div class="d-flex align-center justify-space-between flex-wrap ga-2 mb-4">
        <v-btn-toggle v-model="scope" mandatory variant="outlined" color="primary" density="compact" rounded="pill">
          <v-btn value="all">全部角色</v-btn>
          <v-btn value="public">官方馆藏</v-btn>
          <v-btn value="private">我的自设</v-btn>
        </v-btn-toggle>

        <v-chip :color="selectedIds.length > 1 ? 'secondary' : 'primary'" variant="tonal">
          <v-icon start :icon="selectedIds.length > 1 ? 'mdi-account-group' : 'mdi-message-outline'" />
          {{ selectedIds.length === 0 ? '未选择角色' : selectedIds.length === 1 ? '1 对 1 私密对话' : `群聊模式 · ${selectedIds.length} 人` }}
        </v-chip>
      </div>

      <v-row density="compact" style="max-height:300px;overflow-y:auto">
        <v-col v-for="ch in filteredChars" :key="ch.id" cols="12" sm="6">
          <v-card
            :variant="selectedIds.includes(ch.id) ? 'tonal' : 'flat'"
            :color="selectedIds.includes(ch.id) ? 'primary' : 'surface-light'"
            class="pa-3 d-flex align-center ga-3 cursor-pointer"
            @click="toggleChar(ch.id)"
          >
            <AvatarBadge :name="ch.name" :avatar="ch.avatar" :color="ch.color" :size="42" rounded="lg" />
            <div class="flex-grow-1" style="min-width:0">
              <div class="font-weight-bold text-body-medium d-flex align-center ga-1">
                <span class="text-truncate">{{ ch.name }}</span>
                <v-chip v-if="ch.ownerId" size="x-small" color="tertiary">自设</v-chip>
              </div>
              <div class="text-body-small text-medium-emphasis text-truncate">{{ ch.description || ch.slug }}</div>
            </div>
            <v-icon :icon="selectedIds.includes(ch.id) ? 'mdi-check-circle' : 'mdi-circle-outline'" />
          </v-card>
        </v-col>
      </v-row>

      <v-row density="compact" class="mt-4">
        <v-col cols="12" :md="selectedIds.length > 1 ? 6 : 12">
          <v-text-field
            v-model="title"
            label="会话标题（可选）"
            maxlength="80"
            placeholder="留空则按角色名称自动生成"
          />
        </v-col>
        <v-col v-if="selectedIds.length > 1" cols="12" md="6">
          <div class="text-body-small text-medium-emphasis mb-1">群聊最大连续响应轮数：{{ maxRounds }}</div>
          <v-slider v-model="maxRounds" :min="1" :max="store.settings.maxGroupRounds" :step="1" thumb-label />
        </v-col>
      </v-row>

      <v-alert v-if="errorMsg" type="error" variant="tonal" density="compact" class="mt-3">
        {{ errorMsg }}
      </v-alert>

      <div class="d-flex justify-end ga-2 mt-5">
        <v-btn variant="text" @click="store.closeNewChat()">取消</v-btn>
        <v-btn
          color="primary"
          :loading="busy"
          :disabled="selectedIds.length === 0"
          prepend-icon="mdi-chat-plus-outline"
          @click="handleCreate"
        >
          开始对话
        </v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>
