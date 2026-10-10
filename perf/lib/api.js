// Shared API helpers for k6 load scenarios
// Provides base URL, app ID, token, and a wrapper for POST /apps/:app/:kind/:name

import http from "k6/http";

const baseURL = __ENV.BASE_URL || "http://localhost:8000";
const appId = __ENV.APP_ID || "tic-tac-toe";
const token = __ENV.TOKEN || "dev-only";
const runId = __ENV.RUN_ID || "";

// Main API call wrapper
export function api(kind, name, body) {
  const url = `${baseURL}/apps/${appId}/${kind}/${name}`;

  // Generate X-Trace-Id header: ${__VU}-${__ITER}-${runId}
  const traceId = `${__VU}-${__ITER}-${runId}`;

  const response = http.post(url, JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-Trace-Id": traceId,
    },
  });

  if (!response.status || response.status >= 400) {
    throw new Error(`API call failed: ${response.status} ${response.body}`);
  }

  const parsed = JSON.parse(response.body);
  if (!parsed.result) {
    throw new Error(`No result in response: ${response.body}`);
  }

  return parsed.result;
}

// Export configuration for tests
export const config = {
  baseURL,
  appId,
  token,
  runId,
};
