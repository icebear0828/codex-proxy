export interface ExtractedFingerprint {
  app_version: string;
  build_number: string;
  electron_version: string | null;
  chromium_version: string | null;
  api_base_url: string | null;
  originator: string | null;
  models: string[];
  wham_endpoints: string[];
  user_agent_contains: string;
  sparkle_feed_url: string | null;
  prompts: {
    desktop_context_hash: string | null;
    desktop_context_path: string | null;
    title_generation_hash: string | null;
    title_generation_path: string | null;
    pr_generation_hash: string | null;
    pr_generation_path: string | null;
    automation_response_hash: string | null;
    automation_response_path: string | null;
  };
  extracted_at: string;
  source_path: string;
}
