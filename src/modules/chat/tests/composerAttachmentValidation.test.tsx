import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

const dropzone = vi.hoisted(() => ({ onDrop: null as null | ((accepted: File[], rejected: { file: File }[]) => void) }));
vi.mock('react-dropzone', () => ({
  useDropzone: (options: { onDrop: typeof dropzone.onDrop }) => {
    dropzone.onDrop = options.onDrop;
    return { getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false, open: vi.fn() };
  },
}));

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

// The composer only ever reaches the network through these; stubbing them keeps
// the test about draft scoping rather than about fetch behaviour in jsdom.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      getFiles: () => okJson([]),
      providers: { skills: () => okJson({ data: { skills: [] } }) },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const renderComposer = (selectedSession: ProjectSession | null) => renderHook(
  ({ session }: { session: ProjectSession | null }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
  { initialProps: { session: selectedSession } },
);

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's drafts into the next.
  resetChatDrafts();
});


function sizedFile(name: string, megabytes: number): File {
  const file = new File(['data'], name);
  Object.defineProperty(file, 'size', { value: megabytes * 1024 * 1024 });
  return file;
}

test('dropzone rejected files produce errors, while an 11 MB Vietnamese file is accepted', () => {
  const view = renderComposer(null);
  act(() => dropzone.onDrop!([sizedFile('tài liệu.txt', 11)], [{ file: sizedFile('quá lớn.zip', 51) }]));
  expect(view.result.current.attachedFiles.map((file) => file.name)).toEqual(['tài liệu.txt']);
  expect(view.result.current.fileErrors.get('quá lớn.zip')).toContain('50 MB');
});

test('total limit includes files already selected and permits exactly 100 MB', () => {
  const view = renderComposer(null);
  act(() => dropzone.onDrop!([sizedFile('first', 50)], []));
  act(() => dropzone.onDrop!([sizedFile('second', 50), sizedFile('third', 1)], []));
  expect(view.result.current.attachedFiles).toHaveLength(2);
  expect(view.result.current.fileErrors.get('third')).toContain('100 MB');
});

test('excess files are reported instead of silently truncated', () => {
  const view = renderComposer(null);
  act(() => dropzone.onDrop!([], Array.from({ length: 11 }, (_, index) => ({ file: sizedFile(`file-${index}`, 1) }))));
  expect(view.result.current.attachedFiles).toHaveLength(10);
  expect(view.result.current.fileErrors.get('file-10')).toContain('10 attachments');
});
