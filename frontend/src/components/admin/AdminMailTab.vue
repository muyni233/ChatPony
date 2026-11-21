<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/display';
import type { MailDeliveryList, PlatformSettings } from '../../lib/types';
import { useAppStore } from '../../stores/app';

const props = defineProps<{ settings: PlatformSettings }>();
const emit = defineEmits<{ refresh: [] }>();
const store = useAppStore();

const domainModeItems = [
  { title: '不限制域名 (any)', value: 'any' },
  { title: '仅允许名单 (allowlist)', value: 'allowlist' },
  { title: '屏蔽黑名单 (blocklist)', value: 'blocklist' },
];

const statusItems = [
  { title: '全部状态', value: 'all' },
  { title: '成功', value: 'success' },
  { title: '失败', value: 'failed' },
];

const policyForm = reactive({
  requireEmailVerification: false,
  emailDomainMode: 'any' as 'any' | 'allowlist' | 'blocklist',
  emailDomainsText: '',
});

const mailForm = reactive({
  host: '',
  port: 587,
  secure: false,
  requireTLS: false,
  username: '',
  password: '',
  fromEmail: '',
  fromName: 'ChatPony',
  hasPassword: false,
});

const testRecipient = ref('');
const testBusy = ref(false);
const policyBusy = ref(false);
const mailBusy = ref(false);
const deliveries = ref<MailDeliveryList | null>(null);
const page = ref(1);
const statusFilter = ref('all');

watch(
  () => props.settings,
  (s) => {
    policyForm.requireEmailVerification = s.requireEmailVerification;
    policyForm.emailDomainMode = s.emailDomainMode;
    policyForm.emailDomainsText = s.emailDomains.join('\n');
  },
  { immediate: true }
);

async function loadMail() {
  try {
    const cfg = await api.adminGetMail();
    mailForm.host = cfg.host;
    mailForm.port = cfg.port;
    mailForm.secure = cfg.secure;
    mailForm.requireTLS = cfg.requireTLS;
    mailForm.username = cfg.username;
    mailForm.password = '';
    mailForm.fromEmail = cfg.fromEmail;
    mailForm.fromName = cfg.fromName;
    mailForm.hasPassword = cfg.hasPassword;
    await loadDeliveries();
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '加载邮件配置失败', 'error');
  }
}

async function loadDeliveries() {
  try {
    deliveries.value = await api.adminListMailDeliveries({
      page: page.value,
      pageSize: 12,
      status: statusFilter.value,
    });
  } catch {
    deliveries.value = null;
  }
}

onMounted(loadMail);
watch(page, loadDeliveries);
watch(statusFilter, () => {
  if (page.value !== 1) {
    page.value = 1;
  } else {
    loadDeliveries();
  }
});

async function savePolicy() {
  policyBusy.value = true;
  const emailDomains = policyForm.emailDomainsText
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await api.adminSaveSettings({
      requireEmailVerification: policyForm.requireEmailVerification,
      emailDomainMode: policyForm.emailDomainMode,
      emailDomains,
    });
    emit('refresh');
    store.notify('邮箱注册与域名策略已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存失败', 'error');
  } finally {
    policyBusy.value = false;
  }
}

async function saveMail() {
  mailBusy.value = true;
  try {
    await api.adminSaveMail({
      host: mailForm.host.trim(),
      port: Number(mailForm.port),
      secure: mailForm.secure,
      requireTLS: mailForm.requireTLS,
      username: mailForm.username,
      password: mailForm.password ? mailForm.password : undefined,
      fromEmail: mailForm.fromEmail.trim(),
      fromName: mailForm.fromName.trim(),
    });
    mailForm.password = '';
    await loadMail();
    store.notify('SMTP 配置已加密保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存 SMTP 失败', 'error');
  } finally {
    mailBusy.value = false;
  }
}

async function sendTest() {
  testBusy.value = true;
  try {
    const res = await api.adminTestMail(testRecipient.value.trim() || undefined);
    await loadDeliveries();
    store.notify(res.summary, 'success');
  } catch (err) {
    await loadDeliveries();
    store.notify(err instanceof ApiError ? err.message : '测试发送失败', 'error');
  } finally {
    testBusy.value = false;
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-5">
    <!-- Domain & Verification Policy -->
    <v-card rounded="xl" class="pa-5">
      <h3 class="text-title-medium font-weight-bold mb-4">邮箱验证与域名规则</h3>
      <v-form class="d-flex flex-column ga-4" @submit.prevent="savePolicy">
        <v-sheet color="surface-container" rounded="lg" class="pa-3 px-4 d-flex align-center justify-space-between ga-3">
          <div>
            <div class="text-body-large font-weight-medium">新用户注册必须验证邮箱</div>
            <div class="text-body-small text-medium-emphasis">开启前请先确认下方 SMTP 发信已配置并测试通过</div>
          </div>
          <v-switch v-model="policyForm.requireEmailVerification" hide-details />
        </v-sheet>
        <v-row density="compact">
          <v-col cols="12" md="4">
            <v-select v-model="policyForm.emailDomainMode" label="域名过滤模式" :items="domainModeItems" />
          </v-col>
          <v-col cols="12" md="8">
            <v-textarea
              v-model="policyForm.emailDomainsText"
              label="域名列表（每行一个，支持 *.edu.cn 通配与 IDN 域名）"
              rows="3"
              placeholder="example.com&#10;*.edu.cn"
            />
          </v-col>
        </v-row>
        <div class="d-flex justify-end">
          <v-btn color="primary" type="submit" size="small" :loading="policyBusy">保存邮箱策略</v-btn>
        </div>
      </v-form>
    </v-card>

    <!-- SMTP Config -->
    <v-card rounded="xl" class="pa-5">
      <h3 class="text-title-medium font-weight-bold mb-4 d-flex align-center ga-2">
        <v-icon color="primary" size="20">mdi-email-outline</v-icon>
        SMTP 发信配置
      </h3>
      <v-form @submit.prevent="saveMail">
        <v-row density="compact">
          <v-col cols="12" sm="6" md="4"><v-text-field v-model="mailForm.host" label="SMTP 主机" placeholder="smtp.example.com" /></v-col>
          <v-col cols="12" sm="6" md="4"><v-text-field v-model.number="mailForm.port" label="端口" type="number" /></v-col>
          <v-col cols="12" sm="6" md="4"><v-text-field v-model="mailForm.username" label="用户名" autocomplete="off" /></v-col>
          <v-col cols="12" sm="6" md="4">
            <v-text-field
              v-model="mailForm.password"
              :label="`密码/授权码 ${mailForm.hasPassword ? '(已保存)' : ''}`"
              type="password"
              autocomplete="new-password"
              placeholder="留空保持不变"
            />
          </v-col>
          <v-col cols="12" sm="6" md="4"><v-text-field v-model="mailForm.fromEmail" label="发件人邮箱" type="email" /></v-col>
          <v-col cols="12" sm="6" md="4"><v-text-field v-model="mailForm.fromName" label="发件人署名" /></v-col>
        </v-row>
        <div class="d-flex align-center justify-space-between flex-wrap ga-3 mt-4">
          <div class="d-flex ga-6 flex-wrap">
            <v-switch v-model="mailForm.secure" label="隐式 TLS (465)" />
            <v-switch v-model="mailForm.requireTLS" label="强制 STARTTLS (587)" />
          </div>
          <v-btn color="primary" type="submit" :loading="mailBusy">保存 SMTP 配置</v-btn>
        </div>
      </v-form>

      <v-divider class="my-4" />

      <div class="d-flex ga-3 flex-wrap align-center">
        <v-text-field
          v-model="testRecipient"
          style="max-width:300px"
          density="compact"
          type="email"
          placeholder="测试收件人邮箱（留空仅测试握手）"
        />
        <v-btn color="primary" variant="tonal" prepend-icon="mdi-send-outline" :loading="testBusy" @click="sendTest">
          {{ testBusy ? '测试中...' : '发送测试 / 检查连接' }}
        </v-btn>
      </div>
    </v-card>

    <!-- Diagnostics Log -->
    <v-card rounded="xl" class="pa-5">
      <div class="d-flex align-center justify-space-between mb-4 flex-wrap ga-3">
        <h3 class="text-title-medium font-weight-bold">
          邮件投递诊断日志（保留 {{ deliveries?.retentionDays ?? 30 }} 天）
        </h3>
        <div class="d-flex ga-2 align-center">
          <v-select v-model="statusFilter" :items="statusItems" density="compact" style="width:140px" />
          <v-btn variant="outlined" size="small" icon="mdi-refresh" aria-label="刷新日志" @click="loadDeliveries" />
        </div>
      </div>

      <div v-if="deliveries?.items.length" class="d-flex flex-column ga-2">
        <v-sheet v-for="d in deliveries.items" :key="d.id" color="surface-container" rounded="lg" class="pa-3">
          <div class="d-flex align-center ga-2 flex-wrap">
            <v-chip size="x-small" :color="d.status === 'success' ? 'success' : 'error'" variant="tonal">{{ d.status }}</v-chip>
            <v-chip size="x-small" variant="tonal">{{ d.kind }}</v-chip>
            <strong class="text-body-medium">{{ d.recipient || d.smtpHost }}</strong>
            <span class="ms-auto text-body-small text-medium-emphasis">
              {{ formatDateTime(d.createdAt) }} · {{ d.durationMs ?? 0 }}ms
            </span>
          </div>
          <div class="text-body-medium text-medium-emphasis mt-1">
            {{ d.summary }} <span v-if="d.hint">· 建议：{{ d.hint }}</span>
          </div>
        </v-sheet>
      </div>
      <div v-else class="text-body-medium text-medium-emphasis">暂无邮件投递记录。</div>

      <div v-if="deliveries && deliveries.total > deliveries.pageSize" class="d-flex justify-center mt-4">
        <v-pagination
          v-model="page"
          :length="Math.max(1, Math.ceil(deliveries.total / deliveries.pageSize))"
          density="comfortable"
          total-visible="5"
        />
      </div>
    </v-card>
  </div>
</template>
