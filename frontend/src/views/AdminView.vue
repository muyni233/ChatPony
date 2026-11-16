<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import AdminAuditTab from '../components/admin/AdminAuditTab.vue';
import AdminCharactersTab from '../components/admin/AdminCharactersTab.vue';
import AdminMailTab from '../components/admin/AdminMailTab.vue';
import AdminSuppliersTab from '../components/admin/AdminSuppliersTab.vue';
import AdminUsersTab from '../components/admin/AdminUsersTab.vue';
import EmptyState from '../components/m3/EmptyState.vue';
import { api, ApiError } from '../lib/api';
import type {
  AdminOverview,
  Announcement,
  Character,
  EmbeddingConfig,
  PlatformSettings,
  ProviderConfig,
  SupplierConfig,
  User,
} from '../lib/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();

const tabs = [
  { key: 'overview', label: '概览', icon: 'mdi-view-dashboard-outline' },
  { key: 'providers', label: '供应商与模型', icon: 'mdi-chip' },
  { key: 'characters', label: '官方角色', icon: 'mdi-account-star-outline' },
  { key: 'users', label: '用户与额度', icon: 'mdi-account-group-outline' },
  { key: 'settings', label: '平台设置', icon: 'mdi-tune-variant' },
  { key: 'embedding', label: '向量记忆', icon: 'mdi-brain' },
  { key: 'announcements', label: '公告管理', icon: 'mdi-bullhorn-outline' },
  { key: 'mail', label: '邮件服务', icon: 'mdi-email-outline' },
  { key: 'audit', label: '请求审计', icon: 'mdi-clipboard-text-search-outline' },
] as const;

type TabKey = (typeof tabs)[number]['key'];
const activeTab = ref<TabKey>('overview');

const overview = ref<AdminOverview | null>(null);
const settings = ref<PlatformSettings | null>(null);
const suppliers = ref<SupplierConfig[]>([]);
const models = ref<ProviderConfig[]>([]);
const adminChars = ref<Character[]>([]);
const adminUsers = ref<User[]>([]);
const adminAnnouncements = ref<Announcement[]>([]);
const embedding = ref<EmbeddingConfig | null>(null);

const settingsForm = ref<PlatformSettings | null>(null);
const hiddenSymbolsText = ref('');
const actionMarkersText = ref('');
const settingsBusy = ref(false);

const embForm = reactive({
  enabled: false,
  modelId: '',
  topK: 6,
  minSimilarity: 0.3,
});
const embBusy = ref(false);
const embTesting = ref(false);

const annOpen = ref(false);
const annBusy = ref(false);
const editingAnnId = ref<string | null>(null);
const annForm = reactive({ title: '', content: '', pinned: false, published: true });

const embeddingModels = computed(() => models.value.filter((m) => m.kind === 'embedding'));
const languageModels = computed(() => models.value.filter((m) => m.kind === 'language'));

const languageModelItems = computed(() => [
  { title: '默认首个活跃语言模型', value: '' },
  ...languageModels.value.map((m) => ({ title: m.name, value: m.id })),
]);

const embeddingModelItems = computed(() => [
  { title: '请选择向量模型', value: '' },
  ...embeddingModels.value.map((m) => ({ title: `${m.name} (${m.model})`, value: m.id })),
]);

async function loadAll() {
  if (!store.isAdmin) return;
  try {
    const [ov, st, sups, mods, chars, usrs, anns, emb] = await Promise.all([
      api.adminOverview(),
      api.adminGetSettings(),
      api.adminListSuppliers(),
      api.adminListModels(),
      api.adminListCharacters(),
      api.adminListUsers(),
      api.adminListAnnouncements(),
      api.adminGetEmbedding(),
    ]);
    overview.value = ov;
    settings.value = st;
    settingsForm.value = JSON.parse(JSON.stringify(st));
    hiddenSymbolsText.value = st.hiddenSymbols.join(' ');
    actionMarkersText.value = st.actionMarkers.join(' ');
    suppliers.value = sups;
    models.value = mods;
    adminChars.value = chars;
    adminUsers.value = usrs;
    adminAnnouncements.value = anns;
    embedding.value = emb;
    embForm.enabled = emb.enabled;
    embForm.modelId = emb.modelId;
    embForm.topK = emb.topK;
    embForm.minSimilarity = emb.minSimilarity;
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '加载管理数据失败', 'error');
  }
}

onMounted(loadAll);
watch(() => store.isAdmin, loadAll);

async function savePlatformSettings() {
  if (!settingsForm.value) return;
  settingsBusy.value = true;
  try {
    const hiddenSymbols = hiddenSymbolsText.value.split(/\s+/).filter(Boolean);
    const actionMarkers = actionMarkersText.value.split(/\s+/).filter(Boolean);
    const saved = await api.adminSaveSettings({
      ...settingsForm.value,
      hiddenSymbols,
      actionMarkers,
    });
    settings.value = saved;
    settingsForm.value = JSON.parse(JSON.stringify(saved));
    await store.refresh();
    store.notify('平台设置已保存并同步默认额度', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存设置失败', 'error');
  } finally {
    settingsBusy.value = false;
  }
}

async function saveEmbedding() {
  embBusy.value = true;
  try {
    await api.adminSaveEmbedding({ ...embForm });
    await loadAll();
    store.notify('向量检索配置已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存失败', 'error');
  } finally {
    embBusy.value = false;
  }
}

async function testEmbedding() {
  embTesting.value = true;
  try {
    const res = await api.adminTestEmbedding(embForm.modelId || undefined);
    store.notify(`向量模型测试成功：维度 ${res.dimensions} (${res.durationMs}ms)`, 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '测试失败', 'error');
  } finally {
    embTesting.value = false;
  }
}

function openCreateAnn() {
  editingAnnId.value = null;
  annForm.title = '';
  annForm.content = '';
  annForm.pinned = false;
  annForm.published = true;
  annOpen.value = true;
}

function openEditAnn(a: Announcement) {
  editingAnnId.value = a.id;
  annForm.title = a.title;
  annForm.content = a.content;
  annForm.pinned = a.pinned;
  annForm.published = a.published;
  annOpen.value = true;
}

async function saveAnn() {
  annBusy.value = true;
  try {
    if (editingAnnId.value) {
      await api.adminUpdateAnnouncement(editingAnnId.value, { ...annForm });
    } else {
      await api.adminCreateAnnouncement({ ...annForm });
    }
    annOpen.value = false;
    await loadAll();
    await store.refresh();
    store.notify('公告已保存', 'success');
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '保存公告失败', 'error');
  } finally {
    annBusy.value = false;
  }
}

async function delAnn(id: string) {
  if (!window.confirm('确认删除这条公告吗？')) return;
  try {
    await api.adminDeleteAnnouncement(id);
    await loadAll();
    await store.refresh();
  } catch (err) {
    store.notify(err instanceof ApiError ? err.message : '删除失败', 'error');
  }
}
</script>

<template>
  <div class="cp-page" style="max-width:1240px">
    <div class="cp-page-header">
      <div>
        <h1 class="cp-page-title">管理后台</h1>
        <p class="cp-page-subtitle">用户、角色、模型供应商、邮件与审计的统一管理。</p>
      </div>
    </div>

    <EmptyState
      v-if="!store.isAdmin"
      icon="mdi-shield-outline"
      title="需要管理员权限"
      description="当前账号不具备管理权限。"
    />

    <template v-else>
      <v-card border rounded="lg" class="mb-5">
        <v-tabs v-model="activeTab" color="primary" show-arrows>
          <v-tab v-for="t in tabs" :key="t.key" :value="t.key" :prepend-icon="t.icon">
            {{ t.label }}
          </v-tab>
        </v-tabs>
      </v-card>

      <!-- 1. Overview -->
      <v-row v-if="activeTab === 'overview' && overview" density="compact">
        <v-col cols="6" md="3">
          <v-card border class="pa-5">
            <div class="text-body-small text-medium-emphasis">注册用户</div>
            <div class="text-headline-medium font-weight-bold mt-2 text-primary">{{ overview.users }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card border class="pa-5">
            <div class="text-body-small text-medium-emphasis">官方角色</div>
            <div class="text-headline-medium font-weight-bold mt-2 text-secondary">{{ overview.characters }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card border class="pa-5">
            <div class="text-body-small text-medium-emphasis">累计会话</div>
            <div class="text-headline-medium font-weight-bold mt-2 text-tertiary">{{ overview.conversations }}</div>
          </v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card border class="pa-5">
            <div class="text-body-small text-medium-emphasis">模型调用次数</div>
            <div class="text-headline-medium font-weight-bold mt-2">{{ overview.calls }}</div>
          </v-card>
        </v-col>
      </v-row>

      <!-- 2. Suppliers & Models -->
      <AdminSuppliersTab
        v-else-if="activeTab === 'providers'"
        :suppliers="suppliers"
        :models="models"
        @refresh="loadAll"
      />

      <!-- 3. Characters -->
      <AdminCharactersTab
        v-else-if="activeTab === 'characters'"
        :characters="adminChars"
        :models="models"
        @refresh="loadAll"
      />

      <!-- 4. Users -->
      <AdminUsersTab
        v-else-if="activeTab === 'users'"
        :users="adminUsers"
        @refresh="loadAll"
      />

      <!-- 5. Settings -->
      <v-card v-else-if="activeTab === 'settings' && settingsForm" border class="pa-5">
        <v-form class="d-flex flex-column ga-5" @submit.prevent="savePlatformSettings">
          <div>
            <h3 class="text-title-medium font-weight-bold mb-3">额度、群聊与站点展示</h3>
            <v-row density="compact">
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.defaultLimit5h" label="默认 5 小时额度" type="number" min="0" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.defaultLimit7d" label="默认 7 天额度" type="number" min="0" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.defaultCharacterSlots" label="默认个人 OC 槽位" type="number" min="0" max="100" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.maxGroupRounds" label="群聊最大轮数" type="number" min="1" max="12" />
              </v-col>
              <v-col cols="12" md="9">
                <v-text-field v-model="settingsForm.siteDescription" label="站点描述文案" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="settingsForm.maxImagesPerMessage" label="单条消息最大图片数" type="number" min="1" max="10" />
              </v-col>
            </v-row>
          </div>

          <v-divider />

          <div>
            <h3 class="text-title-medium font-weight-bold mb-3">消息分段与动作样式</h3>
            <v-row density="compact">
              <v-col cols="12" md="4">
                <v-text-field v-model="settingsForm.bubbleDelimiter" label="气泡分割符 (如 |||)" placeholder="留空表示不分割" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="hiddenSymbolsText" label="隐藏展示符号（空格分隔）" placeholder="例如：~~ ###" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="actionMarkersText" label="动作描写标记（空格分隔）" placeholder="* （） ()" />
              </v-col>
            </v-row>
          </div>

          <v-divider />

          <div>
            <h3 class="text-title-medium font-weight-bold mb-3">上下文压缩、记忆权重与环境注入</h3>
            <v-row density="compact">
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.compressionTriggerRounds" label="摘要压缩触发轮数" type="number" min="6" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.compressionKeepRounds" label="压缩后保留最近轮数" type="number" min="2" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-select v-model="settingsForm.compressionModelId" label="摘要压缩模型" :items="languageModelItems" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.memorySummaryInterval" label="记忆提取间隔条数" type="number" min="1" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-select v-model="settingsForm.memorySummaryModelId" label="记忆整理模型" :items="languageModelItems" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.auditRetentionDays" label="审计日志保留天数" type="number" min="1" max="365" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.memoryRecallTopK" label="记忆召回 Top-K" type="number" min="1" max="20" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.memoryKeywordWeight" label="关键词权重 (0-1)" type="number" step="0.05" min="0" max="1" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.memoryDecayRate" label="自然衰减率 (0-0.5)" type="number" step="0.01" min="0" max="0.5" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model.number="settingsForm.memoryArchiveThreshold" label="低活跃归档阈值 (0-1)" type="number" step="0.05" min="0" max="1" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model="settingsForm.metadataTimezone" label="全局环境时区（留空跟随用户）" placeholder="例如 Asia/Shanghai" />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <v-text-field v-model="settingsForm.metadataCustom" label="附加环境补充说明" placeholder="例如：当前处于小马谷庆典周" />
              </v-col>
            </v-row>
          </div>

          <v-divider />

          <div>
            <h3 class="text-title-medium font-weight-bold mb-3">能力开关</h3>
            <v-row density="compact">
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.registrationOpen" label="开放新用户注册" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.streamingEnabled" label="启用流式响应 (SSE)" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.imageInputEnabled" label="允许上传图片识图" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.actionStyleEnabled" label="启用动作描写斜体样式" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.automaticMemoryEnabled" label="开启自动记忆提取" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.memoryStructuredExtraction" label="启用结构化记忆抽取" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.metadataEnabled" label="注入日历与节气元数据" />
                </v-sheet>
              </v-col>
              <v-col cols="12" sm="6" lg="4">
                <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4">
                  <v-switch v-model="settingsForm.auditCaptureContent" label="审计采集请求/响应全文" />
                </v-sheet>
              </v-col>
            </v-row>
          </div>

          <div class="d-flex justify-end">
            <v-btn color="primary" size="large" type="submit" prepend-icon="mdi-content-save-outline" :loading="settingsBusy">
              保存平台设置
            </v-btn>
          </div>
        </v-form>
      </v-card>

      <!-- 6. Embedding & Memory params -->
      <v-card v-else-if="activeTab === 'embedding'" border class="pa-5">
        <h3 class="text-title-medium font-weight-bold mb-4">向量嵌入（Embedding）与语义召回设置</h3>
        <v-form class="d-flex flex-column ga-4" @submit.prevent="saveEmbedding">
          <v-sheet color="surface-light" rounded="lg" class="pa-3 px-4 d-flex align-center justify-space-between ga-3">
            <div>
              <div class="text-body-large font-weight-medium">启用混合语义向量检索</div>
              <div class="text-body-small text-medium-emphasis">与 SQLite FTS5 trigram 协同工作，按模型指纹自动更新向量</div>
            </div>
            <v-switch v-model="embForm.enabled" hide-details />
          </v-sheet>

          <v-row density="compact">
            <v-col cols="12" md="6">
              <v-select v-model="embForm.modelId" label="选用向量模型" :items="embeddingModelItems" />
            </v-col>
            <v-col cols="12" sm="6" md="3">
              <v-text-field v-model.number="embForm.topK" label="向量召回 Top-K" type="number" min="1" max="20" />
            </v-col>
            <v-col cols="12" sm="6" md="3">
              <v-text-field v-model.number="embForm.minSimilarity" label="最低余弦相似度阈值" type="number" step="0.05" min="0" max="0.99" />
            </v-col>
          </v-row>

          <div class="d-flex justify-space-between align-center flex-wrap ga-3">
            <v-btn
              variant="tonal"
              color="primary"
              prepend-icon="mdi-pulse"
              :disabled="!embForm.modelId || embTesting"
              :loading="embTesting"
              @click="testEmbedding"
            >
              {{ embTesting ? '测试中...' : '测试向量连通性' }}
            </v-btn>
            <v-btn color="primary" type="submit" :loading="embBusy">保存向量配置</v-btn>
          </div>
        </v-form>
      </v-card>

      <!-- 7. Announcements -->
      <v-card v-else-if="activeTab === 'announcements'" border class="pa-5">
        <div class="d-flex align-center justify-space-between ga-3 flex-wrap mb-4">
          <h3 class="text-title-medium font-weight-bold">站内公告管理（{{ adminAnnouncements.length }}）</h3>
          <v-btn color="primary" size="small" prepend-icon="mdi-plus" @click="openCreateAnn">发布新公告</v-btn>
        </div>

        <div v-if="adminAnnouncements.length" class="d-flex flex-column ga-2">
          <v-sheet
            v-for="a in adminAnnouncements"
            :key="a.id"
            color="surface-light"
            rounded="lg"
            class="pa-3 px-4 d-flex align-center ga-3 flex-wrap"
          >
            <div class="flex-1-1" style="min-width:220px">
              <div class="d-flex align-center ga-2 flex-wrap">
                <strong class="text-body-large">{{ a.title }}</strong>
                <v-chip v-if="a.pinned" size="x-small" color="tertiary" variant="tonal">置顶</v-chip>
                <v-chip size="x-small" :color="a.published ? 'success' : 'default'" variant="tonal">
                  {{ a.published ? '已发布' : '草稿' }}
                </v-chip>
              </div>
              <div class="text-body-medium text-medium-emphasis mt-1">{{ a.content }}</div>
            </div>
            <div class="d-flex ga-2">
              <v-btn size="small" variant="outlined" icon="mdi-pencil-outline" aria-label="编辑公告" @click="openEditAnn(a)" />
              <v-btn size="small" variant="tonal" color="error" icon="mdi-delete-outline" aria-label="删除公告" @click="delAnn(a.id)" />
            </div>
          </v-sheet>
        </div>
        <div v-else class="text-body-medium text-medium-emphasis">暂无站内公告。</div>

        <v-dialog v-model="annOpen" max-width="580">
          <v-card class="pa-2">
            <v-card-title class="d-flex align-center justify-space-between">
              <span class="font-weight-bold">{{ editingAnnId ? '编辑公告' : '发布公告' }}</span>
              <v-btn icon="mdi-close" variant="text" size="small" @click="annOpen = false" />
            </v-card-title>
            <v-card-text>
              <v-form id="cp-ann-form" class="d-flex flex-column ga-4" @submit.prevent="saveAnn">
                <v-text-field v-model="annForm.title" label="标题" required />
                <v-textarea v-model="annForm.content" label="正文" rows="5" required />
                <div class="d-flex ga-6 flex-wrap">
                  <v-switch v-model="annForm.pinned" label="置顶" />
                  <v-switch v-model="annForm.published" label="立即发布" />
                </div>
              </v-form>
            </v-card-text>
            <v-card-actions class="px-6 pb-4">
              <v-spacer />
              <v-btn variant="text" @click="annOpen = false">取消</v-btn>
              <v-btn color="primary" type="submit" form="cp-ann-form" :loading="annBusy">保存公告</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
      </v-card>

      <!-- 8. Mail -->
      <AdminMailTab v-else-if="activeTab === 'mail' && settings" :settings="settings" @refresh="loadAll" />

      <!-- 9. Request Audit -->
      <AdminAuditTab v-else-if="activeTab === 'audit'" />
    </template>
  </div>
</template>
