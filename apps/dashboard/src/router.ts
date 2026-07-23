import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'board', component: () => import('@/views/BoardView.vue') },
  {
    path: '/jobs/:id',
    name: 'job-detail',
    component: () => import('@/views/TicketDetailView.vue'),
    props: true,
  },
  { path: '/projects', name: 'projects', component: () => import('@/views/ProjectsView.vue') },
  { path: '/stats', name: 'stats', component: () => import('@/views/StatsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  {
    path: '/maintenance',
    name: 'maintenance',
    component: () => import('@/views/MaintenanceView.vue'),
  },
  { path: '/logs', name: 'logs', component: () => import('@/views/LogsView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
