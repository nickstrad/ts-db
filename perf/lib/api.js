// Shared k6 helpers for calling the document-db HTTP API.
// Route: POST /apps/:app/:kind/:name, kind in {query, mutation}. See platform/server.ts.
import http from "k6/http";

export const BASE_URL = __ENV.BASE_URL ?? "http://127.0.0.1:8000";
export const APP_ID = __ENV.APP_ID ?? "tic-tac-toe";
export const TOKEN = __ENV.TOKEN ?? "dev-only";
export const RUN_ID = __ENV.K6_RUN_ID ?? String(Date.now());

function traceId() {
  return `${__VU}-${__ITER}-${RUN_ID}`;
}

function call(kind, name, args) {
  const url = `${BASE_URL}/apps/${encodeURIComponent(APP_ID)}/${kind}/${name}`;
  const res = http.post(url, JSON.stringify(args), {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-trace-id": traceId(),
    },
  });
  let body;
  try {
    body = res.json();
  } catch (_e) {
    body = undefined;
  }
  return { res, body };
}

export function query(name, args) {
  return call("query", name, args);
}

export function mutation(name, args) {
  return call("mutation", name, args);
}
