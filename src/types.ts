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
  /** stderr exceeded the cap and was truncated (memory safety). */
  stderrTruncated?: boolean;
  /** messages array exceeded the cap; oldest entries were dropped. */
  messagesTruncated?: boolean;
  /** final assistant output exceeded Pi's tool-result display cap. */
  outputTruncated?: boolean;
  /** Path to a file containing full final output. */
  fullOutputPath?: string;
  liveLog?: string;
}

export interface AutocompleteItem {
  value: string;
  label: string;
}

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
  outputTruncated?: boolean;
  messagesTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Path to a file containing the full, untruncated output. */
  fullOutputPath?: string;
}
