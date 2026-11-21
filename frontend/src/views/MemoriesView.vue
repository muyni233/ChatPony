<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AvatarBadge from '../components/m3/AvatarBadge.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import M3Loader from '../components/m3/M3Loader.vue';
import { api, ApiError } from '../lib/api';
import { formatRelativeTime } from '../lib/display';
import type { Memory, MemoryKind, MemoryRecallResult } from '../lib/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const route = useRoute();

const items = ref<Memory[]>([]);
const loading = ref(true);
const filterCharId = ref(typeof route.query.characterId === 'string' && route.query.characterId ? route.query.characterId : 'all');
const filterStatus = ref('active');
const filterKind = ref('all');
const search = ref('');
const createOpen = ref(false);
const saving = ref(false);
const actionBusy = ref(false);
const recallQuery = ref('');
const recallBusy = ref(false);
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

const kindSelectOptions = Object.entries(kindLabels).map(([value, title]) => ({ value, title }));

const kindOptions = [
  { value: 'all', title: '全部类型' },
  ...kindSelectOptions,
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
      q: (search.value ?? '').trim() || undefined,
    });
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '读取记忆失败', 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(loadMemories);
watch([() => store.user?.id, filterCharId, filterStatus, filterKind], loadMemories);

watch(filterCharId, () => {
  recallResults.value = null;
});

watch(
  () => route.query.characterId,
  (qId) => {
    if (typeof qId === 'string' && qId && qId !== filterCharId.value) {
      filterCharId.value = qId;
    }
  }
);

async function submitCreate() {
  if (!createForm.characterId) {
    store.notify('请选择关联角色', 'error');
    return;
  }
  if (!createForm.content.trim()) {
    store.notify('请输入记忆内容', 'error');
    return;
  }
  saving.value = true;
  try {
    const tags = createForm.tagsText.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    await api.createMemory({
      characterId: createForm.characterId,
      content: createForm.content.trim(),
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

async function removeMemory(m: Memory) {
  const ok = await store.confirm({
    title: '删除这条记忆',
    message: '删除后角色将不再记得该条目，此操作无法撤销。',
    confirmText: '确认删除',
    tone: 'error',
  });
  if (!ok) return;
  try {
    await api.deleteMemory(m.id);
    await loadMemories();
    await store.refresh();
    store.notify('记忆已删除', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

async function runSummarize() {
  if (filterCharId.value === 'all') {
    store.notify('请先在下方选择一位具体角色再执行整理', 'error');
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
    store.notify('请先在下方选择一位具体角色再同步向量', 'error');
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
  const q = (recallQuery.value ?? '').trim();
  if (!q) {
    store.notify('请输入要测试的提问内容', 'info');
    return;
  }
  recallBusy.value = true;
  try {
    recallResults.value = await api.recallPreview(filterCharId.value, q);
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '召回测试失败', 'error');
  } finally {
    recallBusy.value = false;
  }
}
</script>

<template>
  <div class="cp-page">
    <header class="cp-page-header">
      <div>
        <h1 class="cp-page-title">长期记忆</h1>
        <p class="cp-page-subtitle">角色会记住与你相关的事实、偏好与约定，并在对话中自然想起。</p>
      </div>
      <div v-if="store.user" class="d-flex align-center ga-2">
        <v-btn variant="tonal" prepend-icon="mdi-auto-fix" :loading="actionBusy" @click="runSummarize">
          AI 整理
          <v-tooltip activator="parent" location="bottom">让 AI 立即从近期对话中整理记忆</v-tooltip>
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-plus"
          @click="createForm.characterId = filterCharId !== 'all' ? filterCharId : (store.characters[0]?.id ?? ''); createOpen = true"
        >
          手写记忆
        </v-btn>
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" icon variant="text" aria-label="更多操作" :disabled="actionBusy">
              <v-icon icon="mdi-dots-horizontal" size="20" />
            </v-btn>
          </template>
          <v-list density="compact" min-width="180">
            <v-list-item prepend-icon="mdi-refresh" title="同步向量索引" @click="runReindex" />
          </v-list>
        </v-menu>
      </div>
    </header>

    <div v-if="store.loading" class="cp-loading-state">
      <M3Loader :size="44" contained label="正在加载长期记忆" />
    </div>

    <EmptyState
      v-else-if="!store.user"
      icon="mdi-brain"
      title="登录后查看长期记忆"
      description="每个角色为你保留独立的认知档案，结合 FTS5 与语义向量自动召回。"
    >
      <template #action>
        <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
      </template>
    </EmptyState>

    <template v-else>
      <div class="cp-mem-tools">
        <v-text-field
          v-model="search"
          placeholder="搜索记忆内容，回车确认"
          prepend-inner-icon="mdi-magnify"
          density="compact"
          clearable
          hide-details
          class="cp-mem-search"
          @keydown.enter="loadMemories"
          @click:clear="search = ''; loadMemories()"
        />
        <v-select
          v-model="filterCharId"
          :items="[{ id: 'all', name: '全部角色' }, ...store.characters]"
          item-title="name"
          item-value="id"
          density="compact"
          hide-details
          class="cp-mem-char"
          aria-label="按角色筛选"
        />
        <v-btn-toggle v-model="filterStatus" mandatory class="cp-connected" aria-label="记忆状态">
          <v-btn value="active">活跃</v-btn>
          <v-btn value="archived">已归档</v-btn>
          <v-btn value="all">全部</v-btn>
        </v-btn-toggle>
      </div>

      <div class="cp-kindbar mb-6" role="group" aria-label="记忆分类">
        <button
          v-for="opt in kindOptions"
          :key="opt.value"
          v-ripple
          type="button"
          class="cp-filter"
          :class="{ 'is-on': filterKind === opt.value }"
          @click="filterKind = opt.value"
        >
          <v-icon v-if="filterKind === opt.value" icon="mdi-check" size="16" />
          {{ opt.value === 'all' ? '全部' : opt.title }}
        </button>
      </div>

      <div v-if="filterCharId !== 'all'" class="cp-recall mb-6">
        <div class="cp-recall__head">
          <v-icon icon="mdi-radar" size="18" />
          <span>召回预览</span>
          <span class="cp-recall__hint">模拟一句提问，查看 FTS5 + 向量 + MMR 混合召回会命中哪些记忆</span>
        </div>
        <div class="d-flex ga-2 align-center">
          <v-text-field
            v-model="recallQuery"
            placeholder="例如：周末一起去做什么？"
            density="compact"
            hide-details
            @keydown.enter="runRecallPreview"
          />
          <v-btn color="primary" variant="flat" height="40" :loading="recallBusy" @click="runRecallPreview">预览</v-btn>
        </div>
        <div v-if="recallResults" class="cp-recall__list">
          <div class="cp-recall__count">命中 {{ recallResults.length }} 条</div>
          <div v-for="r in recallResults" :key="r.id" class="cp-recall__row">
            <span class="cp-tag">{{ kindLabels[r.kind] }}</span>
            <span class="flex-grow-1 min-width-0">{{ r.content }}</span>
            <span class="cp-recall__score">{{ r.relevance.toFixed(2) }} · {{ r.routes.join('+') }}</span>
          </div>
        </div>
      </div>

      <div v-if="loading && !items.length" class="cp-loading-state">
        <M3Loader :size="40" contained label="正在读取记忆档案" />
      </div>

      <div v-else-if="items.length" class="cp-grid">
        <article v-for="m in items" :key="m.id" class="cp-mem" :class="{ 'is-archived': m.status === 'archived' }">
          <div class="d-flex align-center ga-2">
            <AvatarBadge
              v-if="m.characterName"
              :name="m.characterName"
              :avatar="m.characterAvatar"
              :color="m.characterColor"
              :size="28"
              rounded="lg"
            />
            <strong class="text-body-medium text-truncate">{{ m.characterName || '角色' }}</strong>
            <span class="cp-kind">{{ kindLabels[m.kind] }}</span>
            <v-spacer />
            <span class="cp-src" :title="m.source === 'manual' ? '手写记忆' : '对话中自动沉淀'">
              <v-icon :icon="m.source === 'manual' ? 'mdi-pencil-outline' : 'mdi-auto-fix'" size="14" />
              {{ m.source === 'manual' ? '手写' : '自动' }}
            </span>
          </div>

          <p class="cp-mem__body">{{ m.content }}</p>

          <div v-if="m.tags.length" class="d-flex flex-wrap ga-1">
            <span v-for="t in m.tags" :key="t" class="cp-tag">#{{ t }}</span>
          </div>

          <div class="cp-mem__foot">
            <span class="cp-imp" :title="`重要度 ${Math.round(m.importance * 100)}%`">
              <span class="cp-imp__bar"><span :style="{ width: `${Math.round(m.importance * 100)}%` }" /></span>
              {{ Math.round(m.importance * 100) }}%
            </span>
            <span>召回 {{ m.accessCount }} 次</span>
            <span>{{ formatRelativeTime(m.updatedAt) }}</span>
            <v-spacer />
            <v-btn icon variant="text" size="small" :aria-label="m.status === 'active' ? '归档' : '恢复'" @click="toggleArchive(m)">
              <v-icon :icon="m.status === 'active' ? 'mdi-archive-arrow-down-outline' : 'mdi-archive-arrow-up-outline'" size="18" />
              <v-tooltip activator="parent">{{ m.status === 'active' ? '归档' : '恢复' }}</v-tooltip>
            </v-btn>
            <v-btn icon variant="text" size="small" class="cp-del" aria-label="删除" @click="removeMemory(m)">
              <v-icon icon="mdi-delete-outline" size="18" />
              <v-tooltip activator="parent">删除</v-tooltip>
            </v-btn>
          </div>
        </article>
      </div>

      <EmptyState
        v-else
        icon="mdi-brain"
        title="暂无符合条件的记忆条目"
        description="对话过程中说“记住：…”或由 AI 在多轮对话后自动沉淀。"
      />
    </template>

    <v-dialog v-model="createOpen" max-width="560">
      <v-card class="pa-6">
        <div class="d-flex align-center justify-space-between mb-4">
          <h3 class="text-headline-small">添加手写记忆</h3>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="createOpen = false" />
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
                :items="kindSelectOptions"
              />
            </v-col>
            <v-col cols="6">
              <div class="d-flex justify-space-between text-body-small text-medium-emphasis">
                <span>重要度</span><strong class="text-high-emphasis">{{ Math.round(createForm.importance * 100) }}%</strong>
              </div>
              <v-slider v-model="createForm.importance" :min="0.2" :max="1" :step="0.05" color="primary" hide-details />
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

<style scoped>
.cp-mem-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.cp-mem-search {
  flex: 1 1 260px;
}
.cp-mem-char {
  flex: 0 0 200px;
}
@media (max-width: 599px) {
  .cp-mem-search {
    flex-basis: 100%;
  }
  .cp-mem-char {
    flex: 1 1 0;
    min-width: 0;
  }
}

.cp-kindbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 599px) {
  .cp-kindbar {
    flex-wrap: nowrap;
    overflow-x: auto;
    margin-inline: -20px;
    padding-inline: 20px;
    scrollbar-width: none;
    -webkit-mask: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 28px), transparent);
    mask: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 28px), transparent);
  }
  .cp-kindbar::-webkit-scrollbar {
    display: none;
  }
}

.cp-recall {
  padding: 18px 20px;
  border-radius: var(--cp-radius-lg-inc);
  background: rgb(var(--v-theme-surface-container));
}
.cp-recall__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  margin-bottom: 12px;
  font-size: 0.875rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
}
.cp-recall__hint {
  font-weight: 400;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-recall__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 12px;
}
.cp-recall__count {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  margin-bottom: 6px;
}
.cp-recall__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  font-size: 0.875rem;
  border-radius: 6px;
  background: rgb(var(--v-theme-surface-container-lowest));
}
.cp-recall__row:first-of-type {
  border-top-left-radius: 14px;
  border-top-right-radius: 14px;
}
.cp-recall__row:last-child {
  border-bottom-left-radius: 14px;
  border-bottom-right-radius: 14px;
}
.cp-recall__score {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--v-theme-on-surface-variant));
}

.cp-mem {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 18px 10px;
  border-radius: var(--cp-radius-lg);
  background: rgb(var(--v-theme-surface-container-low));
  transition: background-color var(--cp-fx);
}
.cp-mem:hover {
  background: rgb(var(--v-theme-surface-container));
}
.cp-mem.is-archived {
  background: transparent;
  box-shadow: inset 0 0 0 1px rgb(var(--v-theme-outline-variant));
}
.cp-mem.is-archived .cp-mem__body {
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-mem__body {
  flex-grow: 1;
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.65;
}
.cp-src {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-mem__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 -8px 0 0;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-imp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cp-imp__bar {
  width: 36px;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: rgb(var(--v-theme-secondary-container));
}
.cp-imp__bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: rgb(var(--v-theme-primary));
}
.cp-del:hover {
  color: rgb(var(--v-theme-error));
}
</style>
