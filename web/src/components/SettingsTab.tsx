import { GeneralSettings } from "./GeneralSettings";
import { LogsSettings } from "./LogsSettings";
import { ModelAliasSettings } from "./ModelAliasSettings";
import { OllamaBridgeSettings } from "./OllamaBridgeSettings";
import { QuotaSettings } from "./QuotaSettings";
import { RotationSettings } from "./RotationSettings";
import { SettingsPanel } from "./SettingsPanel";
import type { LayoutMode } from "../lib/layout-preferences";

interface SettingsTabProps {
  models: string[];
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
}

export function SettingsTab(props: SettingsTabProps) {
  return (
    <div class="flex flex-col gap-6">
      <SettingsPanel />
      <GeneralSettings layoutMode={props.layoutMode} onLayoutModeChange={props.onLayoutModeChange} />
      <ModelAliasSettings models={props.models} />
      <QuotaSettings />
      <RotationSettings />
      <LogsSettings />
      <OllamaBridgeSettings />
    </div>
  );
}
