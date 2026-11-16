<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import type { UserPersona } from '../lib/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const busy = ref(false);

const form = reactive<UserPersona>({
  enabled: false,
  name: '',
  species: '',
  pronouns: '',
  appearance: '',
  personality: '',
  background: '',
});

watch(
  () => store.user?.persona,
  (p) => {
    if (!p) return;
    form.enabled = p.enabled;
    form.name = p.name;
    form.species = p.species;
    form.pronouns = p.pronouns;
    form.appearance = p.appearance;
    form.personality = p.personality;
    form.background = p.background;
  },
  { immediate: true }
);

async function save() {
  busy.value = true;
  try {
    const res = await api.updatePersona({ ...form });
    store.setUser(res.user);
    store.notify('个人设定已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存失败', 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="cp-page cp-page--narrow">
    <div class="cp-page-header">
      <div>
        <h1 class="cp-page-title">个人设定</h1>
      <p class="cp-page-subtitle">
        开启后，你的名称、种族、人称与背景设定会以轻量化参考的方式注入每次对话的系统提示中。
      </p>
      </div>
    </div>

    <EmptyState v-if="!store.user" icon="mdi-account-badge-outline" title="登录后编辑你的个人设定" description="设定好你的角色形象，让 AI 伙伴记住你的样子。">
      <template #action>
        <v-btn color="primary" @click="store.openAuth('login')">立即登录</v-btn>
      </template>
    </EmptyState>

    <v-card v-else class="pa-6">
      <v-form class="d-flex flex-column ga-4" @submit.prevent="save">
        <v-sheet color="surface-light" rounded="lg" class="pa-4 d-flex align-center justify-space-between ga-4">
          <div>
            <div class="text-title-small font-weight-bold">在对话中注入个人设定</div>
            <div class="text-body-small text-medium-emphasis">仅发送非空字段，总长度自动控制，避免挤压上下文窗口</div>
          </div>
          <v-switch v-model="form.enabled" aria-label="启用个人设定" />
        </v-sheet>

        <v-row density="compact">
          <v-col cols="12" md="4">
            <v-text-field v-model="form.name" label="称呼 / 名字" maxlength="60" placeholder="例如：晨曦" />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field v-model="form.species" label="物种 / 身份" maxlength="60" placeholder="例如：独角兽 / 旅人" />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field v-model="form.pronouns" label="人称代词" maxlength="40" placeholder="例如：她 / 他 / 它" />
          </v-col>
        </v-row>

        <v-textarea v-model="form.appearance" label="外貌特征" rows="2" maxlength="800" placeholder="描述你的外貌、发色、服饰或标志性物品..." />
        <v-textarea v-model="form.personality" label="性格习惯" rows="3" maxlength="1000" placeholder="描述你的说话风格、脾气或日常习惯..." />
        <v-textarea v-model="form.background" label="背景故事" rows="3" maxlength="1500" placeholder="补充过往经历或与角色的相处契机..." />

        <div class="d-flex justify-end">
          <v-btn type="submit" color="primary" size="large" prepend-icon="mdi-content-save-outline" :loading="busy">
            保存我的设定
          </v-btn>
        </div>
      </v-form>
    </v-card>
  </div>
</template>
