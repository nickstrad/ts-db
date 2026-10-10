/** Small JSON-lines transport. Only trusted named handler requests cross it. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
    if (buffer.length > 2_000_000) throw new Error("IPC message too large");
  }
  if (buffer.trim()) throw new Error("Truncated IPC message");
}
export type ReaderRequest = { kind: "ping" } | { kind: "query"; appId: string; name: string; args: unknown };

export class ReaderRPC {
  private child: Deno.ChildProcess;
  private input: WritableStreamDefaultWriter<Uint8Array>;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private stopped?: Error;
  private writes: Promise<void> = Promise.resolve();
  constructor(module: string) {
    this.child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", module], stdin: "piped", stdout: "piped", stderr: "inherit",
    }).spawn();
    this.input = this.child.stdin.getWriter();
    void this.receive();
  }
  private fail(error: Error) {
    this.stopped = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
  private async receive() {
    try {
      for await (const line of lines(this.child.stdout)) {
        const reply = JSON.parse(line);
        const entry = this.pending.get(reply.id);
        if (!entry) continue;
        this.pending.delete(reply.id);
        if (reply.error) entry.reject(new Error(reply.error)); else entry.resolve(reply.result);
      }
      this.fail(new Error(`Reader exited: ${(await this.child.status).code}`));
    } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); }
  }
  call(request: ReaderRequest): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.pending.size >= 1000) return Promise.reject(new Error("Reader queue full"));
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    const bytes = new TextEncoder().encode(JSON.stringify({ id, ...request }) + "\n");
    this.writes = this.writes.then(() => this.input.write(bytes)).catch((e) => this.fail(e));
    return result;
  }
  async close() {
    try { await this.writes; await this.input.close(); } catch { /* child already exited */ }
    await this.child.status;
  }
}
