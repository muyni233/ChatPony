<script setup lang="ts">
import { reactive, ref } from 'vue';
import AvatarBadge from '../m3/AvatarBadge.vue';
import { api, ApiError } from '../../lib/api';
import type { User } from '../../lib/types';
import { useAppStore } from '../../stores/app';

defineProps<{ users: User[] }>();
const emit = defineEmits<{ refresh: [] }>();
const store = useAppStore();

const roleItems: Array<{ title: string; value: 'user' | 'admin' }> = [
  { title: '成员 (user)', value: 'user' },
  { title: '管理员 (admin)', value: 'admin' },
];

const createOpen = ref(false);
const createBusy = ref(false);
const resettingId = ref<string | null>(null);
const createForm = reactive({
  email: '',
  name: '',
  password: '',
  role: 'user' as 'user' | 'admin',
  limit5h: 50,
  limit7d: 500,
  characterSlots: 3,
});

const editOpen = ref(false);
const editBusy = ref(false);
const editTarget = ref<User | null>(null);
const editForm = reactive({
  role: 'user' as 'user' | 'admin',
  disabled: false,
  limit5h: 50,
  limit7d: 500,
  characterSlots: 3,
  password: '',
});

function openCreate() {
  createForm.email = '';
  createForm.name = '';
  createForm.password = '';
  createForm.role = 'user';
  createForm.limit5h = store.settings.defaultLimit5h;
  createForm.limit7d = store.settings.defaultLimit7d;
  createForm.characterSlots = store.settings.defaultCharacterSlots;
  createOpen.value = true;
}

async function submitCreate() {
  if (!createForm.email.trim() || !createForm.name.trim()) {
    store.notify('请填写邮箱和昵称', 'error');
    return;
  }
  if (createForm.password.length < 8) {
    store.notify('初始密码长度至少 8 位', 'error');
    return;
  }
  createBusy.value = true;
  try {
    await api.adminCreateUser({
      ...createForm,
      email: createForm.email.trim(),
      name: createForm.name.trim(),
    });
    createOpen.value = false;
    createForm.email = '';
    createForm.name = '';
    createForm.password = '';
    emit('refresh');
    store.notify('用户已创建', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '创建用户失败', 'error');
  } finally {
    createBusy.value = false;
  }
}

function openEdit(u: User) {
  editTarget.value = u;
  editForm.role = u.role;
  editForm.disabled = u.disabled;
  editForm.limit5h = u.limit5h;
  editForm.limit7d = u.limit7d;
  editForm.characterSlots = u.characterSlots;
  editForm.password = '';
  editOpen.value = true;
}

async function submitEdit() {
  if (!editTarget.value) return;
  const trimmedPw = editForm.password.trim();
  if (trimmedPw && trimmedPw.length < 8) {
    store.notify('重置密码长度至少 8 位', 'error');
    return;
  }
  editBusy.value = true;
  try {
    await api.adminUpdateUser(editTarget.value.id, {
      role: editForm.role,
      disabled: editForm.disabled,
      limit5h: editForm.limit5h,
      limit7d: editForm.limit7d,
      characterSlots: editForm.characterSlots,
      password: trimmedPw || undefined,
    });
    editOpen.value = false;
    emit('refresh');
    if (editTarget.value.id === store.user?.id) {
      await store.refresh();
    }
    store.notify('用户信息已更新', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '更新失败', 'error');
  } finally {
    editBusy.value = false;
  }
}

async function resetUserQuota(u: User) {
  resettingId.value = u.id;
  try {
    const snapshot = await api.adminResetUserQuota(u.id);
    if (u.id === store.user?.id) {
      store.setQuota(snapshot);
    }
    store.notify(`已为 ${u.name} 清零当前双窗口调用额度`, 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '重置失败', 'error');
  } finally {
    resettingId.value = null;
  }
}
</script>

<template>
  <v-card rounded="xl" class="pa-5">
    <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
      <div>
        <h3 class="text-title-medium font-weight-bold">用户与额度管理（{{ users.length }}）</h3>
        <div class="text-body-medium text-medium-emphasis">管理角色权限、5h/7d 对话上限及 OC 创建槽位</div>
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" size="small" @click="openCreate">创建用户</v-btn>
    </div>

    <div class="d-flex flex-column ga-2">
      <v-sheet
        v-for="u in users"
        :key="u.id"
        color="surface-container"
        rounded="lg"
        class="pa-3 d-flex align-center ga-3 flex-wrap"
      >
        <AvatarBadge :name="u.name" :avatar="u.avatar" :size="40" />
        <div class="flex-1-1" style="min-width:200px">
          <div class="d-flex align-center ga-2 flex-wrap">
            <span class="font-weight-bold text-body-large">{{ u.name }}</span>
            <v-chip size="x-small" :color="u.role === 'admin' ? 'tertiary' : 'primary'" variant="tonal">
              {{ u.role === 'admin' ? '管理员' : '成员' }}
            </v-chip>
            <v-chip v-if="u.disabled" size="x-small" color="error" variant="tonal">已停用</v-chip>
          </div>
          <div class="text-body-small text-medium-emphasis mt-1">
            {{ u.email }} · 5h上限 {{ u.limit5h }} · 7d上限 {{ u.limit7d }} · OC槽位 {{ u.characterSlots }}
          </div>
        </div>
        <div class="d-flex ga-2">
          <v-btn
            size="small"
            variant="outlined"
            prepend-icon="mdi-restore"
            :loading="resettingId === u.id"
            @click="resetUserQuota(u)"
          >
            重置额度
          </v-btn>
          <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-pencil-outline" @click="openEdit(u)">编辑</v-btn>
        </div>
      </v-sheet>
    </div>

    <!-- Create User Dialog -->
    <v-dialog v-model="createOpen" max-width="540" scrollable>
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <span class="font-weight-bold">创建平台用户</span>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="createOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-form id="cp-create-user-form" class="d-flex flex-column ga-4" @submit.prevent="submitCreate">
            <v-text-field v-model="createForm.email" label="邮箱" type="email" autocomplete="off" required />
            <v-text-field v-model="createForm.name" label="昵称" required />
            <v-text-field
              v-model="createForm.password"
              label="初始密码（>= 8 位）"
              type="password"
              autocomplete="new-password"
              required
              minlength="8"
            />
            <v-row density="compact">
              <v-col cols="12" sm="6">
                <v-select v-model="createForm.role" label="角色" :items="roleItems" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model.number="createForm.characterSlots" label="OC 槽位" type="number" min="0" max="100" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model.number="createForm.limit5h" label="5 小时额度" type="number" min="0" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model.number="createForm.limit7d" label="7 天额度" type="number" min="0" />
              </v-col>
            </v-row>
          </v-form>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="createOpen = false">取消</v-btn>
          <v-btn color="primary" type="submit" form="cp-create-user-form" :loading="createBusy">创建用户</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Edit User Dialog -->
    <v-dialog v-model="editOpen" max-width="540" scrollable>
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <div class="min-width-0">
            <div class="font-weight-bold text-truncate">编辑用户权限与额度</div>
            <div v-if="editTarget" class="text-body-small text-medium-emphasis text-truncate">
              {{ editTarget.name }} · {{ editTarget.email }}
            </div>
          </div>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" @click="editOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-form id="cp-edit-user-form" class="d-flex flex-column ga-4" @submit.prevent="submitEdit">
            <v-row density="compact">
              <v-col cols="12" sm="6">
                <v-select v-model="editForm.role" label="权限角色" :items="roleItems" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model.number="editForm.characterSlots" label="私有 OC 槽位" type="number" min="0" max="100" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model.number="editForm.limit5h" label="5 小时额度" type="number" min="0" />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field v-model.number="editForm.limit7d" label="7 天额度" type="number" min="0" />
              </v-col>
            </v-row>
            <v-text-field
              v-model="editForm.password"
              label="重置密码（留空则不修改）"
              type="password"
              autocomplete="new-password"
              minlength="8"
            />
            <v-switch v-model="editForm.disabled" label="停用该账号" color="error" />
          </v-form>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="editOpen = false">取消</v-btn>
          <v-btn color="primary" type="submit" form="cp-edit-user-form" :loading="editBusy">保存更改</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
