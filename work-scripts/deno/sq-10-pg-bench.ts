// sq-10: Postgres driver bake-off for MT-03 (TenantRegistry workload).
// Runs the SAME registry-shaped workload against npm:postgres and npm:pg, one driver at a time.
//
// Workload mirrors docs/plans/multitenancy.md MT-01/MT-03: PK lookups on tenants, the
// api_keys -> tenants join behind resolveTenantByKeyHash, tenant UPDATE/DELETE by PK,
// 100-row batch INSERTs, and BEGIN/COMMIT + BEGIN/ROLLBACK transactions.
//
// Usage (needs a Postgres on 127.0.0.1:5433, e.g. `docker run -d --name sq10-pg -e POSTGRES_PASSWORD=postgres
// -e POSTGRES_DB=tsdb -p 5433:5432 postgres:17`):
//   deno run --no-lock --allow-net=127.0.0.1 --allow-env --allow-read --allow-write \
//     work-scripts/deno/sq-10-pg-bench.ts
// Permissions: net to the Postgres host only; --allow-env is required in full because npm:pg reads every
// PG* variable at connect time (a narrow --allow-env list fails with NotCapable). --no-lock keeps deno.lock
// untouched (MT-03 owns the lock entries).
// Env:
//   SQ10_PG_URL  (default postgres://postgres:postgres@127.0.0.1:5433/tsdb)
//   SQ10_ITERS   (default 5000; PK/key-hash select iterations per variant)
//   SQ10_ORDER   (default "postgres,pg"; set "pg,postgres" to check run-order bias)
// Creates and drops its own schema (sq10_bench); never touches public.

import postgres from "npm:postgres@3.4.9";
import pg from "npm:pg@8.23.1";

const URL_ = Deno.env.get("SQ10_PG_URL") ??
  "postgres://postgres:postgres@127.0.0.1:5433/tsdb";
const ITERS = Number(Deno.env.get("SQ10_ITERS") ?? 5000);
const ORDER = (Deno.env.get("SQ10_ORDER") ?? "postgres,pg").split(",");
const SCHEMA = "sq10_bench";
const BATCHES = 30; // 30 x 100 tenant rows
const BATCH_ROWS = 100;
const KEYED = 2000; // tenants[0..1999] get an api key; tenants[2000..2999] have none (deletable)
const CRUD_ITERS = 1000;
const TXN_ITERS = 200;
const SAMPLER_APP = "sq10-sampler";

type Stmt = { name: string; text: string };
type Row = Record<string, unknown>;
type Q = (s: Stmt, params: unknown[], prepared: boolean) => Promise<Row[]>;
interface Driver {
  label: string;
  q: Q;
  txn: <T>(work: (q: Q) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

const S = {
  selPk: {
    name: "sq10_sel_pk",
    text:
      "SELECT id, slug, name, status, created_at FROM tenants WHERE id = $1",
  },
  selKey: {
    name: "sq10_sel_key",
    text:
      "SELECT t.id, t.status FROM api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL",
  },
  upd: {
    name: "sq10_upd",
    text: "UPDATE tenants SET name = $2 WHERE id = $1 RETURNING id",
  },
  del: { name: "sq10_del", text: "DELETE FROM tenants WHERE id = $1" },
  txnIns: {
    name: "sq10_txn_ins",
    text: "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)",
  },
  txnUpd: {
    name: "sq10_txn_upd",
    text: "UPDATE tenants SET status = $2 WHERE id = $1",
  },
  count: { name: "sq10_count", text: "SELECT count(*)::int AS n FROM tenants" },
  one: { name: "sq10_one", text: "SELECT 1 AS one" },
  sleep: { name: "sq10_sleep", text: "SELECT pg_sleep(0.3)" },
  bad: { name: "sq10_bad", text: "SELEC 1" },
  activeBackends: {
    name: "sq10_active",
    text:
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND state = 'active' AND application_name <> '${SAMPLER_APP}'`,
  },
  clientBackends: {
    name: "sq10_clients",
    text:
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND application_name <> '${SAMPLER_APP}'`,
  },
};

const DDL = `
SET search_path = ${SCHEMA};
CREATE TABLE tenants (id uuid PRIMARY KEY, slug text UNIQUE, name text, status text DEFAULT 'active', created_at timestamptz);
CREATE TABLE api_keys (id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants, key_hash text UNIQUE, prefix text, name text, revoked_at timestamptz, created_at timestamptz);
CREATE INDEX api_keys_key_hash_idx ON api_keys(key_hash);
`;

// ---------- driver adapters (the only driver-specific code) ----------

function openPostgres(): Driver {
  const sql = postgres(URL_, {
    max: 10,
    connection: { search_path: SCHEMA },
    onnotice: () => {},
  });
  const run =
    (tx: postgres.Sql | postgres.TransactionSql): Q => (s, params, prepared) =>
      tx.unsafe(s.text, params as never[], { prepare: prepared }).then((r) =>
        [...r] as Row[]
      );
  return {
    label: "postgres",
    q: run(sql),
    txn: <T>(work: (q: Q) => Promise<T>) =>
      sql.begin((tx) => work(run(tx))) as Promise<T>,
    close: () => sql.end({ timeout: 5 }),
  };
}

function openPg(): Driver {
  const pool = new pg.Pool({
    connectionString: URL_,
    max: 10,
    options: `-c search_path=${SCHEMA}`,
  });
  const run = (c: { query: pg.Pool["query"] }): Q => (s, params, prepared) =>
    c.query(
      (prepared
        ? { name: s.name, text: s.text, values: params }
        : { text: s.text, values: params }) as never,
    ).then((r: { rows: Row[] }) => r.rows);
  return {
    label: "pg",
    q: run(pool),
    txn: async <T>(work: (q: Q) => Promise<T>) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await work(run(c as never));
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

// ---------- helpers ----------

async function resetSchema(): Promise<void> {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  try {
    await c.query(
      `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`,
    );
    await c.query(DDL);
  } finally {
    await c.end();
  }
}

async function dropSchema(): Promise<void> {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    await c.end();
  }
}

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const pick = (p: number) =>
    s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, median: pick(0.5), p99: pick(0.99) };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function errorShape(
  p: Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as Record<string, unknown>;
    return {
      ctor: (e as object)?.constructor?.name,
      name: err.name,
      code: err.code,
      constraint: err.constraint ?? err.constraint_name,
      message: String(err.message).split("\n")[0],
    };
  }
}

const pick = (i: number, n: number) => (i * 7919) % n; // deterministic spread over the id list

// ---------- suite ----------

interface Result {
  op: string;
  driver: string;
  n: number;
  median: number;
  p99: number;
}

async function timedLoop(
  results: Result[],
  driver: string,
  op: string,
  n: number,
  body: (i: number) => Promise<unknown>,
): Promise<void> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await body(i);
    ms.push(performance.now() - t);
  }
  results.push({ op, driver, ...stats(ms) });
}

async function suite(
  d: Driver,
  results: Result[],
  notes: Record<string, unknown>,
): Promise<void> {
  const D = d.label;

  // Cold path: first query on a fresh driver (includes lazy connect + auth).
  {
    const t = performance.now();
    await d.q(S.one, [], false);
    notes.coldConnectFirstQueryMs = Number((performance.now() - t).toFixed(2));
  }

  // Seed tenants (100-row multi-row INSERTs, unprepared: arity varies).
  const ids: string[] = [];
  const slugs: string[] = [];
  await timedLoop(
    results,
    D,
    `INSERT tenants, ${BATCH_ROWS}-row batch (per batch)`,
    BATCHES,
    async (b) => {
      const rows: unknown[] = [];
      const ph: string[] = [];
      for (let r = 0; r < BATCH_ROWS; r++) {
        const id = crypto.randomUUID();
        const slug = `t${b}-${r}`;
        if (b * BATCH_ROWS + r < KEYED + CRUD_ITERS) {
          ids.push(id);
          slugs.push(slug);
        }
        ph.push(`($${r * 3 + 1}, $${r * 3 + 2}, $${r * 3 + 3})`);
        rows.push(id, slug, `Tenant ${b}-${r}`);
      }
      await d.q(
        {
          name: "sq10_ins_t",
          text: `INSERT INTO tenants (id, slug, name) VALUES ${ph.join(", ")}`,
        },
        rows,
        false,
      );
    },
  );
  // Make ids contiguous for the seeded set: tenants with rank >= KEYED are the deletable ones.
  const keyHashes: string[] = [];
  for (let i = 0; i < KEYED; i++) {
    keyHashes.push(await sha256Hex(`tsdb_bench_${i}`));
  }

  await timedLoop(
    results,
    D,
    `INSERT api_keys, ${BATCH_ROWS}-row batch (per batch)`,
    KEYED / BATCH_ROWS,
    async (b) => {
      const rows: unknown[] = [];
      const ph: string[] = [];
      for (let r = 0; r < BATCH_ROWS; r++) {
        const i = b * BATCH_ROWS + r;
        ph.push(
          `($${r * 5 + 1}, $${r * 5 + 2}, $${r * 5 + 3}, $${r * 5 + 4}, $${
            r * 5 + 5
          })`,
        );
        rows.push(crypto.randomUUID(), ids[i], keyHashes[i], "tsdb_", "bench");
      }
      await d.q(
        {
          name: "sq10_ins_k",
          text:
            `INSERT INTO api_keys (id, tenant_id, key_hash, prefix, name) VALUES ${
              ph.join(", ")
            }`,
        },
        rows,
        false,
      );
    },
  );

  // Hot path: SELECT by tenant PK. Asserts the row so a broken driver can't "win" by returning nothing.
  await timedLoop(
    results,
    D,
    "SELECT tenant by PK (prepared/named)",
    ITERS,
    async (i) => {
      const k = pick(i, KEYED);
      const r = await d.q(S.selPk, [ids[k]], true);
      if (r.length !== 1 || r[0].id !== ids[k]) {
        throw new Error(
          `${D}: selPk mismatch at ${k}`,
        );
      }
    },
  );
  await timedLoop(
    results,
    D,
    "SELECT tenant by PK (unprepared)",
    ITERS,
    async (i) => {
      const k = pick(i, KEYED);
      const r = await d.q(S.selPk, [ids[k]], false);
      if (r.length !== 1 || r[0].id !== ids[k]) {
        throw new Error(
          `${D}: selPk(unprep) mismatch at ${k}`,
        );
      }
    },
  );

  // resolveTenantByKeyHash shape: api_keys JOIN tenants on key_hash.
  await timedLoop(
    results,
    D,
    "SELECT api_keys JOIN tenants by key_hash (prepared)",
    ITERS,
    async (i) => {
      const k = pick(i, KEYED);
      const r = await d.q(S.selKey, [keyHashes[k]], true);
      if (r.length !== 1 || r[0].id !== ids[k]) {
        throw new Error(
          `${D}: selKey mismatch at ${k}`,
        );
      }
    },
  );

  // CRUD by PK.
  await timedLoop(
    results,
    D,
    "UPDATE tenant name by PK (prepared, RETURNING)",
    CRUD_ITERS,
    async (i) => {
      const k = pick(i, KEYED);
      const r = await d.q(S.upd, [ids[k], `renamed-${i}`], true);
      if (r.length !== 1) throw new Error(`${D}: upd mismatch at ${k}`);
    },
  );
  await timedLoop(
    results,
    D,
    "DELETE tenant by PK (prepared)",
    CRUD_ITERS,
    async (i) => {
      await d.q(S.del, [ids[KEYED + i]], true);
    },
  );
  {
    const r = await d.q(S.count, [], false);
    const n = r[0].n as number;
    notes.rowCountAfterDeletes = n;
    if (n !== 3000 - CRUD_ITERS) {
      throw new Error(`${D}: expected ${3000 - CRUD_ITERS} tenants, got ${n}`);
    }
  }

  // Transactions: one BEGIN/INSERT/UPDATE/COMMIT per op.
  await timedLoop(
    results,
    D,
    "TXN BEGIN/INSERT/UPDATE/COMMIT (prepared)",
    TXN_ITERS,
    async () => {
      await d.txn(async (q) => {
        const id = crypto.randomUUID();
        await q(S.txnIns, [id, `txn-${id}`, "txn"], true);
        await q(S.txnUpd, [id, "suspended"], true);
      });
    },
  );

  // Transaction sanity: commit visible, rollback invisible.
  {
    const commitId = crypto.randomUUID();
    await d.txn(async (q) => {
      await q(S.txnIns, [commitId, `commit-${commitId}`, "c"], true);
    });
    const seen = await d.q(S.selPk, [commitId], true);
    const rbId = crypto.randomUUID();
    const rbErr = await errorShape(
      d.txn(async (q) => {
        await q(S.txnIns, [rbId, `rb-${rbId}`, "r"], true);
        throw new Error("rollback-probe");
      }),
    );
    const rbSeen = await d.q(S.selPk, [rbId], true);
    notes.txnSanity = {
      commitVisible: seen.length === 1,
      rollbackThrew: rbErr?.message ?? null,
      rollbackRowVisible: rbSeen.length !== 0,
    };
  }

  // Error ergonomics.
  notes.errors = {
    uniqueViolation: await errorShape(
      d.q(
        {
          name: "sq10_dup",
          text: "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)",
        },
        [crypto.randomUUID(), slugs[0], "dup"],
        false,
      ),
    ),
    syntaxError: await errorShape(d.q(S.bad, [], false)),
  };

  // Pooling probe: 20-way concurrent burst; sample active backends mid-burst via a separate client.
  {
    const sampler = new pg.Client({
      connectionString: URL_,
      application_name: SAMPLER_APP,
    });
    await sampler.connect();
    try {
      // Poll every 50ms and keep the max: a single early sample races pool warm-up.
      let done = false;
      const burst = Promise.all(
        Array.from({ length: 20 }, () => d.q(S.sleep, [], false)),
      ).finally(() => {
        done = true;
      });
      let active = 0;
      while (!done) {
        const n = (await sampler.query(S.activeBackends.text)).rows[0]
          .n as number;
        active = Math.max(active, n);
        await new Promise((r) => setTimeout(r, 50));
      }
      await burst;
      const idleAfter = (await sampler.query(S.clientBackends.text)).rows[0].n;
      notes.pool = {
        peakActiveDuring20WayBurst: active,
        clientBackendsAfterBurst: idleAfter,
      };
    } finally {
      await sampler.end();
    }
  }
}

// ---------- main ----------

const results: Result[] = [];
const notes: Record<string, Record<string, unknown>> = {};
for (const label of ORDER) {
  await resetSchema();
  const d = label === "postgres" ? openPostgres() : openPg();
  notes[d.label] = {};
  try {
    await suite(d, results, notes[d.label]);
  } finally {
    await d.close();
  }
}
await dropSchema();

console.log("| op | driver | n | median ms | p99 ms |");
console.log("| --- | --- | ---: | ---: | ---: |");
for (const r of results) {
  console.log(
    `| ${r.op} | ${r.driver} | ${r.n} | ${r.median.toFixed(3)} | ${
      r.p99.toFixed(3)
    } |`,
  );
}
console.log("");
console.log(JSON.stringify(notes, null, 2));
