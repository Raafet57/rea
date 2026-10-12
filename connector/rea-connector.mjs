#!/usr/bin/env node
// REA remote MCP connector.
//
// Exposes REA's stdio MCP server over MCP Streamable HTTP so it can be added
// as a custom connector in Claude (web, desktop, mobile) or any other client
// that speaks remote MCP. Each HTTP session gets its own `rea mcp` child
// process, so analysis still runs locally on the machine hosting this bridge.
//
// Zero dependencies beyond Node.js built-ins.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const env = process.env;
const config = {
  host: env.REA_CONNECTOR_HOST ?? "127.0.0.1",
  port: Number(env.REA_CONNECTOR_PORT ?? 8787),
  path: env.REA_CONNECTOR_PATH ?? "/mcp",
  token: env.REA_CONNECTOR_TOKEN ?? "",
  allowNoAuth: env.REA_CONNECTOR_ALLOW_NO_AUTH === "1",
  allowedOrigins: (env.REA_CONNECTOR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxSessions: Number(env.REA_CONNECTOR_MAX_SESSIONS ?? 4),
  idleTimeoutMs: Number(env.REA_CONNECTOR_IDLE_MINUTES ?? 30) * 60_000,
  maxBodyBytes: Number(env.REA_CONNECTOR_MAX_BODY_MB ?? 8) * 1024 * 1024,
  heartbeatMs: 15_000,
  command: resolveReaCommand(),
};

function resolveReaCommand() {
  if (env.REA_COMMAND) {
    // e.g. REA_COMMAND="npx -y rea-agents@latest mcp"
    const parts = env.REA_COMMAND.split(/\s+/).filter(Boolean);
    return { file: parts[0], args: parts.slice(1) };
  }
  const local = resolve(HERE, "../scripts/rea.mjs");
  const built = resolve(HERE, "../dist/main.js");
  if (existsSync(local) && existsSync(built))
    return { file: process.execPath, args: [local, "mcp"] };
  return { file: "npx", args: ["-y", "rea-agents@latest", "mcp"] };
}

if (!config.token && !config.allowNoAuth) {
  console.error(
    "REA_CONNECTOR_TOKEN is not set. REA can read files and launch processes on this\n" +
      "machine, so the connector refuses to start without a bearer token.\n" +
      "Generate one with:  export REA_CONNECTOR_TOKEN=$(openssl rand -hex 32)\n" +
      "(Set REA_CONNECTOR_ALLOW_NO_AUTH=1 only for local testing.)",
  );
  process.exit(1);
}

const log = (msg, extra) =>
  console.error(
    `[rea-connector ${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`,
  );

// ---------------------------------------------------------------------------
// Sessions: one `rea mcp` child process per MCP session
// ---------------------------------------------------------------------------

/** @type {Map<string, Session>} */
const sessions = new Map();

class Session {
  constructor(id) {
    this.id = id;
    this.lastActivity = Date.now();
    this.closed = false;
    /** request id (JSON string) -> SSE stream awaiting its response */
    this.pending = new Map();
    /** open POST streams, most recent last */
    this.streams = new Set();
    /** standalone GET stream, if any */
    this.getStream = null;
    /** server-initiated messages waiting for a stream */
    this.backlog = [];
    this.buffer = "";

    this.child = spawn(config.command.file, config.command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      for (const line of chunk.split("\n"))
        if (line.trim())
          process.stderr.write(`[rea ${id.slice(0, 8)}] ${line}\n`);
    });
    this.child.on("exit", (code, signal) => {
      log("rea process exited", { session: id, code, signal });
      this.fail("REA process exited");
    });
    this.child.on("error", (err) => {
      log("failed to start rea", { session: id, error: err.message });
      this.fail(`Failed to start REA: ${err.message}`);
    });
    this.child.stdin.on("error", () => {});
  }

  touch() {
    this.lastActivity = Date.now();
  }

  send(message) {
    if (this.closed) return false;
    this.child.stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("non-JSON line from rea stdout ignored", {
          line: line.slice(0, 200),
        });
        continue;
      }
      this.route(msg);
    }
  }

  route(msg) {
    this.touch();
    const isResponse = "id" in msg && !("method" in msg);
    if (isResponse) {
      const key = JSON.stringify(msg.id);
      const stream = this.pending.get(key);
      this.pending.delete(key);
      if (stream) {
        stream.deliver(msg, key);
      } else {
        log("response for unknown or abandoned request dropped", {
          id: msg.id,
        });
      }
      return;
    }
    // Notification or server->client request: prefer an open POST stream,
    // then the GET stream, else hold it until one opens.
    const target = [...this.streams].at(-1) ?? this.getStream;
    if (target) target.write(msg);
    else this.backlog.push(msg);
  }

  attachGetStream(stream) {
    if (this.getStream) this.getStream.end();
    this.getStream = stream;
    const backlog = this.backlog.splice(0);
    for (const msg of backlog) stream.write(msg);
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const [key, stream] of this.pending) {
      stream.deliver(
        {
          jsonrpc: "2.0",
          id: JSON.parse(key),
          error: { code: -32603, message: reason },
        },
        key,
      );
    }
    this.pending.clear();
    for (const s of this.streams) s.end();
    this.getStream?.end();
    sessions.delete(this.id);
  }

  close() {
    if (this.closed) return;
    this.fail("Session closed");
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }, 3_000).unref();
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 10_000).unref();
  }
}

/** An SSE response stream that ends once all of its awaited responses arrive. */
class SseStream {
  constructor(res, session, awaitedKeys) {
    this.res = res;
    this.session = session;
    this.awaiting = new Set(awaitedKeys);
    this.open = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Mcp-Session-Id": session.id,
    });
    res.flushHeaders?.();
    this.heartbeat = setInterval(
      () => this.open && res.write(": ping\n\n"),
      config.heartbeatMs,
    );
    res.on("close", () => this.onClientClose());
  }

  write(msg) {
    if (!this.open) return false;
    this.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    return true;
  }

  deliver(msg, key) {
    this.write(msg);
    this.awaiting.delete(key);
    if (this.awaiting.size === 0 && this.isPostStream) this.end();
  }

  end() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.heartbeat);
    this.session.streams.delete(this);
    if (this.session.getStream === this) this.session.getStream = null;
    this.res.end();
  }

  onClientClose() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.heartbeat);
    this.session.streams.delete(this);
    if (this.session.getStream === this) this.session.getStream = null;
    // Leave pending requests mapped to nothing: REA keeps working and the
    // response is dropped. Cancel them so REA can stop early.
    for (const key of this.awaiting) {
      if (this.session.pending.get(key) === this) {
        this.session.pending.delete(key);
        this.session.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: JSON.parse(key), reason: "Client disconnected" },
        });
      }
    }
  }
}

/** Collects responses and replies with a single JSON body (non-SSE clients). */
class JsonCollector {
  constructor(res, session, awaitedKeys, batch) {
    this.res = res;
    this.session = session;
    this.awaiting = new Set(awaitedKeys);
    this.batch = batch;
    this.results = [];
    this.open = true;
    res.on("close", () => {
      this.open = false;
    });
  }
  write() {
    return false; // notifications cannot be delivered on a JSON response
  }
  deliver(msg, key) {
    this.results.push(msg);
    this.awaiting.delete(key);
    if (this.awaiting.size === 0 && this.open) {
      const body = JSON.stringify(this.batch ? this.results : this.results[0]);
      this.res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": this.session.id,
      });
      this.res.end(body);
    }
  }
  end() {}
}

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

const tokenDigest = createHash("sha256").update(config.token).digest();

function authorized(req) {
  if (!config.token) return true;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const given = createHash("sha256").update(match[1].trim()).digest();
  return timingSafeEqual(given, tokenDigest);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // server-to-server clients (e.g. Claude's cloud) send none
  if (
    config.allowedOrigins.includes("*") ||
    config.allowedOrigins.includes(origin)
  )
    return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function jsonError(res, status, message, { code = -32000, headers = {} } = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }),
  );
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(
          Object.assign(new Error("Request body too large"), { status: 413 }),
        );
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function evictIfFull() {
  if (sessions.size < config.maxSessions) return true;
  const idle = [...sessions.values()]
    .filter((s) => s.pending.size === 0)
    .sort((a, b) => a.lastActivity - b.lastActivity);
  if (idle.length === 0) return false;
  log("evicting least recently used session", { session: idle[0].id });
  idle[0].close();
  return true;
}

async function handlePost(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return jsonError(
      res,
      err.status ?? 400,
      err.status ? err.message : "Parse error",
      { code: -32700 },
    );
  }
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  if (messages.length === 0 || messages.some((m) => !m || m.jsonrpc !== "2.0"))
    return jsonError(res, 400, "Invalid JSON-RPC message", { code: -32600 });

  const isInit = messages.some((m) => m.method === "initialize");
  const sessionId = req.headers["mcp-session-id"];
  let session;

  if (isInit) {
    if (sessionId)
      return jsonError(res, 400, "initialize must not carry Mcp-Session-Id");
    if (!evictIfFull())
      return jsonError(
        res,
        503,
        "Too many active REA sessions; try again shortly",
      );
    session = new Session(randomUUID());
    sessions.set(session.id, session);
    log("session started", { session: session.id, command: config.command });
  } else {
    if (!sessionId) return jsonError(res, 400, "Missing Mcp-Session-Id header");
    session = sessions.get(String(sessionId));
    if (!session)
      return jsonError(res, 404, "Session not found; re-initialize", {
        code: -32001,
      });
  }
  session.touch();

  const requests = messages.filter(
    (m) => "method" in m && "id" in m && m.id !== null,
  );
  if (requests.length === 0) {
    for (const m of messages) session.send(m);
    res.writeHead(202, { "Mcp-Session-Id": session.id });
    return res.end();
  }

  const keys = requests.map((m) => JSON.stringify(m.id));
  const accept = String(req.headers.accept ?? "");
  const stream = accept.includes("text/event-stream")
    ? new SseStream(res, session, keys)
    : new JsonCollector(res, session, keys, batch);
  stream.isPostStream = true;
  if (stream instanceof SseStream) {
    session.streams.add(stream);
    // Flush anything the server wanted to say while no stream was open.
    for (const msg of session.backlog.splice(0)) stream.write(msg);
  }
  for (const key of keys) session.pending.set(key, stream);
  for (const m of messages) session.send(m);
}

function handleGet(req, res) {
  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("text/event-stream"))
    return jsonError(res, 406, "GET requires Accept: text/event-stream");
  const session = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
  if (!session)
    return jsonError(res, 404, "Session not found", { code: -32001 });
  session.touch();
  const stream = new SseStream(res, session, []);
  stream.isPostStream = false;
  session.attachGetStream(stream);
}

function handleDelete(req, res) {
  const session = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
  if (!session)
    return jsonError(res, 404, "Session not found", { code: -32001 });
  log("session closed by client", { session: session.id });
  session.close();
  res.writeHead(204);
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
  }
  if (url.pathname !== config.path) return jsonError(res, 404, "Not found");
  if (!originAllowed(req)) return jsonError(res, 403, "Origin not allowed");
  if (!authorized(req))
    return jsonError(res, 401, "Unauthorized", {
      headers: { "WWW-Authenticate": 'Bearer realm="rea"' },
    });

  try {
    if (req.method === "POST") return await handlePost(req, res);
    if (req.method === "GET") return handleGet(req, res);
    if (req.method === "DELETE") return handleDelete(req, res);
    res.writeHead(405, { Allow: "GET, POST, DELETE" });
    res.end();
  } catch (err) {
    log("request failed", { error: err.message });
    if (!res.headersSent)
      jsonError(res, 500, "Internal error", { code: -32603 });
    else res.end();
  }
});

server.requestTimeout = 0; // analyses can run long; SSE heartbeats keep it alive
server.headersTimeout = 60_000;

const reaper = setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values())
    if (s.pending.size === 0 && now - s.lastActivity > config.idleTimeoutMs) {
      log("closing idle session", { session: s.id });
      s.close();
    }
}, 60_000);
reaper.unref();

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}${config.path}`, {
    auth: config.token ? "bearer" : "NONE",
    rea: [config.command.file, ...config.command.args].join(" "),
  });
});

const shutdown = () => {
  log("shutting down");
  for (const s of sessions.values()) s.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
