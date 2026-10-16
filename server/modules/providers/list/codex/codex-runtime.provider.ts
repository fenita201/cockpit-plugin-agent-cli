import { randomUUID } from 'node:crypto';

import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live-client.js';
import { appendFilesInputTag, normalizeImageDescriptors, createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, ProviderPermissionDecision, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type ActiveCodexSession = {
  client: CodexLiveClient;
  threadId: string | null;
  turnId: string | null;
  aborted: boolean;
  finish(): void;
};
const activeCodexSessions = new Map<string, ActiveCodexSession>();
// Steering may arrive while the initial model lookup and handshake are still in flight.
const startingTurns = new Map<string, Promise<void>>();
const pendingApprovals = new Map<string, { sessionId: string; request: AnyRecord; async?: boolean; resolve(decision: ProviderPermissionDecision): void }>();

function readUsageNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event: AnyRecord) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event: AnyRecord): AnyRecord {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // `itemId` is the SDK's stable per-item id. Carrying it through means an
      // in-progress row and its later completion normalize to the same message
      // id, so the client updates one transcript entry instead of appending a
      // new one for every progress tick.
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            itemId: item.id,
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            itemId: item.id,
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            itemId: item.id,
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            itemId: item.id,
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            itemId: item.id,
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            itemId: item.id,
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            itemId: item.id,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

function buildInput(command: string, options: AnyRecord): AnyRecord[] {
  const images = normalizeImageDescriptors(options.images);
  const text = appendFilesInputTag(command, options.files).trim() || (images.length ? 'Please analyze the attached image(s).' : command);
  return [{ type: 'text', text, text_elements: [] }, ...images.map((image) => ({ type: 'localImage', path: image.path }))];
}

async function queryCodex(command: string, options: AnyRecord, ws: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
  const sessionId = options.sessionId || randomUUID();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  startingTurns.set(sessionId, ready);
  for (const pending of pendingApprovals.values()) {
    if (pending.sessionId === sessionId && pending.async) pending.resolve({ allow: false });
  }
  let state: ActiveCodexSession | undefined;
  let completed = false;
  let failure: Error | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const items = new Map<string, AnyRecord>();
  const seenQuestions = new Set<string>();
  const emit = (message: AnyRecord) => sendMessage(ws, message);
  const normalize = (raw: AnyRecord) => {
    for (const message of context.normalizeMessage(raw, state?.threadId || sessionId)) emit(message);
  };
  const publishItem = (item: AnyRecord) => {
    const types: Record<string, string> = { agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search' };
    if (item.type === 'userMessage') return;
    // Newer Codex versions expose nonblocking questions on assistant items.
    // Their answers are regular user input, rather than JSON-RPC replies.
    if (item.type === 'agentMessage' && item.questions?.length) {
      const requestId = `codex:async:${sessionId}:${item.id}`;
      if (!seenQuestions.has(requestId)) {
        seenQuestions.add(requestId);
        const request = { kind: 'permission_request' as const, requestId, sessionId, provider: 'codex' as const,
          toolName: 'AskUserQuestion', input: { asyncUserInput: true, questions: item.questions.map((q: AnyRecord) => ({
            question: q.title, header: '', multiSelect: false,
            options: (q.options || []).map((label: string) => ({ label, description: '' })),
          })) },
        };
        pendingApprovals.set(requestId, { sessionId, request, async: true, resolve() {
          pendingApprovals.delete(requestId);
          emit(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId, provider: 'codex' }));
        } });
        emit(createNormalizedMessage(request));
      }
    }
    const sdkItem = { ...item, type: types[item.type] || item.type,
      changes: item.type === 'fileChange' ? item.changes.map((change: AnyRecord) => ({ ...change, kind: typeof change.kind === 'object' ? change.kind.type : change.kind })) : item.changes,
      text: item.type === 'reasoning' ? (item.summary?.join('\n') || item.content?.join('\n') || '') : item.text,
      aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
      status: item.status === 'inProgress' ? 'in_progress' : item.status,
    };
    normalize(transformCodexEvent({ type: 'item.updated', item: sdkItem }));
  };
  try {
    const model = await context.resolveResumeModel(options.sessionId, options.model);
    const catalog = await context.getProviderModels();
    const efforts = catalog.OPTIONS.find((entry) => entry.value === model)?.effort?.values.map((entry) => entry.value) || [];
    const client = new CodexLiveClient((message) => {
      const params = message.params || {};
      // Ignore notifications from child agent threads; only the owning turn can end this run.
      if (message.id === undefined && params.threadId && state?.threadId && params.threadId !== state.threadId) return;
      if (message.id !== undefined) {
        const requestId = `codex:${randomUUID()}`;
        const isQuestion = message.method === 'item/tool/requestUserInput';
        const isCommand = message.method === 'item/commandExecution/requestApproval';
        const isFile = message.method === 'item/fileChange/requestApproval';
        if (!isQuestion && !isCommand && !isFile) {
          client.write({ id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } });
          return;
        }
        const questions = (params.questions || []).map((q: AnyRecord) => ({ ...q, multiSelect: false, options: q.options || [] }));
        const request = { kind: 'permission_request' as const, requestId, sessionId, provider: 'codex' as const,
          toolName: isQuestion ? 'AskUserQuestion' : isCommand ? 'Bash' : 'Edit',
          input: isQuestion ? { questions } : params,
        };
        pendingApprovals.set(requestId, { sessionId, request, resolve(decision) {
          let result: AnyRecord;
          if (isQuestion) {
            const input = decision.updatedInput as AnyRecord | undefined;
            result = { answers: Object.fromEntries(questions.map((q: AnyRecord) => {
              const answer = decision.allow ? input?.answers?.[q.question] : undefined;
              return [q.id, { answers: typeof answer === 'string' && answer ? [answer] : [] }];
            })) };
          } else result = { decision: decision.allow ? 'accept' : 'decline' };
          client.write({ id: message.id, result });
          pendingApprovals.delete(requestId);
          emit(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId, provider: 'codex' }));
        } });
        emit(createNormalizedMessage(request));
        return;
      }
      if (message.method === 'turn/started') {
        if (state) state.turnId = params.turn.id;
      } else if (message.method === 'item/started' || message.method === 'item/completed') {
        items.set(params.item.id, params.item);
        publishItem(params.item);
      } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/commandExecution/outputDelta') {
        const item = items.get(params.itemId) || { id: params.itemId, type: 'agentMessage', text: '' };
        if (message.method === 'item/agentMessage/delta') item.text = (item.text || '') + params.delta;
        else item.aggregatedOutput = (item.aggregatedOutput || '') + params.delta;
        items.set(item.id, item);
        publishItem(item);
      } else if (message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/reasoning/textDelta') {
        const item = items.get(params.itemId) || { id: params.itemId, type: 'reasoning', summary: [] };
        const field = message.method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'content';
        const index = params.summaryIndex ?? params.contentIndex ?? 0;
        item[field] ??= [];
        item[field][index] = (item[field][index] || '') + params.delta;
        items.set(item.id, item);
        publishItem(item);
      } else if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage?.total;
        if (usage) emit(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: extractCodexTokenBudget({ usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, model_context_window: params.tokenUsage.modelContextWindow } }), sessionId, provider: 'codex' }));
      } else if (message.method === 'turn/completed' && (!state?.turnId || params.turn.id === state.turnId)) {
        completed = true;
        if (params.turn.status === 'failed') failure = new Error(params.turn.error?.message || 'Codex turn failed');
        finish();
      } else if (message.method === 'error' && !params.willRetry) {
        failure = new Error(params.error?.message || 'Codex error');
        finish();
      }
    }, (error) => { if (!completed) failure = error; finish(); });
    state = { client, threadId: null, turnId: null, aborted: false, finish };
    activeCodexSessions.set(sessionId, state);
    await client.call('initialize', { clientInfo: { name: 'cloudcli', version: '1' }, capabilities: { experimentalApi: true } });
    client.write({ method: 'initialized', params: {} });
    const nativeId = context.resolveProviderSessionId(options.sessionId);
    const thread = await client.call(nativeId ? 'thread/resume' : 'thread/start', {
      ...(nativeId ? { threadId: nativeId } : {}), cwd: options.cwd || options.projectPath || process.cwd(),
      model, config: { 'features.default_mode_request_user_input': true },
      sandbox: options.permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: ['acceptEdits', 'bypassPermissions'].includes(options.permissionMode) ? 'never' : 'on-request',
    });
    state.threadId = thread.thread.id;
    ws.setSessionId?.(state.threadId!);
    if (!nativeId) emit(createNormalizedMessage({ kind: 'session_created', newSessionId: state.threadId, sessionId: state.threadId, provider: 'codex' }));
    if (!state.aborted) {
      const turn = await client.call('turn/start', { threadId: state.threadId, input: buildInput(command, options), ...(efforts.includes(options.effort) ? { effort: options.effort } : {}) });
      state.turnId = turn.turn.id;
      markReady();
      await done;
    }
    if (failure) throw failure;
  } catch (error) {
    if (!state?.aborted) {
      failure = error instanceof Error ? error : new Error(String(error));
      emit(createNormalizedMessage({ kind: 'error', content: failure.message, sessionId, provider: 'codex' }));
    }
  } finally {
    markReady();
    if (startingTurns.get(sessionId) === ready) startingTurns.delete(sessionId);
    // A turn completes on its terminal notification, independent of process/pipe lifetime.
    if (!state?.aborted) emit(createCompleteMessage({ provider: 'codex', sessionId, actualSessionId: state?.threadId || sessionId, exitCode: failure ? 1 : 0 }));
    for (const [id, pending] of pendingApprovals) {
      if (pending.sessionId !== sessionId || (pending.async && !state?.aborted && !failure)) continue;
      pendingApprovals.delete(id);
      emit(createNormalizedMessage({ kind: 'permission_cancelled', requestId: id, sessionId, provider: 'codex', reason: 'Turn ended' }));
    }
    state?.client.close();
    if (activeCodexSessions.get(sessionId) === state) activeCodexSessions.delete(sessionId);
  }
}

/** Used by CodexProvider and the runtime service for live turns, steering, cancellation and interactive answers. */
export const codexRuntime = {
  run: queryCodex,
  async steer(sessionId: string, command: string, options: AnyRecord = {}) {
    await startingTurns.get(sessionId);
    const state = activeCodexSessions.get(sessionId);
    if (!state?.threadId || !state.turnId || state.aborted) return false;
    await state.client.call('turn/steer', { threadId: state.threadId, expectedTurnId: state.turnId, input: buildInput(command, options) });
    return true;
  },
  abort(sessionId: string) {
    const state = activeCodexSessions.get(sessionId);
    if (!state) return false;
    state.aborted = true;
    state.client.close();
    state.finish();
    return true;
  },
  permissions: {
    resolve(requestId: string, decision: ProviderPermissionDecision) { pendingApprovals.get(requestId)?.resolve(decision); },
    listPending(sessionId: string) { return [...pendingApprovals.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => entry.request); },
  },
};

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isWebSocketWriter) {
      // The gateway writer handles stringification
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}
