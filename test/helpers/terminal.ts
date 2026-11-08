import { execFileSync, spawn } from "node:child_process";

interface TerminalOptions {
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  steps: readonly (readonly [prompt: string, answer: string])[];
  timeoutMs?: number;
}

const quote = (argument: string) => `'${argument.replaceAll("'", "'\\''")}'`;

const killTree = (pid: number) => {
  const descendants = new Set([pid]);
  try {
    const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 1_000 })
      .trim().split("\n").map((line) => line.trim().split(/\s+/u).map(Number));
    let size;
    do {
      size = descendants.size;
      for (const [child, parent] of processes) {
        if (descendants.has(parent)) descendants.add(child);
      }
    } while (size !== descendants.size);
  } catch {}
  for (const child of [...descendants].reverse()) {
    try { process.kill(child, "SIGKILL"); } catch {}
  }
};

export const runTerminal = ({ command, cwd, env, steps, timeoutMs = 15_000 }: TerminalOptions): Promise<{ code: number | null; output: string }> => {
  const shellCommand = `/bin/stty rows 24 columns 120; exec ${command.map(quote).join(" ")}`;
  const args = process.platform === "darwin"
    ? ["-q", "/dev/null", "/bin/sh", "-c", shellCommand]
    : process.platform === "linux"
      ? ["-q", "-e", "-f", "-c", shellCommand, "/dev/null"]
      : null;
  if (args === null) throw new Error("terminal tests require Darwin or Linux /usr/bin/script");

  const pipeBackedStdin = `/bin/cat | /usr/bin/script ${args.map(quote).join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", pipeBackedStdin], { cwd, env, stdio: "pipe" });
    let output = "";
    let cursor = 0;
    let step = 0;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      if (failure !== undefined) return;
      failure = error;
      if (child.pid !== undefined) killTree(child.pid);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const deadline = setTimeout(() => {
      fail(new Error(`terminal deadline exceeded while waiting for ${steps[step]?.[0] ?? "CLI exit"}\n${output}`));
    }, timeoutMs);
    const received = (chunk: Buffer) => {
      output += chunk.toString();
      while (step < steps.length && output.indexOf(steps[step][0], cursor) !== -1) {
        cursor = output.length;
        child.stdin.write(steps[step][1]);
        step += 1;
        if (step === steps.length) child.stdin.end();
      }
    };
    child.stdout.on("data", received);
    child.stderr.on("data", received);
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      child.stdin.destroy();
      if (failure !== undefined) reject(failure);
      else if (step !== steps.length || signal !== null) {
        reject(new Error(`terminal exited before completing prompts (${code ?? signal})\n${output}`));
      } else resolve({ code, output });
    });
  });
};
