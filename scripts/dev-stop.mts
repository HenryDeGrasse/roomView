import { execSync } from "node:child_process";

const ports = [
  process.env.PORT_API ?? process.env.API_PORT ?? "3000",
  process.env.PORT_WEB ?? process.env.WEB_PORT ?? "4288",
].map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value));

const seen = new Set<number>();

for (const port of ports) {
  try {
    const output = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!output) continue;
    for (const line of output.split(/\r?\n/)) {
      const pid = Number.parseInt(line, 10);
      if (Number.isFinite(pid)) {
        seen.add(pid);
      }
    }
  } catch {
    // no process on this port
  }
}

for (const pattern of ["apps/api/src/server.ts", "apps/web/src/server.ts"]) {
  try {
    const output = execSync(`pgrep -f '${pattern}'`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!output) continue;
    for (const line of output.split(/\r?\n/)) {
      const pid = Number.parseInt(line, 10);
      if (Number.isFinite(pid)) {
        seen.add(pid);
      }
    }
  } catch {
    // no matching process
  }
}

if (seen.size === 0) {
  console.log("[dev:stop] No RoomView dev processes found.");
  process.exit(0);
}

for (const pid of seen) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[dev:stop] Sent SIGTERM to PID ${pid}`);
  } catch {
    // already gone
  }
}
