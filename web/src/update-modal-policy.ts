import type { UpdateStatus } from "../../shared/hooks/use-update-status";

interface UpdateModalAutoOpenInput {
  hasUpdate: boolean;
  previousHasUpdate: boolean;
  mode: UpdateStatus["proxy"]["mode"] | null;
  showUpdateDialog: boolean;
}

interface UpdateDialogPreferenceStatus {
  settings?: {
    show_update_dialog?: boolean;
  } | null;
}

export function getShowUpdateDialogPreference(status: UpdateDialogPreferenceStatus | null | undefined): boolean {
  return status?.settings?.show_update_dialog ?? false;
}

export function shouldAutoOpenUpdateModal({
  hasUpdate,
  previousHasUpdate,
  mode,
  showUpdateDialog,
}: UpdateModalAutoOpenInput): boolean {
  return showUpdateDialog && hasUpdate && !previousHasUpdate && mode !== "electron";
}
