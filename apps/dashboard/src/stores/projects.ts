import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Project, ProjectCreateInput, ProjectUpdateInput } from '@agent/shared';
import { api } from '@/api/client';

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      projects.value = await api.listProjects();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function create(input: ProjectCreateInput): Promise<void> {
    const project = await api.createProject(input);
    projects.value = [...projects.value, project];
  }

  async function update(id: string, input: ProjectUpdateInput): Promise<void> {
    const updated = await api.updateProject(id, input);
    projects.value = projects.value.map((p) => (p.id === id ? updated : p));
  }

  async function remove(id: string): Promise<void> {
    await api.deleteProject(id);
    projects.value = projects.value.filter((p) => p.id !== id);
  }

  return { projects, loading, error, load, create, update, remove };
});
