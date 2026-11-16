<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/display';
import type { RequestAuditDetail, RequestAuditList, RequestAuditStats } from '../../lib/types';
import { useAppStore } from '../../stores/app';

const store = useAppStore();

const statusItems = [
  { title: '全部状态', value: 'all' },
  { title: '成功', value: 'success' },
  { title: '失败', value: 'failed' },
  { title: '进行中', value: 'pending' },
];

const kindItems = [
  { title: '全部类型', value: 'all' },
  { title: 'chat', value: 'chat' },
  { title: 'memory', value: 'memory' },
  { title: 'compression', value: 'compression' },
  { title: 'embedding', value: 'embedding' },
  { title: 'test', value: 'test' },
];

const list = ref<RequestAuditList | null>(null);
const stats = ref<RequestAuditStats | null>(null);
const page = ref(1);
const status = ref('all');
const kind = ref('all');
const search = ref('');
const detail = ref<RequestAuditDetail | null>(null);
const detailOpen = ref(false);

async function load() {
  try {
    const [l, s] = await Promise.all([
      api.adminListAudit({
        page: page.value,
        pageSize: 25,
        status: status.value,
        kind: kind.value,
        q: search.value.trim() || undefined,
      }),
      api.adminAuditStats(24),
    ]);
    list.value = l;
    stats.value = s;
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '加载审计日志失败', 'error');
  }
}

onMounted(load);
watch([page, status, kind], load);

async function openDetail(id: string) {
  try {
    detail.value = await api.adminAuditDetail(id);
    detailOpen.value = true;
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '加载详情失败', 'error');
  }
}

async function clearAll() {
  if (!window.confirm('确认清空全部请求审计记录吗？')) return;
  try {
    await api.adminClearAudit();
    page.value = 1;
    await load();
    store.notify('审计日志已清空', 'info');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '清空失败', 'error');
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-5">
    <v-row v-if="stats" density="compact">
      <v-col cols="6" sm="3">
        <v-card color="surface-light" class="pa-4">
          <div class="text-body-small text-medium-emphasis">24h 总请求</div>
          <div class="text-headline-small font-weight-bold mt-1">{{ stats.total }}</div>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card color="surface-light" class="pa-4">
          <div class="text-body-small text-medium-emphasis">成功 / 失败</div>
          <div class="text-headline-small font-weight-bold mt-1">{{ stats.success }} / {{ stats.failed }}</div>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card color="surface-light" class="pa-4">
          <div class="text-body-small text-medium-emphasis">平均延迟</div>
          <div class="text-headline-small font-weight-bold mt-1">{{ stats.avgDurationMs }} ms</div>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card color="surface-light" class="pa-4">
          <div class="text-body-small text-medium-emphasis">Token 输入 / 输出</div>
          <div class="text-title-large font-weight-bold mt-1">{{ stats.inputTokens }} / {{ stats.outputTokens }}</div>
        </v-card>
      </v-col>
    </v-row>

    <v-card border class="pa-5">
      <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
        <div class="d-flex ga-2 flex-wrap align-center">
          <v-select v-model="status" :items="statusItems" density="compact" style="width:130px" />
          <v-select v-model="kind" :items="kindItems" density="compact" style="width:140px" />
          <v-text-field
            v-model="search"
            density="compact"
            prepend-inner-icon="mdi-magnify"
            placeholder="搜索模型/用户/错误..."
            style="width:220px"
            @keydown.enter="page = 1; load()"
          />
          <v-btn variant="tonal" color="primary" size="small" icon="mdi-refresh" aria-label="刷新审计日志" @click="page = 1; load()" />
        </div>
        <v-btn color="error" variant="tonal" size="small" prepend-icon="mdi-delete-sweep-outline" @click="clearAll">
          清空日志
        </v-btn>
      </div>

      <div v-if="list?.items.length" class="d-flex flex-column ga-2">
        <v-sheet
          v-for="item in list.items"
          :key="item.id"
          color="surface-light"
          rounded="lg"
          class="pa-3 d-flex align-center ga-2 flex-wrap"
        >
          <v-chip
            size="x-small"
            :color="item.status === 'success' ? 'success' : item.status === 'failed' ? 'error' : 'warning'"
            variant="tonal"
          >
            {{ item.status }}
          </v-chip>
          <v-chip size="x-small" variant="tonal">{{ item.kind }}</v-chip>
          <strong class="text-body-medium">{{ item.model }}</strong>
          <span class="text-body-small text-medium-emphasis">
            {{ item.supplierName || item.protocol }} · HTTP {{ item.httpStatus ?? '—' }} · {{ item.durationMs ?? 0 }}ms
          </span>
          <span v-if="item.userName" class="text-body-small text-medium-emphasis">用户: {{ item.userName }}</span>
          <span class="ms-auto text-body-small text-medium-emphasis">
            {{ formatDateTime(item.createdAt) }}
          </span>
          <v-btn variant="outlined" size="small" prepend-icon="mdi-eye-outline" @click="openDetail(item.id)">
            详情
          </v-btn>
        </v-sheet>
      </div>
      <div v-else class="text-body-medium text-medium-emphasis">暂无审计记录。</div>

      <div v-if="list && list.total > list.pageSize" class="d-flex justify-center mt-4">
        <v-pagination
          v-model="page"
          :length="Math.max(1, Math.ceil(list.total / list.pageSize))"
          density="comfortable"
          total-visible="5"
        />
      </div>
    </v-card>

    <v-dialog v-model="detailOpen" max-width="780">
      <v-card class="pa-2">
        <v-card-title class="d-flex align-center justify-space-between">
          <span class="font-weight-bold">模型请求审计详情（已脱敏）</span>
          <v-btn icon="mdi-close" variant="text" size="small" @click="detailOpen = false" />
        </v-card-title>
        <v-card-text v-if="detail" class="d-flex flex-column ga-3 text-body-medium">
          <div><strong>端点：</strong><code class="font-mono">{{ detail.endpoint }}</code></div>
          <v-alert v-if="detail.errorMessage" type="error" variant="tonal" density="compact">
            {{ detail.errorCode }} · {{ detail.errorMessage }}
          </v-alert>
          <div>
            <div class="text-body-small font-weight-bold mb-1">
              请求体 {{ detail.requestTruncated ? '(已截断至 16KB)' : '' }}
            </div>
            <pre class="cp-code-pre">{{ detail.requestBody || '未开启正文字段采集或无请求体' }}</pre>
          </div>
          <div>
            <div class="text-body-small font-weight-bold mb-1">
              响应体 {{ detail.responseTruncated ? '(已截断至 16KB)' : '' }}
            </div>
            <pre class="cp-code-pre">{{ detail.responseBody || '未开启正文字段采集或无响应体' }}</pre>
          </div>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="detailOpen = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
