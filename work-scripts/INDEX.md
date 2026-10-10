# work-scripts index

Every script in this directory is listed here. Agents: read this before writing a new script,
and append a row when you add one (see `README.md`).

| script | date | author | purpose | usage | notes |
| --- | --- | --- | --- | --- | --- |
| `deno/sq-02-append-bench.ts` | 2026-10-10 | haiku (sq-02) | Baseline JSONL append throughput on this droplet (events/sec, MB/sec) at 200B / 1KB / 4KB record sizes | `deno run -A work-scripts/deno/sq-02-append-bench.ts` | Result: ~13.2k ev/s at 200B, ~7.6k ev/s at 1KB — clears item 11's 5k ev/s bar unbatched. See `docs/haiku-experiments/findings/sq-02.md`. |
| `deno/claude-usage.ts` | 2026-10-10 | main agent | Summarize Claude Code CLI token usage from ~/.claude/projects transcripts (per project, per day) | `deno run --allow-read --allow-env work-scripts/deno/claude-usage.ts [--date YYYY-MM-DD]` | Feeds the 20-min ts-db updates with usage numbers. |
| `bash/claude-limit.sh` | 2026-10-10 | main agent | Scrape the Claude Code weekly usage limit (% used/left, reset time) from the TUI /status Usage tab (no CLI flag exists) | `bash work-scripts/bash/claude-limit.sh` | Spawns a throwaway tmux session; takes ~30s. Feeds the 20-min ts-db updates with "% left". |
