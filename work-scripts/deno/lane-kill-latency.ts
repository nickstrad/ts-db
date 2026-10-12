// lane-kill-latency.ts: how much the current Deno mitigation for an un-interruptible node:sqlite
// statement costs. A "lane" is a child Deno process speaking JSON lines over stdio. We measure:
//   spawn_to_ready_ms      cold start of a lane until it answers its first ping (median of 5)
//   kill_to_exit_ms        SIGKILL sent while the lane runs a long statement, until exit status
//   restart_to_ready_ms    a replacement lane spawned after the kill, until it answers a ping
// For comparison, Worker.terminate() on the same statement returns immediately but the process
// cannot exit until SQLite returns (24.9 s measured 2026-10-12; see docs/architecture/scale-out-fable.md).
// Permissions: --allow-run (self), --allow-read/--allow-write (none beyond :memory:), --allow-env.
// Usage: deno run --allow-run --allow-env work-scripts/deno/lane-kill-latency.ts
import { DatabaseSync } from "node:sqlite";

const LONG =
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 400000000) SELECT count(*) FROM c";

if (Deno.args[0] === "--lane") {
  const db = new DatabaseSync(":memory:");
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line === "ping") console.log("pong");
      else if (line === "long") {
        db.prepare(LONG).get();
        console.log("done");
      }
    }
  }
  Deno.exit(0);
}

type Lane = {
  p: Deno.ChildProcess;
  w: WritableStreamDefaultWriter<Uint8Array>;
  lines: AsyncGenerator<string>;
};

async function* lineReader(r: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r) {
    buf += dec.decode(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
}

function spawn(): Lane {
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-env", import.meta.url, "--lane"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  return { p, w: p.stdin.getWriter(), lines: lineReader(p.stdout) };
}

const enc = new TextEncoder();
async function send(l: Lane, cmd: string) {
  await l.w.write(enc.encode(cmd + "\n"));
}
async function ready(l: Lane): Promise<number> {
  const t0 = performance.now();
  await send(l, "ping");
  for await (const line of l.lines) if (line === "pong") break;
  return performance.now() - t0;
}

const spawnToReady: number[] = [];
for (let i = 0; i < 5; i++) {
  const l = spawn();
  spawnToReady.push(await ready(l));
  l.p.kill("SIGKILL");
  await l.p.status;
}
spawnToReady.sort((a, b) => a - b);

// Kill a lane mid-statement.
const lane = spawn();
await ready(lane);
await send(lane, "long");
await new Promise((r) => setTimeout(r, 300));
const tKill = performance.now();
lane.p.kill("SIGKILL");
const status = await lane.p.status;
const killToExit = performance.now() - tKill;
const tRestart = performance.now();
const replacement = spawn();
await ready(replacement);
const restartToReady = performance.now() - tRestart;
replacement.p.kill("SIGKILL");
await replacement.p.status;

console.log(JSON.stringify({
  runtime: `deno ${Deno.version.deno}`,
  spawn_to_ready_ms_median: Math.round(spawnToReady[2] * 10) / 10,
  spawn_to_ready_ms_all: spawnToReady.map((v) => Math.round(v * 10) / 10),
  kill_to_exit_ms: Math.round(killToExit * 10) / 10,
  killed_signal: status.signal,
  restart_to_ready_ms: Math.round(restartToReady * 10) / 10,
  notes: [
    "kill_to_exit_ms: SIGKILL sent 300 ms into a long node:sqlite statement in the lane; the parent regains the slot in this time",
    "restart_to_ready_ms: cost of the replacement lane before it can serve",
    "Worker.terminate() on the same statement returned in 0 ms but the process waited 24.9 s for SQLite (measured 2026-10-12, see docs/architecture/scale-out-fable.md)",
  ],
}));
