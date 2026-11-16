<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import AvatarEditorButton from '../components/AvatarEditorButton.vue';
import QuotaCard from '../components/QuotaCard.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import { useAppStore } from '../stores/app';

const store = useAppStore();

const profile = reactive({ name: '', timezone: 'Asia/Shanghai' });
const pwForm = reactive({ currentPassword: '', newPassword: '' });
const profileBusy = ref(false);
const avatarBusy = ref(false);
const pwBusy = ref(false);

const commonTimezones = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

watch(
  () => store.user,
  (u) => {
    if (!u) return;
    profile.name = u.name;
    profile.timezone = u.timezone || 'Asia/Shanghai';
  },
  { immediate: true }
);

async function saveProfile() {
  profileBusy.value = true;
  try {
    const res = await api.updateAccount({ name: profile.name, timezone: profile.timezone });
    store.setUser(res.user);
    store.notify('账户资料已更新', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '更新失败', 'error');
  } finally {
    profileBusy.value = false;
  }
}

async function onUploadAvatar(file: File) {
  avatarBusy.value = true;
  try {
    const res = await api.uploadUserAvatar(file);
    store.setUser(res.user);
    store.notify('头像已更新', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '上传头像失败', 'error');
  } finally {
    avatarBusy.value = false;
  }
}

async function onClearAvatar() {
  avatarBusy.value = true;
  try {
    const res = await api.deleteUserAvatar();
    store.setUser(res.user);
    store.notify('已恢复默认文字头像', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '操作失败', 'error');
  } finally {
    avatarBusy.value = false;
  }
}

async function submitPassword() {
  pwBusy.value = true;
  try {
    await api.changePassword(pwForm.currentPassword, pwForm.newPassword);
    pwForm.currentPassword = '';
    pwForm.newPassword = '';
    store.notify('密码修改成功，其他设备已下线', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '修改密码失败', 'error');
  } finally {
    pwBusy.value = false;
  }
}
</script>

<template>
  <div class="cp-page cp-page--narrow">
    <div class="cp-page-header">
      <div>
        <h1 class="cp-page-title">账户与设置</h1>
        <p class="cp-page-subtitle">管理昵称、头像、时区与登录密码。</p>
      </div>
    </div>

    <EmptyState v-if="!store.user" icon="mdi-cog-outline" title="登录后管理账户设置" description="修改昵称、头像、时区与登录密码。">
      <template #action>
        <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
      </template>
    </EmptyState>

    <div v-else class="d-flex flex-column ga-5">
      <QuotaCard v-if="store.quota" :quota="store.quota" />

      <v-card color="surface" class="pa-5 d-flex align-center justify-space-between flex-wrap ga-3">
        <div>
          <div class="text-title-medium font-weight-bold">外观主题</div>
          <div class="text-body-medium text-medium-emphasis">在浅色模式与深色模式之间即时切换</div>
        </div>
        <v-btn
          variant="tonal"
          color="primary"
          :prepend-icon="store.theme === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'"
          @click="store.toggleTheme()"
        >
          {{ store.theme === 'dark' ? '切换浅色模式' : '切换深色模式' }}
        </v-btn>
      </v-card>

      <v-card color="surface" class="pa-5">
        <div class="text-title-medium font-weight-bold mb-4">基本资料与头像</div>
        <AvatarEditorButton
          :name="store.user.name"
          :avatar="store.user.avatar"
          :busy="avatarBusy"
          class="mb-5"
          @upload="onUploadAvatar"
          @clear="onClearAvatar"
        />

        <v-form @submit.prevent="saveProfile">
          <v-row density="compact">
            <v-col cols="12" md="4">
              <v-text-field
                :model-value="store.user.email"
                label="电子邮箱"
                disabled
                :append-inner-icon="store.user.emailVerifiedAt ? 'mdi-check-decagram' : undefined"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="profile.name" label="显示昵称" required maxlength="60" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="profile.timezone" :items="commonTimezones" label="所在时区" />
            </v-col>
          </v-row>
          <div class="d-flex justify-end mt-4">
            <v-btn type="submit" color="primary" prepend-icon="mdi-content-save-outline" :loading="profileBusy">
              保存资料
            </v-btn>
          </div>
        </v-form>
      </v-card>

      <v-card color="surface" class="pa-5">
        <div class="text-title-medium font-weight-bold mb-4 d-flex align-center ga-2">
          <v-icon icon="mdi-key-outline" color="primary" />
          修改密码
        </div>
        <v-form @submit.prevent="submitPassword">
          <v-row density="compact" align="center">
            <v-col cols="12" md="5">
              <v-text-field v-model="pwForm.currentPassword" label="当前密码" type="password" required />
            </v-col>
            <v-col cols="12" md="5">
              <v-text-field v-model="pwForm.newPassword" label="新密码（至少 8 位）" type="password" required />
            </v-col>
            <v-col cols="12" md="2">
              <v-btn type="submit" variant="tonal" color="primary" block height="48" :loading="pwBusy">
                修改密码
              </v-btn>
            </v-col>
          </v-row>
        </v-form>
      </v-card>
    </div>
  </div>
</template>
