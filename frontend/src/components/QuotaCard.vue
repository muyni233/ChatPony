<script setup lang="ts">
import type { QuotaSnapshot } from '../lib/types';
import { formatDateTime } from '../lib/display';

defineProps<{
  quota: QuotaSnapshot;
  compact?: boolean;
}>();

function pct(value: number, max: number): number {
  if (max <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}
</script>

<template>
  <v-sheet v-if="compact" color="surface" rounded="lg" class="pa-3">
    <div class="d-flex justify-space-between text-caption mb-1">
      <span class="text-medium-emphasis">5 小时额度</span>
      <strong class="font-weight-bold">{{ quota.fiveHour.remaining }} / {{ quota.fiveHour.limit }}</strong>
    </div>
    <v-progress-linear
      :model-value="pct(quota.fiveHour.remaining, quota.fiveHour.limit)"
      color="primary"
      height="7"
      rounded
      class="mb-2"
    />
    <div class="d-flex justify-space-between text-caption mb-1">
      <span class="text-medium-emphasis">7 天额度</span>
      <strong class="font-weight-bold">{{ quota.sevenDay.remaining }} / {{ quota.sevenDay.limit }}</strong>
    </div>
    <v-progress-linear
      :model-value="pct(quota.sevenDay.remaining, quota.sevenDay.limit)"
      color="secondary"
      height="7"
      rounded
    />
  </v-sheet>

  <v-card v-else color="surface" class="pa-5">
    <div class="d-flex align-center justify-space-between mb-4 flex-wrap ga-2">
      <div>
        <div class="text-subtitle-1 font-weight-bold">对话调用额度（双滑动窗口）</div>
        <div class="text-caption text-medium-emphasis">每次 AI 模型回复计 1 次调用额度</div>
      </div>
    </div>
    <v-row density="compact">
      <v-col cols="12" md="6">
        <v-sheet color="surface-light" rounded="lg" class="pa-4">
          <div class="d-flex justify-space-between text-body-2 mb-2">
            <span>5 小时窗口（已用 {{ quota.fiveHour.used }}）</span>
            <strong>剩余 {{ quota.fiveHour.remaining }} / {{ quota.fiveHour.limit }}</strong>
          </div>
          <v-progress-linear
            :model-value="pct(quota.fiveHour.used, quota.fiveHour.limit)"
            color="primary"
            height="8"
            rounded
            class="mb-2"
          />
          <div class="text-caption text-medium-emphasis">
            最早恢复：{{ formatDateTime(quota.fiveHour.resetsAt) }}
          </div>
        </v-sheet>
      </v-col>
      <v-col cols="12" md="6">
        <v-sheet color="surface-light" rounded="lg" class="pa-4">
          <div class="d-flex justify-space-between text-body-2 mb-2">
            <span>7 天窗口（已用 {{ quota.sevenDay.used }}）</span>
            <strong>剩余 {{ quota.sevenDay.remaining }} / {{ quota.sevenDay.limit }}</strong>
          </div>
          <v-progress-linear
            :model-value="pct(quota.sevenDay.used, quota.sevenDay.limit)"
            color="secondary"
            height="8"
            rounded
            class="mb-2"
          />
          <div class="text-caption text-medium-emphasis">
            最早恢复：{{ formatDateTime(quota.sevenDay.resetsAt) }}
          </div>
        </v-sheet>
      </v-col>
    </v-row>
  </v-card>
</template>
