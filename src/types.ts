import type { Message } from "@earendil-works/pi-ai";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface DelegateResult {
  agent: string;
  model: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
  liveLog?: string;
}

export interface AutocompleteItem {
  value: string;
  label: string;
}

/** Lightweight details attached to the delegate tool result. */
export interface DelegateToolDetails {
  agent: string;
  model: string;
  task: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  usage: UsageStats;
  threadId: string | null;
  sessionId: string | null;
}
