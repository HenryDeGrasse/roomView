import { spawn, type ChildProcess } from "node:child_process";

const apiPort = process.env.PORT_API ?? process.env.API_PORT ?? "3000";
const webPort = process.env.PORT_WEB ?? process.env.WEB_PORT ?? "4288";
const apiBaseUrl = process.env.ROOMVIEW_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const children: ChildProcess[] = [];
let shuttingDown = false;

function startProcess(name: string, args: string[], extraEnv: Record<string, string>): ChildProcess {
  const child = spawn(npxCommand, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(prefixLines(name, String(chunk))));
  child.stderr?.on("data", (chunk) => process.stderr.write(prefixLines(name, String(chunk))));
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[dev] ${name} exited (${signal ? `signal ${signal}` : `code ${code ?? 0}`}). Shutting down the rest.`);
    for (const other of children) {
      if (other !== child) {
        other.kill("SIGTERM");
      }
    }
    process.exitCode = code ?? 1;
  });
  children.push(child);
  return child;
}

function prefixLines(name: string, text: string): string {
  return text
    .split(/(?<=\n)/)
    .map((line) => line.length > 0 ? `[${name}] ${line}` : line)
    .join("");
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] Caught ${signal}. Stopping RoomView dev stack...`);
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  }, 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[dev] Starting RoomView API on ${apiBaseUrl}`);
console.log(`[dev] Starting RoomView web editor on http://127.0.0.1:${webPort}`);
console.log(`[dev] After startup run: npm run dev:handoff`);
console.log(`[dev] Stop with Ctrl+C here, or run: npm run dev:stop`);

startProcess("api", ["--yes", "tsx", "./apps/api/src/server.ts"], {
  PORT: apiPort,
});
startProcess("web", ["--yes", "tsx", "./apps/web/src/server.ts"], {
  PORT: webPort,
  ROOMVIEW_API_BASE_URL: apiBaseUrl,
});

setInterval(() => {
  if (shuttingDown) {
    const allExited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    if (allExited) {
      process.exit(process.exitCode ?? 0);
    }
  }
}, 250).unref();
