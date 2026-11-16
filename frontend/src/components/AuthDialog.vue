<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { api, ApiError } from '../lib/api';
import { useAppStore } from '../stores/app';

const store = useAppStore();

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const name = ref('');
const code = ref('');
const errorMsg = ref('');
const busy = ref(false);
const codeBusy = ref(false);
const cooldown = ref(0);
const policy = ref<{
  registrationOpen: boolean;
  requireEmailVerification: boolean;
  emailDomainMode: string;
  emailDomains: string[];
} | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
onUnmounted(stopTimer);

const open = computed({
  get: () => store.authDialogMode !== null,
  set: (v: boolean) => {
    if (!v) store.closeAuth();
  },
});

watch(
  () => store.authDialogMode,
  async (next) => {
    if (!next) return;
    mode.value = next;
    errorMsg.value = '';
    try {
      policy.value = await api.registrationPolicy();
    } catch {
      policy.value = null;
    }
  }
);

const domainHint = computed(() => {
  if (!policy.value || policy.value.emailDomainMode === 'any' || !policy.value.emailDomains.length) {
    return '';
  }
  const list = policy.value.emailDomains.slice(0, 5).join('、');
  return policy.value.emailDomainMode === 'allowlist'
    ? `仅开放指定邮箱后缀注册：${list}`
    : `暂不支持以下邮箱后缀：${list}`;
});

async function handleSendCode() {
  if (!email.value.trim()) {
    errorMsg.value = '请先输入电子邮箱地址';
    return;
  }
  errorMsg.value = '';
  codeBusy.value = true;
  try {
    await api.sendCode(email.value.trim());
    store.notify('验证码已发送到您的邮箱', 'success');
    cooldown.value = 60;
    stopTimer();
    timer = setInterval(() => {
      cooldown.value = Math.max(0, cooldown.value - 1);
      if (cooldown.value === 0) stopTimer();
    }, 1000);
  } catch (err) {
    errorMsg.value = err instanceof ApiError ? err.message : '发送验证码失败';
  } finally {
    codeBusy.value = false;
  }
}

async function handleSubmit() {
  errorMsg.value = '';
  busy.value = true;
  try {
    if (mode.value === 'login') {
      await api.login(email.value.trim(), password.value);
      await store.refresh();
      store.closeAuth();
      store.notify('欢迎回到 ChatPony', 'success');
    } else {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      await api.register({
        email: email.value.trim(),
        password: password.value,
        name: name.value.trim(),
        timezone: tz,
        verificationCode: code.value.trim() || undefined,
      });
      await store.refresh();
      store.closeAuth();
      store.notify('注册成功，已自动登录', 'success');
    }
  } catch (err) {
    errorMsg.value = err instanceof ApiError ? err.message : '操作失败，请稍后重试';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="480">
    <v-card class="pa-6" color="surface">
      <div class="d-flex align-start justify-space-between mb-4">
        <div>
          <img src="/icon.svg" alt="ChatPony" width="40" height="40" class="mb-4" style="display:block;border-radius:10px" />
          <h3 class="text-headline-small font-weight-bold">
            {{ mode === 'login' ? '登录 ChatPony' : '创建新账号' }}
          </h3>
          <div class="text-body-medium text-medium-emphasis mt-1">
            {{ mode === 'login' ? '输入邮箱与密码进入对话空间' : '注册账号以保存对话记录与角色记忆' }}
          </div>
        </div>
        <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭弹窗" @click="store.closeAuth()" />
      </div>

      <v-btn-toggle
        v-model="mode"
        mandatory
        divided
        variant="outlined"
        color="primary"
        rounded="pill"
        class="w-100 mb-4"
        @update:model-value="errorMsg = ''"
      >
        <v-btn value="login" class="flex-grow-1">登录账号</v-btn>
        <v-btn value="register" class="flex-grow-1">新用户注册</v-btn>
      </v-btn-toggle>

      <v-alert
        v-if="mode === 'register' && policy && !policy.registrationOpen"
        type="warning"
        variant="tonal"
        class="mb-4"
      >
        平台当前暂未开放自主注册，请联系管理员协助创建账号。
      </v-alert>

      <v-form class="d-flex flex-column ga-3" @submit.prevent="handleSubmit">
        <v-text-field
          v-if="mode === 'register'"
          id="auth-name"
          v-model="name"
          label="昵称"
          required
          maxlength="60"
          placeholder="例如：星光旅人"
        />

        <v-text-field
          id="auth-email"
          v-model="email"
          label="电子邮箱"
          type="email"
          required
          placeholder="name@example.com"
          :hint="mode === 'register' ? domainHint : undefined"
          persistent-hint
        />

        <div v-if="mode === 'register' && policy?.requireEmailVerification" class="d-flex ga-2 align-start">
          <v-text-field
            id="auth-code"
            v-model="code"
            label="邮箱验证码"
            required
            maxlength="12"
            placeholder="6 位数字"
          />
          <v-btn
            variant="tonal"
            color="primary"
            height="48"
            :disabled="codeBusy || cooldown > 0"
            @click="handleSendCode"
          >
            {{ cooldown > 0 ? `${cooldown}s` : codeBusy ? '发送中...' : '发送验证码' }}
          </v-btn>
        </div>

        <v-text-field
          id="auth-password"
          v-model="password"
          label="密码"
          type="password"
          required
          placeholder="至少 8 个字符"
        />

        <v-alert v-if="errorMsg" type="error" variant="tonal" density="compact">
          {{ errorMsg }}
        </v-alert>

        <v-btn
          type="submit"
          color="primary"
          size="large"
          block
          class="mt-2"
          :loading="busy"
          :disabled="mode === 'register' && policy?.registrationOpen === false"
          prepend-icon="mdi-sparkles"
        >
          {{ mode === 'login' ? '立即登录' : '创建账号并进入' }}
        </v-btn>
      </v-form>
    </v-card>
  </v-dialog>
</template>
