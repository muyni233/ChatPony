<script setup lang="ts">
import type { QuotaSnapshot, QuotaWindow } from '../lib/types';
import { formatDateTime } from '../lib/display';

defineProps<{
  quota: QuotaSnapshot;
  compact?: boolean;
}>();

function pct(value: number, max: number): number {
  if (max <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function barColor(c: string): string {
  return `rgb(var(--v-theme-${c}))`;
}

function tone(w: QuotaWindow): string {
  const left = pct(w.remaining, w.limit);
  if (left <= 10) return 'error';
  if (left <= 25) return 'warning';
  return '';
}
</script>

<template>
  <div v-if="compact" class="cp-quota-mini">
    <div
      v-for="row in [
        { key: '5h', label: '5 小时', w: quota.fiveHour, color: 'primary' },
        { key: '7d', label: '7 天', w: quota.sevenDay, color: 'tertiary' },
      ]"
      :key="row.key"
      class="cp-quota-mini__row"
    >
      <div class="d-flex justify-space-between align-baseline mb-1">
        <span class="cp-quota-mini__label">{{ row.label }}额度</span>
        <span class="cp-quota-mini__value">
          <strong>{{ row.w.remaining }}</strong><span class="cp-faint"> / {{ row.w.limit }}</span>
        </span>
      </div>
      <div class="cp-meter" style="--h:4px" role="progressbar" :aria-valuenow="row.w.remaining" aria-valuemin="0" :aria-valuemax="row.w.limit">
        <span class="cp-meter__fill" :class="tone(row.w) && `bg-${tone(row.w)}`" :style="{ width: pct(row.w.remaining, row.w.limit) + '%', background: tone(row.w) ? undefined : barColor(row.color) }" />
      </div>
    </div>
  </div>

  <div v-else class="cp-panel pa-5 pa-sm-6">
    <div class="d-flex align-center justify-space-between mb-5 flex-wrap ga-2">
      <div>
        <div class="text-title-medium font-weight-bold">对话调用额度</div>
        <div class="text-body-small cp-muted">双滑动窗口 · 每次 AI 回复计 1 次</div>
      </div>
    </div>
    <div class="cp-quota-grid">
      <div
        v-for="row in [
          { key: '5h', label: '5 小时窗口', w: quota.fiveHour, color: 'primary' },
          { key: '7d', label: '7 天窗口', w: quota.sevenDay, color: 'tertiary' },
        ]"
        :key="row.key"
        class="cp-quota-cell"
      >
        <div class="d-flex justify-space-between align-baseline mb-3">
          <span class="text-body-medium cp-muted">{{ row.label }}</span>
          <span class="text-body-small cp-faint">已用 {{ row.w.used }}</span>
        </div>
        <div class="cp-quota-big mb-3">
          剩余 {{ row.w.remaining }} / {{ row.w.limit }}
        </div>
        <div class="cp-meter mb-3" style="--h:6px" role="progressbar" :aria-valuenow="row.w.remaining" aria-valuemin="0" :aria-valuemax="row.w.limit">
          <span class="cp-meter__fill" :class="tone(row.w) && `bg-${tone(row.w)}`" :style="{ width: pct(row.w.remaining, row.w.limit) + '%', background: tone(row.w) ? undefined : barColor(row.color) }" />
        </div>
        <div class="text-body-small cp-faint">最早恢复：{{ formatDateTime(row.w.resetsAt) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-meter {
  position: relative;
  height: var(--h, 4px);
  border-radius: 999px;
  overflow: hidden;
  background: rgb(var(--v-theme-secondary-container));
}
.cp-meter__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  transition: width 0.4s var(--cp-ease, ease);
}
.cp-quota-mini {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--cp-radius-md);
  background: rgb(var(--v-theme-surface-container));
}
.cp-quota-mini__label {
  font-size: 0.75rem;
  font-weight: 500;
  color: rgb(var(--v-theme-on-surface-variant));
}
.cp-quota-mini__value {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.cp-quota-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.cp-quota-cell {
  padding: 16px 18px;
  border-radius: var(--cp-radius-md);
  background: rgb(var(--v-theme-surface-container));
}
.cp-quota-big {
  font-size: 1.375rem;
  line-height: 1.75rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
</style>
