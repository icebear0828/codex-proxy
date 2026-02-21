import { useState, useMemo, useCallback } from "preact/hooks";
import { useT } from "../i18n/context";
import { CopyButton } from "./CopyButton";

type Protocol = "openai" | "anthropic" | "gemini";
type CodeLang = "python" | "node" | "curl";

const protocols: { id: Protocol; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
];

const langs: { id: CodeLang; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "node", label: "Node.js" },
  { id: "curl", label: "cURL" },
];

function buildExamples(
  baseUrl: string,
  apiKey: string,
  model: string,
  origin: string
): Record<string, string> {
  return {
    "openai-python": `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,

    "openai-curl": `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,

    "openai-node": `import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "${baseUrl}",
    apiKey: "${apiKey}",
});

const stream = await client.chat.completions.create({
    model: "${model}",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
});
for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`,

    "anthropic-python": `import anthropic

client = anthropic.Anthropic(
    base_url="${origin}/v1",
    api_key="${apiKey}",
)

message = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text)`,

    "anthropic-curl": `curl ${origin}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,

    "anthropic-node": `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
    baseURL: "${origin}/v1",
    apiKey: "${apiKey}",
});

const message = await client.messages.create({
    model: "${model}",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
});
console.log(message.content[0].text);`,

    "gemini-python": `from google import genai

client = genai.Client(
    api_key="${apiKey}",
    http_options={"base_url": "${origin}/v1beta"},
)

response = client.models.generate_content(
    model="${model}",
    contents="Hello",
)
print(response.text)`,

    "gemini-curl": `curl "${origin}/v1beta/models/${model}:generateContent?key=${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello"}]}]
  }'`,

    "gemini-node": `import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
    apiKey: "${apiKey}",
    httpOptions: { baseUrl: "${origin}/v1beta" },
});

const response = await ai.models.generateContent({
    model: "${model}",
    contents: "Hello",
});
console.log(response.text);`,
  };
}

interface CodeExamplesProps {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function CodeExamples({ baseUrl, apiKey, model }: CodeExamplesProps) {
  const t = useT();
  const [protocol, setProtocol] = useState<Protocol>("openai");
  const [codeLang, setCodeLang] = useState<CodeLang>("python");

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const examples = useMemo(
    () => buildExamples(baseUrl, apiKey, model, origin),
    [baseUrl, apiKey, model, origin]
  );

  const currentCode = examples[`${protocol}-${codeLang}`] || "Loading...";
  const getCode = useCallback(() => currentCode, [currentCode]);

  const protoActive =
    "px-6 py-3 text-[0.82rem] font-semibold text-primary border-b-2 border-primary bg-white dark:bg-card-dark transition-colors";
  const protoInactive =
    "px-6 py-3 text-[0.82rem] font-medium text-slate-500 dark:text-text-dim hover:text-slate-700 dark:hover:text-text-main hover:bg-slate-50 dark:hover:bg-[#21262d] border-b-2 border-transparent transition-colors";
  const langActive =
    "px-3 py-1.5 text-xs font-semibold rounded bg-white dark:bg-[#21262d] text-slate-800 dark:text-text-main shadow-sm border border-transparent dark:border-border-dark transition-all";
  const langInactive =
    "px-3 py-1.5 text-xs font-medium rounded text-slate-500 dark:text-text-dim hover:text-slate-700 dark:hover:text-text-main hover:bg-white/50 dark:hover:bg-[#21262d] border border-transparent transition-all";

  return (
    <section class="flex flex-col gap-4">
      <h2 class="text-[0.95rem] font-bold">{t("integrationExamples")}</h2>
      <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl overflow-hidden shadow-sm transition-colors">
        {/* Protocol Tabs */}
        <div class="flex border-b border-gray-200 dark:border-border-dark bg-slate-50/50 dark:bg-bg-dark/30">
          {protocols.map((p) => (
            <button
              key={p.id}
              onClick={() => setProtocol(p.id)}
              class={protocol === p.id ? protoActive : protoInactive}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* Language Tabs & Code */}
        <div class="p-5">
          <div class="flex items-center justify-between mb-4">
            <div class="flex gap-2 p-1 bg-slate-100 dark:bg-bg-dark dark:border dark:border-border-dark rounded-lg">
              {langs.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setCodeLang(l.id)}
                  class={codeLang === l.id ? langActive : langInactive}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          {/* Code Block */}
          <div class="relative group rounded-lg overflow-hidden bg-[#0d1117] text-slate-300 font-mono text-xs border border-slate-800 dark:border-border-dark">
            <div class="absolute right-2 top-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
              <CopyButton getText={getCode} variant="label" />
            </div>
            <div class="p-4 overflow-x-auto">
              <pre class="m-0"><code>{currentCode}</code></pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
