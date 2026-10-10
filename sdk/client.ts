import type { ArgsOf, Functions, Kind, Names, ResultOf } from "./functions.ts";

export function createClient<F extends Functions>(baseURL: string, appId: string, token: string) {
  async function call<K extends Kind, N extends Names<F, K>>(
    kind: K, name: N, args: ArgsOf<F[N]>,
  ): Promise<ResultOf<F[N]>> {
    const response = await fetch(`${baseURL}/apps/${encodeURIComponent(appId)}/${kind}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.result;
  }
  return {
    query: <N extends Names<F, "query">>(name: N, args: ArgsOf<F[N]>) => call("query", name, args),
    mutation: <N extends Names<F, "mutation">>(name: N, args: ArgsOf<F[N]>) => call("mutation", name, args),
  };
}
