<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import AvatarEditorButton from '../AvatarEditorButton.vue';
import AvatarBadge from '../m3/AvatarBadge.vue';
import { api, ApiError } from '../../lib/api';
import type { Character, ProviderConfig } from '../../lib/types';
import { useAppStore } from '../../stores/app';

const props = defineProps<{
  characters: Character[];
  models: ProviderConfig[];
}>();

const emit = defineEmits<{ refresh: [] }>();
const store = useAppStore();

const modelItems = computed(() => [
  { title: '跟随系统默认模型', value: '' },
  ...props.models.filter((x) => x.kind === 'language').map((m) => ({ title: m.name, value: m.id })),
]);

const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const saveBusy = ref(false);
const avatarBusy = ref(false);
const form = reactive({
  name: '',
  slug: '',
  description: '',
  color: '#315B52',
  tagsText: '',
  personality: '',
  greeting: '',
  providerId: '',
  active: true,
});

function openCreate() {
  editingId.value = null;
  form.name = '';
  form.slug = '';
  form.description = '';
  form.color = '#315B52';
  form.tagsText = '';
  form.personality = '';
  form.greeting = '';
  form.providerId = '';
  form.active = true;
  modalOpen.value = true;
}

function openEdit(c: Character) {
  editingId.value = c.id;
  form.name = c.name;
  form.slug = c.slug;
  form.description = c.description;
  form.color = c.color;
  form.tagsText = c.tags.join(', ');
  form.personality = c.personality ?? '';
  form.greeting = c.greeting;
  form.providerId = c.providerId ?? '';
  form.active = c.active;
  modalOpen.value = true;
}

async function save() {
  saveBusy.value = true;
  const tags = form.tagsText.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  const payload = {
    name: form.name,
    slug: form.slug || undefined,
    description: form.description,
    color: form.color,
    tags,
    personality: form.personality,
    greeting: form.greeting,
    providerId: form.providerId || null,
    active: form.active,
  };
  try {
    if (editingId.value) {
      await api.adminUpdateCharacter(editingId.value, payload);
    } else {
      await api.adminCreateCharacter(payload);
    }
    modalOpen.value = false;
    emit('refresh');
    await store.refresh();
    store.notify('角色已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存角色失败', 'error');
  } finally {
    saveBusy.value = false;
  }
}

async function removeChar(id: string) {
  if (!window.confirm('确认下线并移除该角色吗？历史会话记录仍会保留。')) return;
  try {
    await api.adminDeleteCharacter(id);
    emit('refresh');
    await store.refresh();
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

async function onUploadAvatar(id: string, file: File) {
  avatarBusy.value = true;
  try {
    await api.adminUploadCharacterAvatar(id, file);
    emit('refresh');
    await store.refresh();
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '上传失败', 'error');
  } finally {
    avatarBusy.value = false;
  }
}

async function onClearAvatar(id: string) {
  avatarBusy.value = true;
  try {
    await api.adminDeleteCharacterAvatar(id);
    emit('refresh');
    await store.refresh();
  } finally {
    avatarBusy.value = false;
  }
}
</script>

<template>
  <v-card border class="pa-5">
    <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
      <div>
        <h3 class="text-title-medium font-weight-bold">官方角色馆（{{ characters.length }}）</h3>
        <div class="text-body-medium text-medium-emphasis">维护平台公开发布角色与头像配置</div>
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" size="small" @click="openCreate">新建官方角色</v-btn>
    </div>

    <v-row density="compact">
      <v-col v-for="c in characters" :key="c.id" cols="12" sm="6" lg="4">
        <v-card color="surface-light" rounded="lg" class="pa-4 h-100 d-flex flex-column ga-3">
          <div class="d-flex align-center ga-3">
            <AvatarBadge :name="c.name" :avatar="c.avatar" :color="c.color" :size="48" />
            <div class="min-width-0 flex-1-1">
              <div class="d-flex align-center ga-2 flex-wrap">
                <span class="font-weight-bold text-body-large">{{ c.name }}</span>
                <v-chip size="x-small" :color="c.active ? 'success' : 'default'" variant="tonal">
                  {{ c.active ? '公开' : '未启用' }}
                </v-chip>
              </div>
              <div class="text-body-small text-medium-emphasis">@{{ c.slug }}</div>
            </div>
          </div>

          <AvatarEditorButton
            :name="c.name"
            :avatar="c.avatar"
            :color="c.color"
            :busy="avatarBusy"
            @upload="(f) => onUploadAvatar(c.id, f)"
            @clear="onClearAvatar(c.id)"
          />

          <p class="text-body-medium text-medium-emphasis mb-0 flex-1-1">{{ c.description || '暂无简介' }}</p>

          <div class="d-flex ga-2 mt-auto">
            <v-btn
              class="flex-1-1"
              size="small"
              variant="tonal"
              color="primary"
              prepend-icon="mdi-pencil-outline"
              @click="openEdit(c)"
            >
              编辑设定
            </v-btn>
            <v-btn
              size="small"
              variant="tonal"
              color="error"
              icon="mdi-delete-outline"
              aria-label="移除角色"
              @click="removeChar(c.id)"
            />
          </div>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog v-model="modalOpen" max-width="760">
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <span class="font-weight-bold">{{ editingId ? '编辑官方角色' : '新建官方角色' }}</span>
          <v-btn icon="mdi-close" variant="text" size="small" @click="modalOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-form id="cp-admin-char-form" class="d-flex flex-column ga-4" @submit.prevent="save">
            <v-row density="compact">
              <v-col cols="12" sm="4">
                <v-text-field v-model="form.name" label="角色名称" required />
              </v-col>
              <v-col cols="12" sm="4">
                <v-text-field v-model="form.slug" label="Slug" placeholder="留空自动生成" />
              </v-col>
              <v-col cols="12" sm="4">
                <v-text-field v-model="form.color" label="主题色">
                  <template #append-inner>
                    <input
                      v-model="form.color"
                      type="color"
                      aria-label="选择主题色"
                      style="width:24px;height:24px;border:none;border-radius:6px;background:transparent;cursor:pointer"
                    />
                  </template>
                </v-text-field>
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model="form.tagsText" label="标签（逗号分隔）" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-select v-model="form.providerId" label="绑定语言模型" :items="modelItems" />
              </v-col>
            </v-row>
            <v-text-field v-model="form.description" label="简介" />
            <v-textarea v-model="form.personality" label="系统人设（Personality）" rows="5" required />
            <v-textarea v-model="form.greeting" label="开场白（Greeting）" rows="2" />
            <v-switch v-model="form.active" label="公开并启用" />
          </v-form>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="modalOpen = false">取消</v-btn>
          <v-btn color="primary" type="submit" form="cp-admin-char-form" :loading="saveBusy">保存</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
