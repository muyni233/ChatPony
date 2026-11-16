<script setup lang="ts">
import EmptyState from '../components/m3/EmptyState.vue';
import { formatDateTime } from '../lib/display';
import { useAppStore } from '../stores/app';

const store = useAppStore();
</script>

<template>
  <v-container fluid class="pa-5 pa-md-8" style="max-width:1000px">
    <div class="mb-5">
      <h1 class="text-h5 text-sm-h4 font-weight-bold">站内公告</h1>
    </div>

    <div v-if="store.announcements.length" class="d-flex flex-column ga-4">
      <v-card v-for="item in store.announcements" :key="item.id" color="surface" class="pa-5">
        <div class="d-flex align-center flex-wrap ga-2 mb-3">
          <v-chip v-if="item.pinned" size="small" color="tertiary" variant="tonal">置顶</v-chip>
          <h2 class="text-h6 font-weight-bold mb-0">{{ item.title }}</h2>
          <span class="text-caption text-medium-emphasis ml-auto">{{ formatDateTime(item.createdAt) }}</span>
        </div>
        <div class="text-body-1" style="white-space:pre-wrap;line-height:1.75">{{ item.content }}</div>
      </v-card>
    </div>

    <EmptyState v-else icon="mdi-bullhorn-outline" title="暂无已发布的公告" description="当管理员发布版本更新或服务说明时，会显示在这里。" />
  </v-container>
</template>
