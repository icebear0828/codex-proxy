import { ApiConfig } from "../components/ApiConfig";
import { AnthropicSetup } from "../components/AnthropicSetup";
import { CodeExamples } from "../components/CodeExamples";
import { TestConnection } from "../components/TestConnection";
import type { ModelFamily } from "../../../shared/hooks/use-status";

interface InfoPageProps {
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  modelFamilies: ModelFamily[];
  selectedEffort: string;
  onEffortChange: (effort: string) => void;
  selectedSpeed: string | null;
  onSpeedChange: (speed: string | null) => void;
}

export function InfoPage(props: InfoPageProps) {
  return (
    <div class="flex flex-col gap-6">
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
