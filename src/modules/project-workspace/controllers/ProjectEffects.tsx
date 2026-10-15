import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';

/** Headless controller rendered by ProjectWorkspaceShell to register the command palette's project operations. */
export default function ProjectEffects() {
  const {
    openSettings,
    refreshProjectsSilently,
  } = useProjectEffectsState();

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  return null;
}
