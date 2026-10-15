// Live model catalogs for the Cockpit build (see cockpit/NOTES.md "Model catalogs").
//
// Upstream ships hand-written model lists that go stale between releases and do not reflect what the signed-in account
// can use (a ChatGPT login rejects API-only Codex models, for example). In the Cockpit backend the catalogs are asked
// from the CLIs themselves, cached, and the curated lists are only a fallback.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderModelOption, ProviderModelsDefinition } from '../../server/shared/types.js';

const CACHE_TTL_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 20_000;

/** Live lookups run only in the Cockpit backend (and can be turned off), so upstream tests keep the static catalogs. */
export function liveCatalogsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AGENT_UI_SOCKET) && env.AGENT_UI_LIVE_MODELS !== '0';
}

type CacheEntry = { at: number; key: string; value: ProviderModelsDefinition };

/**
 * Caches one live catalog. `key()` (e.g. the auth file's mtime) invalidates it early when the account changes;
 * concurrent callers share one lookup; any failure falls back to the curated list and is retried after a short delay.
 */
function createCachedCatalog(
  name: string,
  key: () => Promise<string>,
  load: (fallback: ProviderModelsDefinition) => Promise<ProviderModelsDefinition | null>,
) {
  let cache: CacheEntry | null = null;
  let inFlight: Promise<ProviderModelsDefinition | null> | null = null;

  return async (fallback: ProviderModelsDefinition): Promise<ProviderModelsDefinition> => {
    if (!liveCatalogsEnabled()) return fallback;
    const now = Date.now();
    const currentKey = await key().catch(() => 'unknown');
    if (cache && cache.key === currentKey && now - cache.at < CACHE_TTL_MS) return cache.value;

    inFlight ??= withTimeout(load(fallback), LOOKUP_TIMEOUT_MS)
      .catch((error: unknown) => {
        console.warn(`[Cockpit] live ${name} model list unavailable, using the built-in list:`, error instanceof Error ? error.message : error);
        return null;
      })
      .finally(() => { inFlight = null; });
    const live = await inFlight;
    if (live && live.OPTIONS.length > 0) {
      cache = { at: now, key: currentKey, value: live };
      return live;
    }
    // Remember the failure briefly so a broken CLI is not respawned on every request.
    cache = { at: now - CACHE_TTL_MS + 60_000, key: currentKey, value: fallback };
    return fallback;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function fileKey(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

//----------------- CLAUDE ------------------

/** Claude Code aliases that `supportedModels()` does not list but the CLI accepts; kept from the curated catalog. */
const CLAUDE_EXTRA_ALIASES = new Set(['opusplan']);

/** Maps the SDK's model rows onto the app's catalog shape. Exported for tests. */
export function toClaudeCatalog(
  models: ModelInfo[],
  fallback: ProviderModelsDefinition,
  ultracodeOption: { value: string; description?: string },
): ProviderModelsDefinition {
  const options: ProviderModelOption[] = models.map((model) => {
    const levels = model.supportedEffortLevels ?? [];
    const option: ProviderModelOption = {
      value: model.value,
      label: model.displayName || model.value,
      description: model.description,
    };
    if (levels.length > 0) {
      option.effort = {
        default: levels.includes('high') ? 'high' : levels[levels.length - 1],
        values: [
          ...levels.map((value) => ({ value })),
          // Ultracode is offered on xhigh-capable models only, as in the curated catalog.
          ...(levels.includes('xhigh') ? [ultracodeOption] : []),
        ],
      };
    }
    return option;
  });
  for (const extra of fallback.OPTIONS) {
    if (CLAUDE_EXTRA_ALIASES.has(extra.value) && !options.some((option) => option.value === extra.value)) {
      options.push(extra);
    }
  }
  const defaultValue = options.some((option) => option.value === 'default') ? 'default' : options[0]?.value ?? fallback.DEFAULT;
  return { OPTIONS: options, DEFAULT: defaultValue };
}

async function* idlePrompt(): AsyncGenerator<never> {
  // Never yields: the CLI starts and answers control requests, but no user turn (and no transcript) is ever created.
  await new Promise(() => {});
}

/** The picker's ultracode effort row; set by the Claude adapter (it owns that constant). */
let claudeUltracode: { value: string; description?: string } = { value: 'ultracode' };

const claudeCatalog = createCachedCatalog(
  'Claude',
  async () => `${await fileKey(path.join(os.homedir(), '.claude', '.credentials.json'))}|${await fileKey(path.join(os.homedir(), '.claude.json'))}`,
  async (fallback) => {
    const instance = query({ prompt: idlePrompt(), options: { cwd: os.homedir(), persistSession: false } });
    try {
      return toClaudeCatalog(await instance.supportedModels(), fallback, claudeUltracode);
    } finally {
      instance.close();
    }
  },
);

/**
 * Claude models the signed-in account can use, as reported by the bundled Claude Code (aliases such as `opus` resolve
 * to the newest model of that family). Called by the Claude provider's model adapter.
 */
export async function liveClaudeCatalog(
  fallback: ProviderModelsDefinition,
  ultracodeOption: { value: string; description?: string },
): Promise<ProviderModelsDefinition> {
  claudeUltracode = ultracodeOption;
  return claudeCatalog(fallback);
}

//----------------- CODEX ------------------

type CodexModelRow = {
  model?: string;
  id?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[];
};

/** Maps `codex app-server` `model/list` rows onto the app's catalog shape. Exported for tests. */
export function toCodexCatalog(rows: CodexModelRow[], fallback: ProviderModelsDefinition): ProviderModelsDefinition | null {
  const visible = rows.filter((row) => !row.hidden && (row.model || row.id));
  if (visible.length === 0) return null;
  const options: ProviderModelOption[] = visible.map((row) => {
    const value = (row.model || row.id) as string;
    const efforts = (row.supportedReasoningEfforts ?? [])
      .map((effort) => effort.reasoningEffort)
      .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0);
    return {
      value,
      label: row.displayName || value,
      description: row.description,
      ...(efforts.length > 0
        ? { effort: { default: row.defaultReasoningEffort && efforts.includes(row.defaultReasoningEffort) ? row.defaultReasoningEffort : efforts[0], values: efforts.map((effort) => ({ value: effort })) } }
        : {}),
    };
  });
  const defaultRow = visible.find((row) => row.isDefault);
  return { OPTIONS: options, DEFAULT: defaultRow ? (defaultRow.model || defaultRow.id) as string : options[0]?.value ?? fallback.DEFAULT };
}

/** Asks the Codex CLI shipped in node_modules (the version the SDK drives) for the account's models. */
async function codexModelList(): Promise<CodexModelRow[]> {
  const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  const child = spawn(process.execPath, [launcher, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.homedir() });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (message: { result?: unknown; error?: { message?: string } }) => void>();
  let nextId = 0;
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    } catch {
      // not JSON-RPC (log noise)
    }
  });
  const exited = new Promise<never>((_, reject) => child.once('exit', (code) => reject(new Error(`codex app-server exited (${code})`))));
  exited.catch(() => undefined);
  const call = (method: string, params: unknown) => Promise.race([
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => {
        pending.delete(id);
        if (message.error) reject(new Error(message.error.message || `${method} failed`));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }),
    exited,
  ]);
  try {
    await call('initialize', { clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const rows: CodexModelRow[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await call('model/list', cursor ? { cursor } : {}) as { data?: CodexModelRow[]; nextCursor?: string | null };
      rows.push(...(page?.data ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return rows;
  } finally {
    lines.close();
    child.kill();
  }
}

/** Codex models the signed-in account can use (`codex app-server` `model/list`). Called by the Codex provider's model adapter. */
export const liveCodexCatalog = createCachedCatalog(
  'Codex',
  () => fileKey(path.join(os.homedir(), '.codex', 'auth.json')),
  async (fallback) => toCodexCatalog(await codexModelList(), fallback),
);
