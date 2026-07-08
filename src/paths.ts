import * as os from "node:os";
import * as path from "node:path";

export const HOME = os.homedir();
export const DELEGATE_EXTS = path.join(HOME, ".pi", "delegate-exts");
export const SESSION_DIR = path.join(HOME, ".pi", "delegate-sessions");
export const AGENTS_PATH = path.join(HOME, ".pi", "delegate-agents.json");
export const THREADS_PATH = path.join(HOME, ".pi", "delegate-threads.json");
export const PI_AGENT_NPM = path.join(HOME, ".pi", "agent", "npm", "node_modules");
export const PI_AGENT_GIT = path.join(HOME, ".pi", "agent", "git");
