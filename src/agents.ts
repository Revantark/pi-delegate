import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AgentConfig {
  name: string;
  model: string;
  tools?: string[];
  description?: string;
  extensions?: string[];
  noAutoExtensions?: boolean;
  session?: boolean;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "delegate-agents.json");
const THREADS_PATH = path.join(os.homedir(), ".pi", "delegate-threads.json");

// ============================================================
// Write-lock for concurrent-safe file operations
// ============================================================

const __configLockKey = "__delegate_config__";
const __configLocks = new Map<string, Promise<unknown>>();

function __chain<T>(fn: () => T): Promise<T> {
  const prev = __configLocks.get(__configLockKey) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const chained = next.then(
    (v) => {
      if (__configLocks.get(__configLockKey) === chained)
        __configLocks.delete(__configLockKey);
      return v;
    },
    (e) => {
      if (__configLocks.get(__configLockKey) === chained)
        __configLocks.delete(__configLockKey);
      throw e;
    },
  );
  __configLocks.set(__configLockKey, chained);
  return chained;
}

export function withConfigWrite<T>(fn: () => T): Promise<T> {
  return __chain(fn);
}

// ============================================================
// Agent registry
// ============================================================

function _loadAgents(): Record<string, AgentConfig> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function _saveAgents(agents: Record<string, AgentConfig>): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(agents, null, 2), "utf-8");
}

export function loadAgents(): Record<string, AgentConfig> {
  return _loadAgents();
}

export async function saveAgents(
  agents: Record<string, AgentConfig>,
): Promise<void> {
  return withConfigWrite(() => _saveAgents(agents));
}

export async function addAgent(
  name: string,
  model: string,
  tools?: string[],
  description?: string,
  extensions?: string[],
  noAutoExtensions?: boolean,
  session?: boolean,
): Promise<AgentConfig> {
  return withConfigWrite(() => {
    const agents = _loadAgents();
    const agent: AgentConfig = { name, model };
    if (tools !== undefined) agent.tools = tools;
    if (description !== undefined) agent.description = description;
    if (extensions !== undefined) agent.extensions = extensions;
    if (noAutoExtensions !== undefined) agent.noAutoExtensions = noAutoExtensions;
    if (session !== undefined) agent.session = session;
    agents[name] = agent;
    _saveAgents(agents);
    return agent;
  });
}

export async function removeAgent(name: string): Promise<boolean> {
  return withConfigWrite(() => {
    const agents = _loadAgents();
    if (!(name in agents)) return false;
    delete agents[name];
    _saveAgents(agents);
    return true;
  });
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
}

function _loadThreads(): Record<string, ThreadInfo> {
  try {
    if (!fs.existsSync(THREADS_PATH)) return {};
    return JSON.parse(fs.readFileSync(THREADS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function _saveThreads(threads: Record<string, ThreadInfo>): void {
  const dir = path.dirname(THREADS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(THREADS_PATH, JSON.stringify(threads, null, 2), "utf-8");
}

export function loadThreads(): Record<string, ThreadInfo> {
  return _loadThreads();
}

export async function saveThreads(
  threads: Record<string, ThreadInfo>,
): Promise<void> {
  return withConfigWrite(() => _saveThreads(threads));
}

export async function upsertThread(info: ThreadInfo): Promise<void> {
  return withConfigWrite(() => {
    const threads = _loadThreads();
    threads[info.sessionId] = info;
    _saveThreads(threads);
  });
}

export async function removeThread(sessionId: string): Promise<void> {
  return withConfigWrite(() => {
    const threads = _loadThreads();
    if (sessionId in threads) {
      delete threads[sessionId];
      _saveThreads(threads);
    }
  });
}