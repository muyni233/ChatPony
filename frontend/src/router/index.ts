import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
    },
    {
      path: '/characters',
      name: 'characters',
      component: () => import('../views/CharactersView.vue'),
    },
    {
      path: '/conversations',
      name: 'conversations',
      component: () => import('../views/ConversationsView.vue'),
    },
    {
      path: '/chat/:id',
      name: 'chat',
      component: () => import('../views/ChatView.vue'),
    },
    {
      path: '/my-characters',
      name: 'my-characters',
      component: () => import('../views/MyCharactersView.vue'),
    },
    {
      path: '/memories',
      name: 'memories',
      component: () => import('../views/MemoriesView.vue'),
    },
    {
      path: '/persona',
      name: 'persona',
      component: () => import('../views/PersonaView.vue'),
    },
    {
      path: '/announcements',
      name: 'announcements',
      component: () => import('../views/AnnouncementsView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../views/AdminView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

export default router;
