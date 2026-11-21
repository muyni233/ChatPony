<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import AvatarEditorButton from '../AvatarEditorButton.vue';
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
const avatarBusyId = ref<string | null>(null);
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
  if (!form.name.trim()) {
    store.notify('请填写角色名称', 'error');
    return;
  }
  if (!form.personality.trim()) {
    store.notify('请填写系统人设', 'error');
    return;
  }
  saveBusy.value = true;
  const tags = form.tagsText.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  const payload = {
    name: form.name.trim(),
    slug: form.slug.trim() || undefined,
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

async function removeChar(c: Character) {
  const ok = await store.confirm({
    title: '移除官方角色',
    message: `确认下线并移除角色「${c.name}」吗？历史会话记录仍会保留。`,
    confirmText: '确认移除',
    tone: 'error',
  });
  if (!ok) return;
  try {
    await api.adminDeleteCharacter(c.id);
    emit('refresh');
    await store.refresh();
    store.notify('角色已移除', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}

async function onUploadAvatar(id: string, file: File) {
  avatarBusyId.value = id;
  try {
    await api.adminUploadCharacterAvatar(id, file);
    emit('refresh');
    await store.refresh();
    store.notify('角色头像已更新', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '上传失败', 'error');
  } finally {
    avatarBusyId.value = null;
  }
}

async function onClearAvatar(id: string) {
  avatarBusyId.value = id;
  try {
    await api.adminDeleteCharacterAvatar(id);
    emit('refresh');
    await store.refresh();
    store.notify('已移除角色头像', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '移除头像失败', 'error');
  } finally {
    avatarBusyId.value = null;
  }
}
</script>

<template>
  <v-card rounded="xl" class="pa-5">
    <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
      <div>
        <h3 class="text-title-medium font-weight-bold">官方角色馆（{{ characters.length }}）</h3>
        <div class="text-body-medium text-medium-emphasis">维护平台公开发布角色与头像配置，点击头像可直接更换</div>
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" size="small" @click="openCreate">新建官方角色</v-btn>
    </div>

    <v-row v-if="characters.length" density="compact">
      <v-col v-for="c in characters" :key="c.id" cols="12" sm="6" lg="4">
        <v-card color="surface-container" rounded="lg" class="pa-4 h-100 d-flex flex-column ga-3">
          <div class="d-flex align-center ga-3">
            <AvatarEditorButton
              compact
              :size="52"
              :name="c.name"
              :avatar="c.avatar"
              :color="c.color"
              :busy="avatarBusyId === c.id"
              @upload="(f) => onUploadAvatar(c.id, f)"
              @clear="onClearAvatar(c.id)"
            />
            <div class="min-width-0 flex-1-1">
              <div class="d-flex align-center ga-2 flex-wrap">
                <span class="font-weight-bold text-body-large text-truncate">{{ c.name }}</span>
                <v-chip size="x-small" :color="c.active ? 'success' : 'default'" variant="tonal">
                  {{ c.active ? '公开' : '未启用' }}
                </v-chip>
              </div>
              <div class="text-body-small text-medium-emphasis">@{{ c.slug }}</div>
            </div>
          </div>

          <p class="text-body-medium text-medium-emphasis mb-0 flex-1-1 line-clamp-3">{{ c.description || '暂无简介' }}</p>

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
              @click="removeChar(c)"
            />
          </div>
        </v-card>
      </v-col>
    </v-row>
    <div v-else class="text-body-medium text-medium-emphasis">暂无官方角色，点击右上角创建。</div>

    <v-dialog v-model="modalOpen" max-width="760" scrollable>
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <span class="font-weight-bold">{{ editingId ? '编辑官方角色' : '新建官方角色' }}</span>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="modalOpen = false" />
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
