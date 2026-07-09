import * as path from "node:path";
import * as os from "node:os";
import { modifyFile, loadFromFile, saveAtomically } from "./store.js";

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
// Agent registry
// ============================================================

function _loadAgents(): Record<string, AgentConfig> {
  const data = loadFromFile<Record<string, AgentConfig>>(CONFIG_PATH);
  return data ?? {};
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
): Promise<AgentConfig> {
  const result = await modifyFile<Record<string, AgentConfig>>(CONFIG_PATH, (agents) => {
    const agent: AgentConfig = { name, model };
    if (tools !== undefined) agent.tools = tools;
    if (description !== undefined) agent.description = description;
    if (extensions !== undefined) agent.extensions = extensions;
    if (noAutoExtensions !== undefined) agent.noAutoExtensions = noAutoExtensions;
    if (session !== undefined) agent.session = session;
    agents[name] = agent;
    return agents;
  });
  return result[name];
}

export async function removeAgent(name: string): Promise<boolean> {
  const agents = _loadAgents();
  if (!(name in agents)) return false;
  await modifyFile<Record<string, AgentConfig>>(CONFIG_PATH, (a) => {
    delete a[name];
    return a;
  });
  return true;
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
  const data = loadFromFile<Record<string, ThreadInfo>>(THREADS_PATH);
  return data ?? {};
}

export async function loadThreads(): Promise<Record<string, ThreadInfo>> {
  return _loadThreads();
}

export async function saveThreads(
  threads: Record<string, ThreadInfo>,
): Promise<void> {
  saveAtomically(THREADS_PATH, threads);
}

export async function upsertThread(info: ThreadInfo): Promise<void> {
  await modifyFile<Record<string, ThreadInfo>>(THREADS_PATH, (threads) => {
    threads[info.sessionId] = info;
    return threads;
  });
}

export async function removeThread(sessionId: string): Promise<void> {
  await modifyFile<Record<string, ThreadInfo>>(THREADS_PATH, (threads) => {
    delete threads[sessionId];
    return threads;
  });
}