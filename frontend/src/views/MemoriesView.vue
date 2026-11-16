<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import { formatRelativeTime } from '../lib/display';
import type { Memory, MemoryKind, MemoryRecallResult } from '../lib/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();

const items = ref<Memory[]>([]);
const loading = ref(true);
const filterCharId = ref('all');
const filterStatus = ref('active');
const filterKind = ref('all');
const search = ref('');
const createOpen = ref(false);
const saving = ref(false);
const actionBusy = ref(false);
const recallQuery = ref('');
const recallResults = ref<MemoryRecallResult[] | null>(null);

const createForm = reactive({
  characterId: '',
  kind: 'fact' as MemoryKind,
  content: '',
  importance: 0.78,
  tagsText: '',
});

const kindLabels: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  relationship: '关系',
  event: '经历',
  plan: '约定',
  summary: '总结',
  note: '笔记',
};

const kindOptions = [
  { value: 'all', title: '全部类型' },
  ...Object.entries(kindLabels).map(([value, title]) => ({ value, title })),
];

async function loadMemories() {
  if (!store.user) {
    items.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    items.value = await api.listMemories({
      characterId: filterCharId.value,
      status: filterStatus.value,
      kind: filterKind.value,
      q: search.value.trim() || undefined,
    });
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '读取记忆失败', 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(loadMemories);
watch([() => store.user?.id, filterCharId, filterStatus, filterKind], loadMemories);

async function submitCreate() {
  saving.value = true;
  try {
    const tags = createForm.tagsText.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    await api.createMemory({
      characterId: createForm.characterId,
      content: createForm.content,
      kind: createForm.kind,
      importance: createForm.importance,
      tags,
    });
    createOpen.value = false;
    createForm.content = '';
    createForm.tagsText = '';
    await loadMemories();
    await store.refresh();
    store.notify('记忆已刻入档案', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '添加记忆失败', 'error');
  } finally {
    saving.value = false;
  }
}

async function toggleArchive(m: Memory) {
  try {
    const next = m.status === 'active' ? 'archived' : 'active';
    await api.updateMemory(m.id, { status: next });
    await loadMemories();
    store.notify(next === 'archived' ? '已归档' : '已恢复为激活状态', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '更新状态失败', 'error');
  }
}

async function removeMemory(id: string) {
  try {
    await api.deleteMemory(id);
    await loadMemories();
    await store.refresh();
    store.notify('记忆已删除', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

async function runSummarize() {
  if (filterCharId.value === 'all') {
    store.notify('请先选择一位具体角色再执行整理', 'error');
    return;
  }
  actionBusy.value = true;
  try {
    const res = await api.summarizeMemories(filterCharId.value);
    await loadMemories();
    store.notify(`记忆整理完成，新提取 ${res.saved} 条记忆`, 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '记忆整理失败', 'error');
  } finally {
    actionBusy.value = false;
  }
}

async function runReindex() {
  if (filterCharId.value === 'all') {
    store.notify('请先选择一位具体角色再同步向量', 'error');
    return;
  }
  actionBusy.value = true;
  try {
    await api.reindexMemories(filterCharId.value);
    await loadMemories();
    store.notify('向量索引已同步', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '向量索引同步失败', 'error');
  } finally {
    actionBusy.value = false;
  }
}

async function runRecallPreview() {
  if (filterCharId.value === 'all') {
    store.notify('请先选择一位角色来测试召回', 'error');
    return;
  }
  if (!recallQuery.value.trim()) return;
  try {
    recallResults.value = await api.recallPreview(filterCharId.value, recallQuery.value.trim());
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '召回测试失败', 'error');
  }
}
</script>

<template>
  <div class="cp-page" style="max-width:1180px">
    <header class="cp-page-header">
      <div>
        <h1 class="cp-page-title">长期记忆</h1>
        <p class="cp-page-subtitle">角色会记住与你相关的事实、偏好与约定，并在对话中自然想起。</p>
      </div>
      <div v-if="store.user" class="d-flex align-center ga-2">
        <v-btn variant="tonal" height="36" prepend-icon="mdi-auto-fix" :loading="actionBusy" @click="runSummarize">
          AI 整理
          <v-tooltip activator="parent" location="bottom">让 AI 立即从近期对话中整理记忆</v-tooltip>
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          height="36"
          prepend-icon="mdi-plus"
          @click="createForm.characterId = filterCharId !== 'all' ? filterCharId : (store.characters[0]?.id ?? ''); createOpen = true"
        >
          手写记忆
        </v-btn>
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" variant="text" height="36" width="36" min-width="36" aria-label="更多操作" :disabled="actionBusy">
              <v-icon icon="mdi-dots-horizontal" size="20" />
            </v-btn>
          </template>
          <v-list density="compact" min-width="180">
            <v-list-item prepend-icon="mdi-refresh" title="同步向量索引" @click="runReindex" />
          </v-list>
        </v-menu>
      </div>
    </header>

    <EmptyState v-if="!store.user" icon="mdi-brain" title="登录后查看长期记忆" description="每个角色为你保留独立的认知档案，结合 FTS5 与语义向量自动召回。">
      <template #action>
        <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
      </template>
    </EmptyState>

    <template v-else>
      <v-card color="surface" class="pa-4 mb-5">
        <v-row density="compact">
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="filterCharId"
              label="按角色筛选"
              :items="[{ id: 'all', name: '全部角色' }, ...store.characters]"
              item-title="name"
              item-value="id"
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="filterStatus"
              label="记忆状态"
              :items="[
                { value: 'active', title: '仅活跃记忆' },
                { value: 'archived', title: '已归档' },
                { value: 'all', title: '全部状态' },
              ]"
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-select v-model="filterKind" label="记忆分类" :items="kindOptions" density="compact" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-text-field
              v-model="search"
              placeholder="搜索记忆内容…"
              prepend-inner-icon="mdi-magnify"
              density="compact"
              @keydown.enter="loadMemories"
            />
          </v-col>
        </v-row>

        <div v-if="filterCharId !== 'all'" class="mt-4 pt-4" style="border-top:1px solid rgba(var(--v-border-color),var(--v-border-opacity))">
          <div class="d-flex ga-2 align-center">
            <v-text-field
              v-model="recallQuery"
              placeholder="输入一句模拟提问，测试 FTS5 + 向量 + MMR 混合召回..."
              density="compact"
              @keydown.enter="runRecallPreview"
            />
            <v-btn variant="tonal" color="primary" @click="runRecallPreview">召回预览</v-btn>
          </div>
          <v-list v-if="recallResults" density="compact" class="mt-2 bg-surface-light rounded-lg">
            <v-list-subheader>召回命中 {{ recallResults.length }} 条</v-list-subheader>
            <v-list-item v-for="r in recallResults" :key="r.id">
              <template #prepend>
                <v-chip size="x-small" color="primary" class="mr-2">{{ kindLabels[r.kind] }}</v-chip>
              </template>
              <v-list-item-title class="text-body-medium">{{ r.content }}</v-list-item-title>
              <template #append>
                <span class="text-body-small text-medium-emphasis">
                  相关度 {{ r.relevance.toFixed(2) }} · {{ r.routes.join('+') }}
                </span>
              </template>
            </v-list-item>
          </v-list>
        </div>
      </v-card>

      <v-row v-if="items.length">
        <v-col v-for="m in items" :key="m.id" cols="12" md="6" lg="4">
          <v-card color="surface" class="pa-4 fill-height d-flex flex-column ga-3">
            <div class="d-flex align-center flex-wrap ga-2">
              <AvatarBadge
                v-if="m.characterName"
                :name="m.characterName"
                :avatar="m.characterAvatar"
                :color="m.characterColor"
                :size="28"
                rounded="lg"
              />
              <strong class="text-body-medium">{{ m.characterName || '角色' }}</strong>
              <v-chip size="x-small" color="secondary" variant="tonal">{{ kindLabels[m.kind] }}</v-chip>
              <v-chip size="x-small" :color="m.source === 'manual' ? 'primary' : 'default'" variant="tonal">
                {{ m.source === 'manual' ? '手写' : '自动' }}
              </v-chip>
              <v-chip v-if="m.status === 'archived'" size="x-small" color="warning" variant="tonal">已归档</v-chip>
            </div>

            <div class="text-body-medium flex-grow-1" style="line-height:1.65">{{ m.content }}</div>

            <div v-if="m.tags.length" class="d-flex flex-wrap ga-1">
              <v-chip v-for="t in m.tags" :key="t" size="x-small">#{{ t }}</v-chip>
            </div>

            <div class="d-flex align-center justify-space-between text-body-small text-medium-emphasis">
              <span>重要度 {{ Math.round(m.importance * 100) }}% · 召回 {{ m.accessCount }} 次 · {{ formatRelativeTime(m.updatedAt) }}</span>
              <div>
                <v-btn icon="mdi-archive-outline" variant="text" size="x-small" :title="m.status === 'active' ? '归档' : '恢复'" @click="toggleArchive(m)" />
                <v-btn icon="mdi-delete-outline" variant="text" size="x-small" color="error" title="删除" @click="removeMemory(m.id)" />
              </div>
            </div>
          </v-card>
        </v-col>
      </v-row>

      <EmptyState
        v-else-if="!loading"
        icon="mdi-brain"
        title="暂无符合条件的记忆条目"
        description="对话过程中说“记住：…”或由 AI 在多轮对话后自动沉淀。"
      />
    </template>

    <v-dialog v-model="createOpen" max-width="520">
      <v-card color="surface" class="pa-6">
        <div class="d-flex align-center justify-space-between mb-4">
          <h3 class="text-title-large font-weight-bold">添加手写长期记忆</h3>
          <v-btn icon="mdi-close" variant="text" size="small" @click="createOpen = false" />
        </div>
        <v-form class="d-flex flex-column ga-3" @submit.prevent="submitCreate">
          <v-select
            v-model="createForm.characterId"
            label="关联角色"
            :items="store.characters"
            item-title="name"
            item-value="id"
            required
          />
          <v-row density="compact" align="center">
            <v-col cols="6">
              <v-select
                v-model="createForm.kind"
                label="记忆分类"
                :items="Object.entries(kindLabels).map(([value, title]) => ({ value, title }))"
              />
            </v-col>
            <v-col cols="6">
              <div class="text-body-small text-medium-emphasis">重要度：{{ Math.round(createForm.importance * 100) }}%</div>
              <v-slider v-model="createForm.importance" :min="0.2" :max="1" :step="0.05" />
            </v-col>
          </v-row>
          <v-textarea v-model="createForm.content" label="记忆内容" rows="3" required maxlength="1000" placeholder="例如：用户喜欢在下雨天喝热苹果汁，讨厌香菜。" />
          <v-text-field v-model="createForm.tagsText" label="标签（逗号分隔，可选）" placeholder="喜好, 饮食" />
          <div class="d-flex justify-end ga-2 mt-2">
            <v-btn variant="text" @click="createOpen = false">取消</v-btn>
            <v-btn type="submit" color="primary" :loading="saving">保存记忆</v-btn>
          </div>
        </v-form>
      </v-card>
    </v-dialog>
  </div>
</template>
