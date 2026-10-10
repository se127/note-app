import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 5173);
const SERVER_URL = `http://${HOST}:${PORT}`;
const TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const GRACE_MS = 1500;

export const DEFAULT_DEV_NOTE_COUNT = 0;
export const DEFAULT_DEV_DB_DELAY = 0;

export function parseNoteCount(argv: string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const [flag, inlineValue] = arg.split("=", 2);
    if (flag !== "--notes") continue;

    const raw = inlineValue ?? argv[index + 1];
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 0) return DEFAULT_DEV_NOTE_COUNT;

    return count;
  }

  return DEFAULT_DEV_NOTE_COUNT;
}

export function parseDbDelay(argv: string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const [flag, inlineValue] = arg.split("=", 2);
    if (flag !== "db-delay" && flag !== "--db-delay") continue;

    const raw = inlineValue ?? argv[index + 1];
    const delay = Number(raw);
    if (!Number.isInteger(delay) || delay < 0) return DEFAULT_DEV_DB_DELAY;

    return delay;
  }

  return DEFAULT_DEV_DB_DELAY;
}

export function describeDevFlags(noteCount: number, dbDelay: number): string {
  const notes =
    noteCount > 0
      ? `seed ${noteCount} note${noteCount === 1 ? "" : "s"}`
      : "no notes seeded";
  const delay = dbDelay > 0 ? `${dbDelay}ms query delay` : "no query delay";

  return `[dev] flags: --notes=${noteCount} (${notes}), --db-delay=${dbDelay} (${delay})`;
}

export function devUserDataDir(
  appData: string | undefined,
  home: string,
): string {
  const base = appData ?? path.join(home, ".config");
  return path.join(base, "NoteApp-dev");
}

export function serverUrl(port: number, host: string = HOST): string {
  return `http://${host}:${port}`;
}

export function viteArgs(host: string, port: number): string[] {
  return ["vite", "--host", host, "--port", String(port), "--strictPort"];
}

export type ServerProbe = () => Promise<{ reachable: boolean; status: number }>;

export function createServerProbe(fetchImpl: typeof fetch): ServerProbe {
  return async () => {
    const response = await fetchImpl(SERVER_URL, {
      signal: AbortSignal.timeout(1000),
    });
    return { reachable: true, status: response.status };
  };
}

/** Mirrors `Response.ok`: 200-299 counts, and a 404 means vite is up. */
function isOkStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404;
}

export async function waitForServer(
  probe: ServerProbe,
  timeoutMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    try {
      const { reachable, status } = await probe();
      if (reachable && isOkStatus(status)) return;
    } catch {}
    await sleep(POLL_MS);
  }

  throw new Error(
    `[dev] ${SERVER_URL} did not respond within ${timeoutMs / 1000}s`,
  );
}

export function isRunning(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export type StopOptions = {
  platform: NodeJS.Platform;
  pid: number | undefined;
  force: boolean;
  kill: (pid: number) => void;
  runTaskkill: (args: string[]) => void;
};

export function stopTree(
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "pid">,
  options: StopOptions,
): void {
  if (!isRunning(child)) return;

  if (options.platform === "win32" && child.pid !== undefined) {
    const args = ["/pid", String(child.pid), "/T"];
    if (options.force) args.push("/F");

    options.runTaskkill(args);
    return;
  }

  options.kill(child.pid ?? 0);
}

const children: ChildProcess[] = [];

let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const stopOptions: StopOptions = {
    platform: process.platform,
    pid: undefined,
    force: false,
    kill: (pid) => children[0]?.kill(pid),
    runTaskkill: (args) => {
      spawnSync("taskkill", args, { stdio: "ignore" });
    },
  };

  for (const child of children) stopTree(child, stopOptions);

  await new Promise((resolve) => setTimeout(resolve, GRACE_MS));

  for (const child of children) {
    if (!isRunning(child)) continue;
    stopTree(child, { ...stopOptions, force: true });
    if (isRunning(child)) {
      console.error(
        `[dev] could not stop ${child.spawnargs.join(" ")}; port ${PORT} may still be held`,
      );
    }
  }

  process.exit(code);
}

function start(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string> = {},
): ChildProcess {
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} exited (code ${code}, signal ${signal})`);
    void shutdown(typeof code === "number" ? code : 1);
  });

  children.push(child);
  return child;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  console.log(`[dev] starting vite on ${SERVER_URL}`);
  start("vite", "bunx", viteArgs(HOST, PORT));

  try {
    await waitForServer(
      createServerProbe(fetch),
      TIMEOUT_MS,
      () => Date.now(),
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    );

    const noteCount = parseNoteCount(process.argv.slice(2));
    const dbDelay = parseDbDelay(process.argv.slice(2));

    console.log(describeDevFlags(noteCount, dbDelay));

    console.log("[dev] vite is up, launching electron");
    start("electron", "bunx", ["electron", "."], {
      VITE_DEV_SERVER_URL: SERVER_URL,
      NoteApp_USER_DATA: devUserDataDir(process.env["APPDATA"], os.homedir()),
      NoteApp_DEV_NOTES: String(noteCount),
      NoteApp_DB_DELAY: String(dbDelay),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    void shutdown(1);
  }
}
