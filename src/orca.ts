import { exec } from "child_process";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface OrcaTerminalInfo {
  handle: string;
  title: string;
  branch?: string;
  connected: boolean;
  worktreePath?: string;
  status?: string;
}

export interface OrcaReadResult {
  tail: string[];
  nextCursor?: string;
  latestCursor?: string;
  oldestCursor?: string;
  source?: string;
  status?: string;
}

export interface OrcaRunInfo {
  id: string;
  objective: string;
  coordinator_handle?: string | null;
  created_at: string;
}

export interface OrcaTaskInfo {
  id: string;
  task_title: string;
  status: string;
  spec?: string;
  result?: string | null;
}

/**
 * Orca's CLI is installed as `orca` on macOS and as `orca-ide` on Linux/WSL.
 * ORCA_BIN (or --orca-bin) wins; otherwise the first of the two found on PATH.
 */
export function resolveOrcaBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_BIN) return env.ORCA_BIN;
  const dirs = (env.PATH || "").split(delimiter).filter(Boolean);
  for (const name of ["orca", "orca-ide"]) {
    if (dirs.some((dir) => existsSync(join(dir, name)))) return name;
  }
  return "orca";
}

export class OrcaCLI {
  private binPath: string;

  constructor(binPath: string = resolveOrcaBin()) {
    this.binPath = binPath;
  }

  async listTerminals(): Promise<OrcaTerminalInfo[]> {
    try {
      const { stdout } = await execAsync(`${this.binPath} terminal list --json`);
      const data = JSON.parse(stdout) as { ok?: boolean; result?: { terminals?: Array<Record<string, unknown>> } };
      if (data.ok && Array.isArray(data.result?.terminals)) {
        return data.result.terminals.map((t) => ({
          handle: String(t.handle || ""),
          title: String(t.title || ""),
          branch: typeof t.branch === "string" ? t.branch : undefined,
          connected: Boolean(t.connected),
          worktreePath: typeof t.worktreePath === "string" ? t.worktreePath : undefined,
          status: typeof t.status === "string" ? t.status : undefined,
        }));
      }
      return [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[OrcaCLI] listTerminals failed:", msg);
      return [];
    }
  }

  async send(terminalHandle: string, text: string, enter: boolean = true): Promise<boolean> {
    try {
      const escaped = text.replace(/'/g, "'\\''");
      const enterFlag = enter ? "--enter" : "";
      const cmd = `${this.binPath} terminal send --terminal ${terminalHandle} --text '${escaped}' ${enterFlag} --json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout) as { ok?: boolean };
      return Boolean(data.ok);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OrcaCLI] send failed to ${terminalHandle}:`, msg);
      return false;
    }
  }

  async read(terminalHandle: string, cursor?: string, limit: number = 100): Promise<OrcaReadResult | null> {
    try {
      const cursorFlag = cursor ? `--cursor ${cursor}` : "";
      const cmd = `${this.binPath} terminal read --terminal ${terminalHandle} ${cursorFlag} --limit ${limit} --json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout) as {
        ok?: boolean;
        result?: {
          terminal?: {
            tail?: string[];
            nextCursor?: string;
            latestCursor?: string;
            oldestCursor?: string;
            source?: string;
            status?: string;
          };
        };
      };
      if (data.ok && data.result?.terminal) {
        const t = data.result.terminal;
        return {
          tail: Array.isArray(t.tail) ? t.tail : [],
          nextCursor: t.nextCursor,
          latestCursor: t.latestCursor,
          oldestCursor: t.oldestCursor,
          source: t.source,
          status: t.status,
        };
      }
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OrcaCLI] read failed for ${terminalHandle}:`, msg);
      return null;
    }
  }

  async readScreen(terminalHandle: string): Promise<string[]> {
    try {
      const cmd = `${this.binPath} terminal read --terminal ${terminalHandle} --screen --json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout) as { ok?: boolean; result?: { terminal?: { tail?: string[] } } };
      if (data.ok && Array.isArray(data.result?.terminal?.tail)) {
        return data.result.terminal.tail;
      }
      return [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OrcaCLI] readScreen failed for ${terminalHandle}:`, msg);
      return [];
    }
  }

  async createTerminal(title: string, command?: string): Promise<string | null> {
    try {
      const cmdFlag = command ? `--command '${command.replace(/'/g, "'\\''")}'` : "";
      const cmd = `${this.binPath} terminal create --title '${title.replace(/'/g, "'\\''")}' ${cmdFlag} --json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout) as { ok?: boolean; result?: { terminal?: { handle?: string } } };
      if (data.ok && typeof data.result?.terminal?.handle === "string") {
        return data.result.terminal.handle;
      }
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[OrcaCLI] createTerminal failed:", msg);
      return null;
    }
  }

  async closeTerminal(terminalHandle: string): Promise<boolean> {
    try {
      const cmd = `${this.binPath} terminal close --terminal ${terminalHandle} --json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout) as { ok?: boolean };
      return Boolean(data.ok);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OrcaCLI] closeTerminal failed for ${terminalHandle}:`, msg);
      return false;
    }
  }

  async listRuns(): Promise<OrcaRunInfo[]> {
    try {
      const { stdout } = await execAsync(`${this.binPath} orchestration run-list --json`);
      const data = JSON.parse(stdout) as { ok?: boolean; result?: { runs?: OrcaRunInfo[] } };
      return data.ok && Array.isArray(data.result?.runs) ? data.result.runs : [];
    } catch {
      return [];
    }
  }

  async listTasks(runId: string): Promise<OrcaTaskInfo[]> {
    try {
      const { stdout } = await execAsync(`${this.binPath} orchestration task-list --run ${runId} --json`);
      const data = JSON.parse(stdout) as { ok?: boolean; result?: { tasks?: OrcaTaskInfo[] } };
      return data.ok && Array.isArray(data.result?.tasks) ? data.result.tasks : [];
    } catch {
      return [];
    }
  }
}
