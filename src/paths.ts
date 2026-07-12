import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const HOME = os.homedir();

/**
 * Resolved set of delegate state paths, all rooted at `piHome`.
 *
 * Kept as a pure function so tests can verify path derivation without needing
 * to mutate process-wide module state (issue 24).
 */
export interface DelegatePaths {
  /** Trusted Pi config root (defaults to `~/.pi`, overridable via env). */
  piHome: string;
  /** Installed extension sources for agents (`<piHome>/delegate-exts`). */
  delegateExts: string;
  /** Child session transcripts (`<piHome>/delegate-sessions`). */
  sessionDir: string;
  /** Agent registry (`<piHome>/delegate-agents.json`). */
  agentsPath: string;
  /** Active threads registry (`<piHome>/delegate-threads.json`). */
  threadsPath: string;
  /** Pi's own npm node_modules (for extensions installed by Pi). */
  piAgentNpm: string;
  /** Pi's own git clones (for extensions installed by Pi). */
  piAgentGit: string;
}

export function resolveDelegatePaths(piHome: string): DelegatePaths {
  return {
    piHome,
    delegateExts: path.join(piHome, "delegate-exts"),
    sessionDir: path.join(piHome, "delegate-sessions"),
    agentsPath: path.join(piHome, "delegate-agents.json"),
    threadsPath: path.join(piHome, "delegate-threads.json"),
    piAgentNpm: path.join(piHome, "agent", "npm", "node_modules"),
    piAgentGit: path.join(piHome, "agent", "git"),
  };
}

/**
 * Trusted Pi config root.
 *
 * Pi supports rebranded/configurable config directory names, so we derive the
 * base from Pi's own `CONFIG_DIR_NAME` instead of hardcoding `.pi` (issue 24).
 * Set `PI_DELEGATE_HOME` to redirect the entire delegate state tree for
 * custom/rebranded deployments or tests. The value is read once at module
 * load ("configure paths once at startup") so it stays stable for the process.
 */
const PI_DELEGATE_HOME = process.env.PI_DELEGATE_HOME
  ? path.resolve(process.env.PI_DELEGATE_HOME)
  : path.join(HOME, CONFIG_DIR_NAME);

const paths = resolveDelegatePaths(PI_DELEGATE_HOME);

export const PI_HOME = paths.piHome;
export const DELEGATE_EXTS = paths.delegateExts;
export const SESSION_DIR = paths.sessionDir;
export const AGENTS_PATH = paths.agentsPath;
export const THREADS_PATH = paths.threadsPath;
export const PI_AGENT_NPM = paths.piAgentNpm;
export const PI_AGENT_GIT = paths.piAgentGit;
