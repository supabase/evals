import type { ProjectInstance } from './project/ProjectInstance.js';

export type ProjectStore = Map<string, ProjectInstance>;

export function createProjectStore(): ProjectStore {
  return new Map();
}
