import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  createServerProbe,
  DEFAULT_DEV_DB_DELAY,
  DEFAULT_DEV_NOTE_COUNT,
  describeDevFlags,
  devUserDataDir,
  isRunning,
  parseDbDelay,
  parseNoteCount,
  serverUrl,
  stopTree,
  viteArgs,
  waitForServer,
  type ServerProbe,
} from "../scripts/dev.ts";

type ChildLike = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
};

function child(overrides: Partial<ChildLike> = {}): ChildLike {
  return { exitCode: null, signalCode: null, pid: 100, ...overrides };
}

describe("devUserDataDir", () => {
  test("uses APPDATA when it is set", () => {
    const result = devUserDataDir(
      path.join(path.sep, "Users", "dev", "AppData", "Roaming"),
      path.join(path.sep, "home", "dev"),
    );

    expect(result).toBe(
      path.join(path.sep, "Users", "dev", "AppData", "Roaming", "NoteApp-dev"),
    );
  });

  test("falls back to the home config directory", () => {
    const result = devUserDataDir(
      undefined,
      path.join(path.sep, "home", "dev"),
    );

    expect(result).toBe(
      path.join(path.sep, "home", "dev", ".config", "NoteApp-dev"),
    );
  });

  test("keeps the dev database separate from the installed one", () => {
    const appData = path.join(path.sep, "Users", "dev", "AppData", "Roaming");
    const result = devUserDataDir(appData, path.join(path.sep, "home", "dev"));

    expect(result).not.toBe(path.join(appData, "NoteApp"));
    expect(path.basename(result)).toBe("NoteApp-dev");
  });

  test("names the dev folder after the app, not the working directory", () => {
    const result = devUserDataDir(path.sep, path.sep);

    expect(path.basename(result)).toBe("NoteApp-dev");
  });
});

describe("serverUrl", () => {
  test("builds the loopback url for a port", () => {
    expect(serverUrl(5173)).toBe("http://127.0.0.1:5173");
  });

  test("honours a custom port", () => {
    expect(serverUrl(4000)).toBe("http://127.0.0.1:4000");
  });
});

describe("viteArgs", () => {
  test("pins the host, port and strict port flag", () => {
    expect(viteArgs("127.0.0.1", 5173)).toEqual([
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ]);
  });

  test("uses strict port so a busy port fails loudly", () => {
    expect(viteArgs("127.0.0.1", 5173)).toContain("--strictPort");
  });

  test("never leaves the port free for a second server", () => {
    expect(
      viteArgs("127.0.0.1", 5173).filter((arg) => arg === "--port"),
    ).toHaveLength(1);
  });
});

describe("describeDevFlags", () => {
  test("names both values as they were passed", () => {
    const line = describeDevFlags(5000, 1000);

    expect(line).toContain("--notes=5000");
    expect(line).toContain("--db-delay=1000");
    expect(line).toContain("seed 5000 notes");
    expect(line).toContain("1000ms query delay");
  });

  test("spells out what a zero turns off", () => {
    const line = describeDevFlags(0, 0);

    expect(line).toContain("--notes=0");
    expect(line).toContain("no notes seeded");
    expect(line).toContain("--db-delay=0");
    expect(line).toContain("no query delay");
  });

  test("keeps a single seeded note singular", () => {
    expect(describeDevFlags(1, 0)).toContain("seed 1 note)");
  });
});

describe("parseNoteCount", () => {
  test("seeds nothing when the flag is absent", () => {
    expect(parseNoteCount([])).toBe(0);
    expect(DEFAULT_DEV_NOTE_COUNT).toBe(0);
  });

  test("reads a count after the flag", () => {
    expect(parseNoteCount(["--notes", "12"])).toBe(12);
  });

  test("reads a count joined to the flag with an equals sign", () => {
    expect(parseNoteCount(["--notes=12"])).toBe(12);
  });

  test("reads zero when asked for zero", () => {
    expect(parseNoteCount(["--notes", "0"])).toBe(0);
  });

  test("ignores unrelated flags around the count", () => {
    expect(parseNoteCount(["--host", "0.0.0.0", "--notes", "7"])).toBe(7);
  });

  test("falls back to zero for a count that is not a whole number", () => {
    expect(parseNoteCount(["--notes", "abc"])).toBe(0);
    expect(parseNoteCount(["--notes", "2.5"])).toBe(0);
    expect(parseNoteCount(["--notes", "-4"])).toBe(0);
  });

  test("falls back to zero when the flag carries no value", () => {
    expect(parseNoteCount(["--notes"])).toBe(0);
    expect(parseNoteCount(["--notes", "--host"])).toBe(0);
  });

  test("takes the first count when the flag is repeated", () => {
    expect(parseNoteCount(["--notes", "3", "--notes", "9"])).toBe(3);
  });
});

describe("parseDbDelay", () => {
  test("adds no delay when the flag is absent", () => {
    expect(parseDbDelay([])).toBe(0);
    expect(DEFAULT_DEV_DB_DELAY).toBe(0);
  });

  test("reads a delay joined to the flag with an equals sign", () => {
    expect(parseDbDelay(["db-delay=1000"])).toBe(1000);
  });

  test("reads a delay after the flag", () => {
    expect(parseDbDelay(["db-delay", "250"])).toBe(250);
  });

  test("accepts the double dash spelling too", () => {
    expect(parseDbDelay(["--db-delay=750"])).toBe(750);
  });

  test("reads zero when asked for zero", () => {
    expect(parseDbDelay(["db-delay=0"])).toBe(0);
  });

  test("ignores the note count while reading the delay", () => {
    expect(parseDbDelay(["--notes=5000", "db-delay=1000"])).toBe(1000);
    expect(parseNoteCount(["--notes=5000", "db-delay=1000"])).toBe(5000);
  });

  test("falls back to zero for a delay that is not a whole number", () => {
    expect(parseDbDelay(["db-delay=abc"])).toBe(0);
    expect(parseDbDelay(["db-delay=1.5"])).toBe(0);
    expect(parseDbDelay(["db-delay=-400"])).toBe(0);
  });

  test("falls back to zero when the flag carries no value", () => {
    expect(parseDbDelay(["db-delay"])).toBe(0);
    expect(parseDbDelay(["db-delay", "--notes"])).toBe(0);
  });

  test("takes the first delay when the flag is repeated", () => {
    expect(parseDbDelay(["db-delay=100", "db-delay=900"])).toBe(100);
  });
});

describe("isRunning", () => {
  test("is true while neither exit code nor signal is set", () => {
    expect(isRunning(child())).toBe(true);
  });

  test("is false after an exit code", () => {
    expect(isRunning(child({ exitCode: 0 }))).toBe(false);
  });

  test("is false after a signal", () => {
    expect(isRunning(child({ signalCode: "SIGTERM" }))).toBe(false);
  });
});

describe("stopTree", () => {
  test("does nothing for a process that already exited", () => {
    const taskkillCalls: string[][] = [];

    stopTree(child({ exitCode: 0 }), {
      platform: "win32",
      pid: undefined,
      force: false,
      kill: () => {},
      runTaskkill: (args) => taskkillCalls.push(args),
    });

    expect(taskkillCalls).toHaveLength(0);
  });

  test("kills the whole tree on windows", () => {
    const taskkillCalls: string[][] = [];

    stopTree(child(), {
      platform: "win32",
      pid: undefined,
      force: false,
      kill: () => {},
      runTaskkill: (args) => taskkillCalls.push(args),
    });

    expect(taskkillCalls).toEqual([["/pid", "100", "/T"]]);
  });

  test("forces the tree on windows when asked", () => {
    const taskkillCalls: string[][] = [];

    stopTree(child(), {
      platform: "win32",
      pid: undefined,
      force: true,
      kill: () => {},
      runTaskkill: (args) => taskkillCalls.push(args),
    });

    expect(taskkillCalls).toEqual([["/pid", "100", "/T", "/F"]]);
  });

  test("skips taskkill on windows without a pid", () => {
    const killed: number[] = [];

    stopTree(child({ pid: undefined }), {
      platform: "win32",
      pid: undefined,
      force: false,
      kill: (pid) => killed.push(pid),
      runTaskkill: () => {},
    });

    expect(killed).toEqual([0]);
  });

  test("sends a signal off windows", () => {
    const killed: number[] = [];
    const taskkillCalls: string[][] = [];

    stopTree(child(), {
      platform: "linux",
      pid: undefined,
      force: true,
      kill: (pid) => killed.push(pid),
      runTaskkill: (args) => taskkillCalls.push(args),
    });

    expect(killed).toEqual([100]);
    expect(taskkillCalls).toHaveLength(0);
  });
});

describe("waitForServer", () => {
  function clock(): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  } {
    let current = 0;

    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
    };
  }

  test("resolves as soon as the server answers", async () => {
    const time = clock();
    let calls = 0;

    const probe: ServerProbe = async () => {
      calls += 1;
      return { reachable: true, status: 200 };
    };

    await waitForServer(probe, 30_000, time.now, time.sleep);

    expect(calls).toBe(1);
  });

  test("accepts a 404 because vite serves index later", async () => {
    const time = clock();

    const probe: ServerProbe = async () => ({ reachable: true, status: 404 });

    await expect(
      waitForServer(probe, 30_000, time.now, time.sleep),
    ).resolves.toBeUndefined();
  });

  test("keeps polling while the connection fails", async () => {
    const time = clock();
    let calls = 0;

    const probe: ServerProbe = async () => {
      calls += 1;
      if (calls < 3) throw new Error("connection refused");
      return { reachable: true, status: 200 };
    };

    await waitForServer(probe, 30_000, time.now, time.sleep);

    expect(calls).toBe(3);
  });

  test("keeps polling while the status is not ready", async () => {
    const time = clock();
    let calls = 0;

    const probe: ServerProbe = async () => {
      calls += 1;
      return { reachable: true, status: calls < 2 ? 503 : 200 };
    };

    await waitForServer(probe, 30_000, time.now, time.sleep);

    expect(calls).toBe(2);
  });

  test("gives up after the timeout", async () => {
    const time = clock();

    const probe: ServerProbe = async () => {
      throw new Error("connection refused");
    };

    await expect(
      waitForServer(probe, 1000, time.now, time.sleep),
    ).rejects.toThrow("did not respond within 1s");
  });

  test("names the url it waited on", async () => {
    const time = clock();
    const probe: ServerProbe = async () => {
      throw new Error("nope");
    };

    await expect(
      waitForServer(probe, 500, time.now, time.sleep),
    ).rejects.toThrow("http://127.0.0.1:5173");
  });
});

describe("createServerProbe", () => {
  test("reports a reachable server with its status", async () => {
    const probe = createServerProbe(
      (async () =>
        new Response("", { status: 200 })) as unknown as typeof fetch,
    );

    expect(await probe()).toEqual({ reachable: true, status: 200 });
  });

  test("reports the status of a not found response", async () => {
    const probe = createServerProbe(
      (async () =>
        new Response("", { status: 404 })) as unknown as typeof fetch,
    );

    expect(await probe()).toEqual({ reachable: true, status: 404 });
  });
});
