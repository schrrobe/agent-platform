<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { useWsStore } from '@/stores/ws';
import { useProjectsStore } from '@/stores/projects';
import { useJobsStore } from '@/stores/jobs';

const ws = useWsStore();
const projects = useProjectsStore();
const jobs = useJobsStore();

onMounted(() => {
  void projects.load();
  void jobs.load();
  ws.connect();
});
onUnmounted(() => ws.disconnect());
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">Agent-Orchestrierung</div>
      <nav>
        <RouterLink to="/">Board</RouterLink>
        <RouterLink to="/projects">Projekte</RouterLink>
        <RouterLink to="/stats">Statistik</RouterLink>
        <RouterLink to="/logs">Logs</RouterLink>
        <RouterLink to="/settings">Einstellungen</RouterLink>
      </nav>
      <div class="ws-status" :class="ws.status" :title="`WebSocket: ${ws.status}`">
        <span class="dot" /> {{ ws.status === 'open' ? 'live' : ws.status }}
      </div>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 18px;
  height: 52px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.brand {
  font-weight: 600;
}
nav {
  display: flex;
  gap: 16px;
  flex: 1;
}
nav a {
  color: var(--text-dim);
  padding: 4px 2px;
  border-bottom: 2px solid transparent;
}
nav a.router-link-active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.ws-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-dim);
  text-transform: capitalize;
}
.ws-status .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--c-fail);
}
.ws-status.open .dot {
  background: var(--c-done);
}
.ws-status.connecting .dot {
  background: var(--c-active);
}
.content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
