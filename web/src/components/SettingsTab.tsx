import { GeneralSettings } from "./GeneralSettings";
import { QuotaSettings } from "./QuotaSettings";
import { RotationSettings } from "./RotationSettings";
import { SettingsPanel } from "./SettingsPanel";
import { ApiConfig } from "./ApiConfig";
import { AnthropicSetup } from "./AnthropicSetup";
import { CodeExamples } from "./CodeExamples";
import { TestConnection } from "./TestConnection";

interface SettingsTabProps {
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  modelFamilies: Record<string, string[]>;
  selectedEffort: string;
  onEffortChange: (effort: string) => void;
  selectedSpeed: string;
  onSpeedChange: (speed: string) => void;
}

export function SettingsTab(props: SettingsTabProps) {
  return (
    <div class="flex flex-col gap-6">
      <GeneralSettings />
      <QuotaSettings />
      <RotationSettings />
      <SettingsPanel />
      <ApiConfig
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        models={props.models}
        selectedModel={props.selectedModel}
        onModelChange={props.onModelChange}
        modelFamilies={props.modelFamilies}
        selectedEffort={props.selectedEffort}
        onEffortChange={props.onEffortChange}
        selectedSpeed={props.selectedSpeed}
        onSpeedChange={props.onSpeedChange}
      />
      <AnthropicSetup
        apiKey={props.apiKey}
        selectedModel={props.selectedModel}
        reasoningEffort={props.selectedEffort}
        serviceTier={props.selectedSpeed}
      />
      <CodeExamples
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        model={props.selectedModel}
        reasoningEffort={props.selectedEffort}
        serviceTier={props.selectedSpeed}
      />
      <TestConnection />
    </div>
  );
}
