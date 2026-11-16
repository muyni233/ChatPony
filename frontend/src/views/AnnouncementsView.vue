<script setup lang="ts">
import EmptyState from '../components/m3/EmptyState.vue';
import { formatDateTime } from '../lib/display';
import { useAppStore } from '../stores/app';

const store = useAppStore();
</script>

<template>
  <div class="cp-page cp-page--narrow">
    <div class="cp-page-header">
      <div>
        <h1 class="cp-page-title">站内公告</h1>
        <p class="cp-page-subtitle">版本更新与服务说明。</p>
      </div>
    </div>

    <div v-if="store.announcements.length" class="d-flex flex-column ga-4">
      <article v-for="item in store.announcements" :key="item.id" class="cp-panel cp-ann" :class="{ 'is-pinned': item.pinned }">
        <div class="cp-ann__meta">
          <span v-if="item.pinned" class="cp-ann__pin"><v-icon icon="mdi-pin" size="12" />置顶</span>
          <time :datetime="item.createdAt">{{ formatDateTime(item.createdAt) }}</time>
        </div>
        <h2 class="cp-ann__title">{{ item.title }}</h2>
        <div class="cp-ann__body">{{ item.content }}</div>
      </article>
    </div>

    <EmptyState v-else icon="mdi-bullhorn-outline" title="暂无已发布的公告" description="当管理员发布版本更新或服务说明时，会显示在这里。" />
  </div>
</template>

<style scoped>
.cp-ann {
  padding: 22px 24px;
  position: relative;
}
.cp-ann.is-pinned::before {
  content: '';
  position: absolute;
  left: 0;
  top: 22px;
  bottom: 22px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: rgb(var(--v-theme-primary));
}
.cp-ann__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
  margin-bottom: 6px;
}
.cp-ann__pin {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-weight: 700;
  color: rgb(var(--v-theme-primary));
}
.cp-ann__title {
  margin: 0 0 8px;
  font-size: 1.375rem;
  font-weight: 400;
  line-height: 1.75rem;
  letter-spacing: 0;
}
.cp-ann__body {
  font-size: 0.9375rem;
  line-height: 1.75;
  white-space: pre-wrap;
  color: rgb(var(--v-theme-on-surface));
}
@media (max-width: 599px) {
  .cp-ann { padding: 18px; }
}
</style>
