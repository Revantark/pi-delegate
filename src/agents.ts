import { modifyFile, loadFromFile, saveAtomically } from "./store.js";
import { AGENTS_PATH, THREADS_PATH, PI_HOME } from "./paths.js";

export interface AgentConfig {
  name: string;
  model: string;
  tools?: string[];
  description?: string;
  extensions?: string[];
  noAutoExtensions?: boolean;
  session?: boolean;
  /** Maximum child runtime in milliseconds. Omit for no deadline. */
  timeoutMs?: number;
  /**
   * How to assign a thread id when the caller omits `threadId`.
   * - `"unique"` (default): each delegate call without an explicit threadId
   *   gets its own fresh session thread, so calls run in parallel.
   * - `"shared"`: legacy behavior; calls without threadId share one
   *   per-agent thread and are serialized.
   */
  defaultThread?: "unique" | "shared";
}

const CONFIG_PATH = AGENTS_PATH;
/** Trusted root for state files; passed to the store so paths that escape it are rejected (issue 20, bug D). */
const STATE_ROOT = PI_HOME;

// ============================================================
// Agent registry
// ============================================================

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isValidAgentConfig(value: unknown): value is AgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as Record<string, unknown>;
  return (
    typeof agent.name === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(agent.name) &&
    typeof agent.model === "string" &&
    agent.model.trim().length > 0 &&
    (agent.tools === undefined || isStringArray(agent.tools)) &&
    (agent.description === undefined || typeof agent.description === "string") &&
    (agent.extensions === undefined || isStringArray(agent.extensions)) &&
    (agent.noAutoExtensions === undefined || typeof agent.noAutoExtensions === "boolean") &&
    (agent.session === undefined || typeof agent.session === "boolean") &&
    (agent.timeoutMs === undefined ||
      (typeof agent.timeoutMs === "number" &&
        Number.isInteger(agent.timeoutMs) && agent.timeoutMs > 0)) &&
    (agent.defaultThread === undefined ||
      agent.defaultThread === "unique" ||
      agent.defaultThread === "shared")
  );
}

function validateAgentRegistry(value: unknown): Record<string, AgentConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid delegate agent registry in ${CONFIG_PATH}`);
  }
  const registry = value as Record<string, unknown>;
  for (const [name, agent] of Object.entries(registry)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !isValidAgentConfig(agent)) {
      throw new Error(`Invalid delegate agent entry "${name}" in ${CONFIG_PATH}`);
    }
    if ((agent as AgentConfig).name !== name) {
      throw new Error(`Agent registry key/name mismatch for "${name}" in ${CONFIG_PATH}`);
    }
  }
  return registry as Record<string, AgentConfig>;
}

function _loadAgents(): Record<string, AgentConfig> {
  const data = loadFromFile<unknown>(CONFIG_PATH);
  return data === undefined ? {} : validateAgentRegistry(data);
}

export function loadAgents(): Record<string, AgentConfig> {
  return _loadAgents();
}

export async function addAgent(
  name: string,
  model: string,
  tools?: string[],
  description?: string,
  extensions?: string[],
  noAutoExtensions?: boolean,
  session?: boolean,
  timeoutMs?: number,
  defaultThread?: "unique" | "shared",
): Promise<AgentConfig> {
  const result = await modifyFile<Record<string, AgentConfig>>(CONFIG_PATH, (agents) => {
    const agent: AgentConfig = { name, model };
    if (tools !== undefined) agent.tools = tools;
    if (description !== undefined) agent.description = description;
    if (extensions !== undefined) agent.extensions = extensions;
    if (noAutoExtensions !== undefined) agent.noAutoExtensions = noAutoExtensions;
    if (session !== undefined) agent.session = session;
    if (timeoutMs !== undefined) agent.timeoutMs = timeoutMs;
    if (defaultThread !== undefined) agent.defaultThread = defaultThread;
    if (!isValidAgentConfig(agent)) throw new Error(`Invalid agent configuration for "${name}"`);
    validateAgentRegistry(agents);
    agents[name] = agent;
    return agents;
  }, STATE_ROOT);
  return result[name];
}

export async function removeAgent(name: string): Promise<boolean> {
  const agents = _loadAgents();
  if (!Object.hasOwn(agents, name)) return false;
  await modifyFile<Record<string, AgentConfig>>(CONFIG_PATH, (a) => {
    validateAgentRegistry(a);
    delete a[name];
    return a;
  }, STATE_ROOT);
  return true;
}

/**
 * Pure merge of an agent config with a patch. Unspecified fields are preserved.
 * `name` cannot be changed via patch.
 */
export function mergeAgentConfig(
  base: AgentConfig,
  patch: Partial<Omit<AgentConfig, "name">>,
): AgentConfig {
  return { ...base, ...patch, name: base.name };
}

/**
 * Patch an existing agent, preserving every field not included in `patch`.
 * Unlike rebuilding the config with positional arguments, this never drops
 * fields such as `session`, `tools`, `description`, or `model`.
 */
export async function updateAgent(
  name: string,
  patch: Partial<Omit<AgentConfig, "name">>,
): Promise<AgentConfig> {
  const result = await modifyFile<Record<string, AgentConfig>>(
    CONFIG_PATH,
    (agents) => {
      const existing = agents[name];
      if (!existing || !Object.hasOwn(agents, name)) {
        throw new Error(`Agent not found: ${name}`);
      }
      agents[name] = mergeAgentConfig(existing, patch);
      validateAgentRegistry(agents);
      return agents;
    },
  STATE_ROOT);
  return result[name];
}

export async function renameAgent(
  oldName: string,
  agent: AgentConfig,
): Promise<void> {
  if (!isValidAgentConfig(agent)) {
    throw new Error("Invalid agent configuration");
  }
  await modifyFile<Record<string, AgentConfig>>(
    CONFIG_PATH,
    (agents) => {
      if (!Object.hasOwn(agents, oldName)) {
        throw new Error(`Agent not found: ${oldName}`);
      }
      if (oldName !== agent.name && Object.hasOwn(agents, agent.name)) {
        throw new Error(`Agent already exists: ${agent.name}`);
      }
      delete agents[oldName];
      agents[agent.name] = agent;
      validateAgentRegistry(agents);
      return agents;
    },
    STATE_ROOT,
  );
}

export function getAgent(name: string): AgentConfig | undefined {
  return _loadAgents()[name];
}

export function listAgents(): AgentConfig[] {
  return Object.values(_loadAgents());
}

// ============================================================
// Thread Registry
// ============================================================

export interface ThreadInfo {
  agent: string;
  threadId: string;
  sessionId: string;
  sessionDir: string;
  created: string;
  lastUsed: string;
  summary?: string;
  /** Original user-supplied thread id, kept for display (may differ from the sanitized `threadId`). */
  userThreadId?: string;
}

function isValidThreadInfo(value: unknown): value is ThreadInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const thread = value as Record<string, unknown>;
  return (
    typeof thread.agent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(thread.agent) &&
    typeof thread.threadId === "string" && thread.threadId.length > 0 &&
    typeof thread.sessionId === "string" && thread.sessionId.length > 0 &&
    typeof thread.sessionDir === "string" && thread.sessionDir.length > 0 &&
    typeof thread.created === "string" && !Number.isNaN(Date.parse(thread.created)) &&
    typeof thread.lastUsed === "string" && !Number.isNaN(Date.parse(thread.lastUsed)) &&
    (thread.summary === undefined || typeof thread.summary === "string") &&
    (thread.userThreadId === undefined || typeof thread.userThreadId === "string")
  );
}

function validateThreadRegistry(value: unknown): Record<string, ThreadInfo> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid delegate thread registry in ${THREADS_PATH}`);
  }
  const registry = value as Record<string, unknown>;
  for (const [sessionId, thread] of Object.entries(registry)) {
    if (!sessionId || !isValidThreadInfo(thread)) {
      throw new Error(`Invalid delegate thread entry "${sessionId}" in ${THREADS_PATH}`);
    }
  }
  return registry as Record<string, ThreadInfo>;
}

function _loadThreads(): Record<string, ThreadInfo> {
  const data = loadFromFile<unknown>(THREADS_PATH);
  return data === undefined ? {} : validateThreadRegistry(data);
}

export async function loadThreads(): Promise<Record<string, ThreadInfo>> {
  return _loadThreads();
}

export async function saveThreads(
  threads: Record<string, ThreadInfo>,
): Promise<void> {
  await saveAtomically(THREADS_PATH, threads, STATE_ROOT);
}

export async function upsertThread(info: ThreadInfo): Promise<void> {
  await modifyFile<Record<string, ThreadInfo>>(THREADS_PATH, (threads) => {
    threads[info.sessionId] = info;
    return threads;
  }, STATE_ROOT);
}

export async function removeThread(sessionId: string): Promise<void> {
  await modifyFile<Record<string, ThreadInfo>>(THREADS_PATH, (threads) => {
    delete threads[sessionId];
    return threads;
  }, STATE_ROOT);
}

// Process-local async mutex for serializing read-modify-write sequences on
// the threads registry file (`delegate-threads.json`) within this process.
// Cross-process races between separate Pi processes are out of scope — the
// per-file `modifyFile`/`saveAtomically` locks in store.ts already protect
// individual writes; this mutex only makes a multi-step load→modify→upsert
// sequence atomic relative to other in-process callers.
let registryLock: Promise<void> = Promise.resolve();

export async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = registryLock;
  let release!: () => void;
  registryLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
