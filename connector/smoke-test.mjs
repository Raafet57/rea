#!/usr/bin/env node
// Smoke test for a running REA connector.
// Usage: REA_CONNECTOR_URL=http://127.0.0.1:8787/mcp REA_CONNECTOR_TOKEN=... node connector/smoke-test.mjs

const url = process.env.REA_CONNECTOR_URL ?? "http://127.0.0.1:8787/mcp";
const token = process.env.REA_CONNECTOR_TOKEN ?? "";

let sessionId;
let nextId = 1;

async function post(message, { auth = true } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  if (res.status === 202) return { status: 202 };
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream"))
    return { status: res.status, body: await res.json() };
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice(6)));
  return {
    status: res.status,
    body: events.find((e) => e.id === message.id),
    events,
  };
}

const request = (method, params) =>
  post({ jsonrpc: "2.0", id: nextId++, method, params });

function check(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
}

if (token) {
  const unauth = await post(
    { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
    { auth: false },
  );
  check(unauth.status === 401, "rejects requests without the bearer token");
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "rea-connector-smoke-test", version: "1.0.0" },
});
check(
  init.status === 200 && init.body?.result?.serverInfo?.name === "rea",
  "initialize",
);
check(Boolean(sessionId), `session id issued (${sessionId})`);

const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
check(ack.status === 202, "initialized notification accepted");

const tools = await request("tools/list", {});
const names = tools.body?.result?.tools?.map((t) => t.name) ?? [];
check(names.length > 0, `tools/list returned ${names.length} tools`);

// Static JavaScript analysis needs no native engine, so it works on any host.
const target = new URL(".", import.meta.url).pathname;
const call = await request("tools/call", {
  name: "analyze_javascript_application",
  arguments: { input_path: target },
});
check(
  call.body?.result !== undefined && call.body.result.isError !== true,
  `tools/call analyze_javascript_application on ${target}`,
);
if (call.body?.result) {
  const text =
    call.body.result.content?.find((c) => c.type === "text")?.text ?? "";
  console.log("      " + text.slice(0, 300).replace(/\n/g, "\n      "));
} else console.log("      ", JSON.stringify(call.body ?? call).slice(0, 400));

const del = await fetch(url, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
});
check(del.status === 204, "session deleted");
