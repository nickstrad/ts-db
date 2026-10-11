/** Standalone reader-side Effect program; never imports the writer's SQLite stack. */
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import { AnalysisLive, analysisQuery, catalog } from "../platform/analysis/catalog.ts";
import { ConfigLive } from "../platform/config.ts";
import { EventLogIngestLive } from "../platform/eventlog/ingest.ts";
import { LoggingReaderLive } from "../platform/logging/logger.ts";
import { sweepConfigured } from "../platform/logging/retention.ts";
import { Analysis, EventLogIngest, EventSink } from "../platform/services.ts";

type Format = "table" | "json" | "csv";
const usage = `Usage: deno run -A scripts/logs.ts <command>
  ingest
  query <name> [--param key=value] [--format table|json|csv]
  list
  sweep [--dry-run]
Named queries never accept raw SQL. Use list for descriptions and parameter names.`;

function parse(args: readonly string[]) {
  const [command, ...rest] = args;
  const params: Record<string, string> = Object.create(null);
  let format: Format = "table";
  let name = "";
  let dryRun = false;
  if (!["ingest", "query", "list", "sweep"].includes(command)) throw new Error(usage);
  if (command === "query") {
    name = rest.shift() ?? "";
    if (!name || name.startsWith("--")) throw new Error(usage);
  }
  while (rest.length) {
    const option = rest.shift();
    if (command === "sweep" && option === "--dry-run") dryRun = true;
    else if (command === "query" && option === "--format") {
      const value = rest.shift();
      if (value !== "table" && value !== "json" && value !== "csv") {
        throw new Error("--format must be table, json or csv");
      }
      format = value;
    } else if (command === "query" && option === "--param") {
      const value = rest.shift() ?? "";
      const split = value.indexOf("=");
      if (split < 1) throw new Error("--param needs key=value");
      const key = value.slice(0, split);
      if (Object.hasOwn(params, key)) throw new Error(`Duplicate parameter: ${key}`);
      params[key] = value.slice(split + 1);
    } else throw new Error(`Unexpected argument: ${option}\n${usage}`);
  }
  return { command, params, format, name, dryRun };
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

function printRows(rows: readonly Readonly<Record<string, unknown>>[], format: Format): void {
  if (format === "json") {
    console.log(json(rows));
    return;
  }
  if (rows.length === 0) {
    if (format === "table") console.log("(0 rows)");
    return;
  }
  const columns = Object.keys(rows[0]);
  const cell = (value: unknown) =>
    value === null || value === undefined ? "" : typeof value === "object" ? json(value) : String(value);
  const values = [columns, ...rows.map((row) => columns.map((key) => cell(row[key])))];
  if (format === "csv") {
    const quote = (s: string) => /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    console.log(values.map((row) => row.map(quote).join(",")).join("\n"));
  } else {
    const lines = values.map((row) => row.map((s) => s.replaceAll("\n", "\\n").replaceAll("\r", "\\r")));
    const widths = columns.map((_, i) => lines.reduce((max, row) => Math.max(max, row[i].length), 0));
    console.log(lines.map((row) => row.map((s, i) => s.padEnd(widths[i])).join(" | ")).join("\n"));
  }
}

const readerLogging = LoggingReaderLive.pipe(Layer.provideMerge(ConfigLive));

const main = Effect.gen(function* () {
  const options = yield* Effect.try(() => parse(Deno.args));
  switch (options.command) {
    case "list":
      console.log(
        Object.entries(catalog).map(([name, entry]) =>
          `${name}: ${entry.description}\n  params: ${
            entry.params.map((p) => p.name + (p.required ? " (required)" : " (optional)")).join(", ")
          }`
        ).join("\n"),
      );
      break;
    case "query": {
      yield* analysisQuery(options.name);
      const rows = yield* Effect.flatMap(Analysis, (service) => service.run(options.name, options.params))
        .pipe(Effect.provide(AnalysisLive.pipe(Layer.provide(ConfigLive))));
      printRows(rows, options.format);
      break;
    }
    case "ingest": {
      const report = yield* Effect.flatMap(EventLogIngest, (service) => service.ingest).pipe(
        Effect.provide(EventLogIngestLive.pipe(Layer.provide(readerLogging))),
      );
      console.log(json(report));
      break;
    }
    case "sweep": {
      // A successful dry run must not create log files, including a CLI sink file.
      const drySink = Layer.succeed(EventSink, { emit: () => Effect.void });
      const layer = options.dryRun ? Layer.merge(ConfigLive, drySink) : readerLogging;
      const report = yield* sweepConfigured({ role: "reader", dryRun: options.dryRun })
        .pipe(Effect.provide(layer));
      console.log(json(report));
      break;
    }
  }
});

if (import.meta.main) {
  const stderrLogger = Logger.replace(Logger.defaultLogger, Logger.withConsoleError(Logger.logfmtLogger));
  const exit = await Effect.runPromiseExit(main.pipe(Effect.provide(stderrLogger)));
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Cause.failureOption(exit.cause));
    console.error(error ? json({ ...error, message: String(error) }) : Cause.pretty(exit.cause));
    Deno.exitCode = 1;
  }
}
