<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AvatarEditorButton from '../components/AvatarEditorButton.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import type { Character, UserCharacters } from '../lib/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const data = ref<UserCharacters | null>(null);
const loading = ref(true);
const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const avatarBusy = ref(false);

// Tonal-friendly presets for a character's accent colour
const isCustomColor = computed(() => !swatches.some((c) => c.toLowerCase() === form.color.toLowerCase()));
const swatches = ['#2B594F', '#4F6D3A', '#7B5EA7', '#3D6FB4', '#B4572E', '#C2844A', '#B4446C', '#5E5A6B'];

const form = reactive({
  name: '',
  slug: '',
  description: '',
  color: '#2B594F',
  tagsText: '',
  personality: '',
  greeting: '',
  providerId: '' as string,
  active: true,
});

async function load() {
  if (!store.user) {
    data.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    data.value = await api.listUserCharacters();
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '加载自设角色失败', 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => store.user?.id, load);

function openCreate() {
  editingId.value = null;
  form.name = '';
  form.slug = '';
  form.description = '';
  form.color = '#2B594F';
  form.tagsText = '';
  form.personality = '';
  form.greeting = '';
  form.providerId = '';
  form.active = true;
  modalOpen.value = true;
}

function openEdit(ch: Character) {
  editingId.value = ch.id;
  form.name = ch.name;
  form.slug = ch.slug;
  form.description = ch.description;
  form.color = ch.color;
  form.tagsText = ch.tags.join(', ');
  form.personality = ch.personality ?? '';
  form.greeting = ch.greeting;
  form.providerId = ch.providerId ?? '';
  form.active = ch.active;
  modalOpen.value = true;
}

async function handleSave() {
  saving.value = true;
  const tags = form.tagsText.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  try {
    if (editingId.value) {
      await api.updateUserCharacter(editingId.value, {
        name: form.name,
        description: form.description,
        color: form.color,
        tags,
        personality: form.personality,
        greeting: form.greeting,
        providerId: form.providerId || null,
        active: form.active,
      });
      store.notify('自设角色已更新', 'success');
    } else {
      await api.createUserCharacter({
        name: form.name,
        slug: form.slug || undefined,
        description: form.description,
        color: form.color,
        tags,
        personality: form.personality,
        greeting: form.greeting,
        providerId: form.providerId || null,
        active: form.active,
      });
      store.notify('自设角色创建成功', 'success');
    }
    modalOpen.value = false;
    await load();
    await store.refresh();
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

async function handleDelete(id: string) {
  if (!window.confirm('确定删除这个私有自设角色吗？')) return;
  try {
    await api.deleteUserCharacter(id);
    await load();
    await store.refresh();
    store.notify('已删除自设角色', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

async function onUploadAvatar(id: string, file: File) {
  avatarBusy.value = true;
  try {
    await api.uploadUserCharacterAvatar(id, file);
    await load();
    await store.refresh();
    store.notify('角色头像已更新', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '上传头像失败', 'error');
  } finally {
    avatarBusy.value = false;
  }
}

async function onClearAvatar(id: string) {
  avatarBusy.value = true;
  try {
    await api.deleteUserCharacterAvatar(id);
    await load();
    await store.refresh();
  } finally {
    avatarBusy.value = false;
  }
}

async function startChat(charId: string) {
  const conv = await api.createConversation({ characterIds: [charId] });
  await store.refresh();
  router.push(`/chat/${conv.id}`);
}
</script>

<template>
  <div class="cp-page">
    <header class="cp-page-header">
      <div>
        <h1 class="cp-page-title">自设角色</h1>
        <p class="cp-page-subtitle">创建只属于你的角色，定义性格、开场白与使用的模型。</p>
      </div>
      <div v-if="data" class="d-flex align-center flex-wrap ga-3">
        <div class="cp-slots" :title="`还可创建 ${data.slots.remaining} 个`">
          <span class="cp-slots__label">槽位</span>
          <span class="cp-slots__num"><strong>{{ data.slots.used }}</strong> / {{ data.slots.limit }}</span>
          <span class="cp-slots__bar">
            <span :style="{ width: `${data.slots.limit ? Math.min(100, (data.slots.used / data.slots.limit) * 100) : 0}%` }" />
          </span>
        </div>
        <v-btn color="primary" prepend-icon="mdi-plus" :disabled="data.slots.remaining <= 0" @click="openCreate">
          新建自设角色
        </v-btn>
      </div>
    </header>

    <EmptyState v-if="!store.user" icon="mdi-book-heart-outline" title="登录后创建你的私有 OC" description="私有自设角色与头像完全隔离，仅对你自己可见。">
      <template #action>
        <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
      </template>
    </EmptyState>

    <div v-else-if="data?.items.length" class="cp-grid">
      <div v-for="ch in data.items" :key="ch.id" class="cp-char-card" :class="{ 'is-off': !ch.active }">
        <div class="d-flex align-start ga-3 mb-3">
          <AvatarEditorButton
            compact
            :size="56"
            :name="ch.name"
            :avatar="ch.avatar"
            :color="ch.color"
            :busy="avatarBusy"
            @upload="(f) => onUploadAvatar(ch.id, f)"
            @clear="onClearAvatar(ch.id)"
          />
          <div class="flex-grow-1 min-width-0 pt-1">
            <div class="d-flex align-center ga-2">
              <span class="text-title-medium font-weight-bold text-truncate">{{ ch.name }}</span>
              <span class="cp-status" :class="ch.active ? 'is-on' : 'is-off'">
                <span class="cp-status__dot" />{{ ch.active ? '启用中' : '已停用' }}
              </span>
            </div>
            <div class="text-body-small cp-faint">@{{ ch.slug }}</div>
          </div>
          <v-menu location="bottom end">
            <template #activator="{ props: menuProps }">
              <v-btn v-bind="menuProps" icon variant="text" size="small" class="cp-more" aria-label="更多操作">
                <v-icon icon="mdi-dots-vertical" size="20" />
              </v-btn>
            </template>
            <v-list density="comfortable" min-width="160">
              <v-list-item prepend-icon="mdi-pencil-outline" title="编辑" @click="openEdit(ch)" />
              <v-list-item prepend-icon="mdi-delete-outline" title="删除" base-color="error" @click="handleDelete(ch.id)" />
            </v-list>
          </v-menu>
        </div>

        <p class="cp-char-card__desc">{{ ch.description || '暂无简介' }}</p>

        <div v-if="ch.tags.length" class="d-flex flex-wrap ga-1 mb-4">
          <span v-for="tag in ch.tags" :key="tag" class="cp-tag">{{ tag }}</span>
        </div>

        <div class="d-flex ga-2">
          <v-btn
            color="primary"
            variant="tonal"
            class="flex-grow-1"
            prepend-icon="mdi-message-outline"
            :disabled="!ch.active"
            @click="startChat(ch.id)"
          >
            开始对话
          </v-btn>
          <v-btn variant="outlined" class="cp-btn-quiet" prepend-icon="mdi-pencil-outline" @click="openEdit(ch)">编辑</v-btn>
        </div>
      </div>

      <button
        v-if="data.slots.remaining > 0"
        v-ripple
        type="button"
        class="cp-new-card"
        @click="openCreate"
      >
        <span class="cp-new-card__icon"><v-icon icon="mdi-plus" size="28" /></span>
        <span class="text-title-medium font-weight-bold">新建自设角色</span>
        <span class="text-body-small cp-faint">还可创建 {{ data.slots.remaining }} 个</span>
      </button>
    </div>

    <EmptyState
      v-else-if="!loading"
      icon="mdi-book-heart-outline"
      title="还没有创建自设角色"
      description="编写专属于你的性格、开场白，并为它挑选模型。"
    >
      <template #action>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">创建第一个自设角色</v-btn>
      </template>
    </EmptyState>

    <v-dialog v-model="modalOpen" max-width="720" scrollable>
      <v-card class="cp-oc-dialog">
        <div class="cp-oc-dialog__head">
          <h3 class="text-headline-small">{{ editingId ? '编辑自设角色' : '新建自设角色' }}</h3>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="modalOpen = false" />
        </div>
        <v-form id="oc-form" class="cp-oc-dialog__body" @submit.prevent="handleSave">
          <div class="cp-oc-section">基本信息</div>
          <v-row density="comfortable">
            <v-col cols="12" :md="editingId ? 12 : 7">
              <v-text-field v-model="form.name" label="角色名称" required maxlength="60" />
            </v-col>
            <v-col v-if="!editingId" cols="12" md="5">
              <v-text-field v-model="form.slug" label="Slug（可选）" placeholder="留空自动生成" />
            </v-col>
          </v-row>
          <v-text-field v-model="form.description" label="简介" maxlength="500" />
          <v-text-field v-model="form.tagsText" label="标签" placeholder="温柔, 图书馆, 原创" hint="用逗号分隔" persistent-hint />

          <div class="cp-oc-section mt-6">主题色</div>
          <div class="cp-swatches" role="radiogroup" aria-label="主题色">
            <button
              v-for="c in swatches"
              :key="c"
              v-ripple
              type="button"
              role="radio"
              class="cp-swatch"
              :class="{ 'is-on': form.color.toLowerCase() === c.toLowerCase() }"
              :style="{ background: c }"
              :aria-checked="form.color.toLowerCase() === c.toLowerCase()"
              :aria-label="c"
              @click="form.color = c"
            >
              <v-icon v-if="form.color.toLowerCase() === c.toLowerCase()" icon="mdi-check" size="18" color="white" />
            </button>
            <label
              class="cp-swatch cp-swatch--custom"
              :class="{ 'is-on': isCustomColor }"
              :style="isCustomColor ? { background: form.color, color: '#fff' } : undefined"
              title="自定义颜色"
            >
              <input v-model="form.color" type="color" aria-label="自定义颜色" />
              <v-icon icon="mdi-eyedropper-variant" size="18" />
            </label>
          </div>

          <div class="cp-oc-section mt-6">设定与模型</div>
          <v-textarea v-model="form.personality" label="角色系统设定（Personality）" rows="4" required maxlength="8000" auto-grow />
          <v-textarea v-model="form.greeting" label="私聊开场白（Greeting）" rows="2" maxlength="2000" auto-grow />
          <v-select
            v-model="form.providerId"
            label="首选语言模型"
            :items="[{ id: '', name: '跟随系统默认模型' }, ...(data?.models ?? [])]"
            item-title="name"
            item-value="id"
          />
        </v-form>
        <div class="cp-oc-dialog__foot">
          <v-switch v-model="form.active" label="启用该角色" color="primary" hide-details inset density="compact" />
          <v-spacer />
          <v-btn variant="text" @click="modalOpen = false">取消</v-btn>
          <v-btn type="submit" form="oc-form" color="primary" :loading="saving">保存角色</v-btn>
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.cp-slots {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 16px;
  border-radius: 999px;
  background: rgb(var(--v-theme-surface-container));
  font-size: 0.875rem;
}
.cp-slots__label {
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-slots__num {
  font-variant-numeric: tabular-nums;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-slots__num strong {
  color: rgb(var(--v-theme-on-surface));
}
.cp-slots__bar {
  width: 56px;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: rgb(var(--v-theme-secondary-container));
}
.cp-slots__bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: rgb(var(--v-theme-primary));
  transition: width var(--cp-spring-slow);
}

.cp-char-card.is-off .cp-char-card__desc,
.cp-char-card.is-off .cp-tag {
  opacity: 0.6;
}
.cp-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--cp-radius-sm);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.03em;
}
.cp-status.is-on {
  color: rgb(var(--v-theme-on-primary-container));
  background: rgb(var(--v-theme-primary-container));
}
.cp-status.is-off {
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgb(var(--v-theme-surface-container-highest));
}
.cp-status__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.cp-more {
  margin: -6px -8px 0 0;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-btn-quiet {
  border-color: rgb(var(--v-theme-outline-variant)) !important;
}

/* Add-new tile, same footprint as a card */
.cp-new-card {
  position: relative;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  border: 2px dashed rgb(var(--v-theme-outline-variant));
  border-radius: var(--cp-radius-lg);
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  overflow: hidden;
  transition: border-radius var(--cp-spring), background-color var(--cp-fx), border-color var(--cp-fx);
}
.cp-new-card:hover {
  border-radius: 28px;
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.04);
}
.cp-new-card__icon {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  margin-bottom: 6px;
  border-radius: 16px;
  color: rgb(var(--v-theme-on-primary-container));
  background: rgb(var(--v-theme-primary-container));
  transition: border-radius var(--cp-spring);
}
.cp-new-card:hover .cp-new-card__icon {
  border-radius: 28px;
}

/* Dialog */
.cp-oc-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 16px 8px 24px;
}
.cp-oc-dialog__body {
  padding: 8px 24px 8px;
  overflow-y: auto;
}
.cp-oc-dialog__body :deep(.v-input) {
  margin-bottom: 14px;
}
.cp-oc-dialog__body :deep(.v-row) {
  margin-block: 0;
}
.cp-oc-dialog__body :deep(.v-row > .v-col) {
  padding-block: 0;
}
.cp-oc-dialog__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px 20px;
}
.cp-oc-section {
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.00625em;
  color: rgb(var(--v-theme-primary));
  margin-bottom: 12px;
}
.cp-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.cp-swatch {
  position: relative;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  overflow: hidden;
  transition: border-radius var(--cp-spring-fast), box-shadow var(--cp-fx);
}
.cp-swatch.is-on {
  border-radius: 12px;
  box-shadow: 0 0 0 2px rgb(var(--v-theme-surface-container-high)), 0 0 0 4px rgb(var(--v-theme-on-surface));
}
.cp-swatch--custom {
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgb(var(--v-theme-surface-container-highest));
}
.cp-swatch--custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
</style>
