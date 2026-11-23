import { ClaudeAssistant } from "./claude.ts";
import { RulesAssistant } from "./fallback.ts";
import type { Assistant } from "./types.ts";

let current: Assistant | null = null;

function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

export function assistant(): Assistant {
  if (!current) {
    const mode = process.env.AI_MODE;
    // AI_MODE=claude forces Claude (e.g. credentials from `ant auth login`, which has no env var).
    current = mode === "claude" || (mode !== "off" && claudeConfigured()) ? new ClaudeAssistant() : new RulesAssistant();
  }
  return current;
}

/** Tests swap in a deterministic assistant. */
export function setAssistant(a: Assistant | null): void {
  current = a;
}
