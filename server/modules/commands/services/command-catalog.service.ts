import path from 'node:path';

import { parseFrontMatter } from '@/shared/index.js';
import type { LLMProvider } from '@/shared/index.js';

type BuiltInCommand = { name: string; description: string; namespace: string; metadata: Record<string, unknown>; path?: string; relativePath?: string };

/** Keeps menu labels and help text consistent for the selected provider. */
function getBuiltInCommands(provider: LLMProvider): BuiltInCommand[] {
  return [
    { name: '/help', description: `Show help documentation for ${provider === 'codex' ? 'Codex' : 'Claude Code'}` },
    { name: '/models', description: 'View available models for the current provider' },
    { name: '/cost', description: 'Display token usage information' },
    { name: '/memory', description: `Open ${provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'} project instructions for editing` },
    { name: '/config', description: 'Open settings and configuration' },
    { name: '/status', description: 'Show system status and version information' },
  ].map((command) => ({ ...command, namespace: 'builtin', metadata: { type: 'builtin' } }));
}

/** Used by Commands routes to render help without describing another provider's files. */
export function getCommandHelp(provider: LLMProvider) {
  const commands = getBuiltInCommands(provider);
  const custom = provider === 'codex'
    ? '## Codex skills and project instructions\n\nProvider skills appear in the command menu. Project instructions are read from `AGENTS.md`. Permission modes are selected in the composer; save defaults per project or for all projects.'
    : '## Custom Commands\n\nProject: `.claude/commands/`\n\nUser: `~/.claude/commands/`\n\nUse `$ARGUMENTS` or `$1`, `$2` for arguments, `@filename` for file includes and `!command` for shell commands.';
  return {
    type: 'builtin', action: 'help', data: {
      content: `# ${provider === 'codex' ? 'Codex' : 'Claude Code'} Commands\n\n## Built-in Commands\n\n${commands.map((command) => `### ${command.name}\n${command.description}`).join('\n\n')}\n\n${custom}`,
      format: 'markdown', commands,
    },
  };
}

async function scanCommandsDirectory(directory: string, base: string, namespace: string, fs: typeof import('node:fs/promises')): Promise<BuiltInCommand[]> {
  const commands: BuiltInCommand[] = [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) commands.push(...await scanCommandsDirectory(fullPath, base, namespace, fs));
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const parsed = parseFrontMatter(await fs.readFile(fullPath, 'utf8'));
          const relativePath = path.relative(base, fullPath);
          const description = typeof parsed.data.description === 'string' && parsed.data.description
            ? parsed.data.description : parsed.content.trim().split('\n')[0].replace(/^#+\s*/, '').trim();
          commands.push({ name: '/' + relativePath.replace(/\.md$/, '').replace(/\\/g, '/'), description, namespace,
            metadata: parsed.data, path: fullPath, relativePath });
        } catch (error) { console.error(`Error parsing command file ${fullPath}:`, error); }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EACCES') console.error(`Error scanning directory ${directory}:`, error);
  }
  return commands;
}

/** Used by Commands routes to list built-ins and Claude custom commands; Codex skills are loaded by the provider API. */
export async function listCommands(provider: LLMProvider, projectPath: string | undefined, homeDirectory: string,
  fileSystem: typeof import('node:fs/promises')) {
  const builtIn = getBuiltInCommands(provider);
  const custom: BuiltInCommand[] = [];
  if (provider === 'claude') {
    const directories = [
      ...(projectPath ? [{ directory: path.join(projectPath, '.claude', 'commands'), scope: 'project' }] : []),
      { directory: path.join(homeDirectory, '.claude', 'commands'), scope: 'user' },
    ];
    for (const { directory, scope } of directories) custom.push(...await scanCommandsDirectory(directory, directory, scope, fileSystem));
  }
  custom.sort((left, right) => left.name.localeCompare(right.name));
  return { builtIn, custom, count: builtIn.length + custom.length };
}

/** Used by Commands routes to locate the active provider's instructions in the selected project. */
export async function getProjectMemory(provider: LLMProvider, projectPath: string | undefined, access: (file: string) => Promise<unknown>) {
  const filename = provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  if (!projectPath) return { type: 'builtin', action: 'memory', data: { error: 'No project selected', message: `Please select a project to access ${filename}` } };
  const filePath = path.join(projectPath, filename);
  let exists = false;
  try { await access(filePath); exists = true; } catch { /* A missing instructions file can be created in the editor. */ }
  return { type: 'builtin', action: 'memory', data: { path: filePath, exists,
    message: exists ? `Opening ${filename} at ${filePath}` : `${filename} not found at ${filePath}. Create it to store project-specific instructions.` } };
}
