import type { UpdateStatus } from "../../shared/hooks/use-update-status";

interface UpdateModalAutoOpenInput {
  hasUpdate: boolean;
  previousHasUpdate: boolean;
  mode: UpdateStatus["proxy"]["mode"] | null;
  showUpdateDialog: boolean;
}

export function shouldAutoOpenUpdateModal({
  hasUpdate,
  previousHasUpdate,
  mode,
  showUpdateDialog,
}: UpdateModalAutoOpenInput): boolean {
  return showUpdateDialog && hasUpdate && !previousHasUpdate && mode !== "electron";
}
