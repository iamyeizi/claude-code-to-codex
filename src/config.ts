import path from "path";
import os from "os";
import fs from "fs/promises";

// Constants from OpenCode implementation
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ISSUER = "https://auth.openai.com";
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const OAUTH_PORT = 1455;

// Paths
export const CONFIG_DIR = path.join(os.homedir(), ".codex-proxy");
export const TOKEN_FILE = path.join(CONFIG_DIR, "tokens.json");

// Proxy settings
export const DEFAULT_PROXY_PORT = 8080;
export const ANTHROPIC_API_HOST = "api.anthropic.com";

// Model mapping
export const MODEL_MAPPING: Record<string, string> = {
  // Map Claude models to Codex models
  "claude-sonnet-4-5-20250929": "gpt-5.2-codex",
  "claude-opus-4-5-20250929": "gpt-5.2-codex",
  "claude-haiku-4-5-20250929": "gpt-5.1-codex-mini",
  // Default fallback
  "default": "gpt-5.2-codex",
};

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // timestamp in ms
}

export async function ensureConfigDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  } catch (err) {
    // Ignore if already exists
  }
}
