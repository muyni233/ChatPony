<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
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
  <div class="cp-page" style="max-width:1180px">
    <header class="cp-page-header">
      <div>
        <h1 class="cp-page-title">自设角色</h1>
        <p class="cp-page-subtitle">创建只属于你的角色，定义性格、开场白与使用的模型。</p>
      </div>
      <div v-if="data" class="d-flex align-center ga-3">
        <v-chip variant="outlined" class="cp-chip-quiet">
          槽位已用 {{ data.slots.used }} / {{ data.slots.limit }}
        </v-chip>
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

    <v-row v-else-if="data?.items.length">
      <v-col v-for="ch in data.items" :key="ch.id" cols="12" md="6" lg="4">
        <v-card class="pa-5 fill-height d-flex flex-column ga-3">
          <div class="d-flex align-center ga-3">
            <AvatarEditorButton
              compact
              :size="48"
              :name="ch.name"
              :avatar="ch.avatar"
              :color="ch.color"
              :busy="avatarBusy"
              @upload="(f) => onUploadAvatar(ch.id, f)"
              @clear="onClearAvatar(ch.id)"
            />
            <div style="min-width:0;flex:1">
              <div class="d-flex align-center ga-2">
                <span class="text-title-medium font-weight-bold text-truncate">{{ ch.name }}</span>
                <v-chip size="x-small" :color="ch.active ? 'success' : 'default'" variant="tonal">
                  {{ ch.active ? '启用中' : '已停用' }}
                </v-chip>
              </div>
              <div class="text-body-small text-medium-emphasis">@{{ ch.slug }}</div>
            </div>
          </div>

          <p class="text-body-medium text-medium-emphasis flex-grow-1 mb-0 cp-clamp-3">{{ ch.description || '暂无简介' }}</p>

          <div class="d-flex ga-2 mt-auto">
            <v-btn color="primary" variant="flat" height="36" class="flex-grow-1" prepend-icon="mdi-chat-plus-outline" :disabled="!ch.active" @click="startChat(ch.id)">
              开始对话
            </v-btn>
            <v-btn variant="tonal" height="36" prepend-icon="mdi-pencil-outline" @click="openEdit(ch)">编辑</v-btn>
            <v-btn variant="text" height="36" width="36" min-width="36" color="error" aria-label="删除角色" @click="handleDelete(ch.id)">
              <v-icon icon="mdi-delete-outline" size="18" />
              <v-tooltip activator="parent">删除</v-tooltip>
            </v-btn>
          </div>
        </v-card>
      </v-col>
    </v-row>

    <EmptyState
      v-else-if="!loading"
      icon="mdi-book-heart-outline"
      title="还没有创建自设角色"
      description="点击右上角按钮编写专属于你的性格、开场白和绑定模型。"
    >
      <template #action>
        <v-btn color="primary" @click="openCreate">创建第一个自设角色</v-btn>
      </template>
    </EmptyState>

    <v-dialog v-model="modalOpen" max-width="720">
      <v-card class="pa-6">
        <div class="d-flex align-center justify-space-between mb-4">
          <h3 class="text-title-large font-weight-bold">{{ editingId ? '编辑自设角色' : '新建自设角色' }}</h3>
          <v-btn icon="mdi-close" variant="text" size="small" @click="modalOpen = false" />
        </div>
        <v-form class="d-flex flex-column ga-3" @submit.prevent="handleSave">
          <v-row density="compact">
            <v-col cols="12" md="5">
              <v-text-field v-model="form.name" label="角色名称" required maxlength="60" />
            </v-col>
            <v-col v-if="!editingId" cols="12" md="4">
              <v-text-field v-model="form.slug" label="Slug（可选）" placeholder="留空自动生成" />
            </v-col>
            <v-col cols="12" :md="editingId ? 7 : 3">
              <v-text-field v-model="form.color" label="主题色" type="color" />
            </v-col>
          </v-row>

          <v-row density="compact">
            <v-col cols="12" md="6">
              <v-text-field v-model="form.tagsText" label="标签（逗号分隔）" placeholder="温柔, 图书馆, 原创" />
            </v-col>
            <v-col cols="12" md="6">
              <v-select
                v-model="form.providerId"
                label="首选语言模型"
                :items="[{ id: '', name: '跟随系统默认模型' }, ...(data?.models ?? [])]"
                item-title="name"
                item-value="id"
              />
            </v-col>
          </v-row>

          <v-text-field v-model="form.description" label="简介" maxlength="500" />
          <v-textarea v-model="form.personality" label="角色系统设定（Personality）" rows="4" required maxlength="8000" />
          <v-textarea v-model="form.greeting" label="私聊开场白（Greeting）" rows="2" maxlength="2000" />

          <div class="d-flex align-center justify-space-between mt-2">
            <v-switch v-model="form.active" label="启用该角色" />
            <v-btn type="submit" color="primary" :loading="saving">保存角色</v-btn>
          </div>
        </v-form>
      </v-card>
    </v-dialog>
  </div>
</template>
