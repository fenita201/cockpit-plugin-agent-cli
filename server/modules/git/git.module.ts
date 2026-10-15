import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCodex'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
    resolveDefaultModel: async (provider) => (await providerModelsService.getProviderModels(provider)).DEFAULT,
    ...externalDependencies,
  });
}
