import http from "http";
import fs from "fs";
import path from "path";
import { getCtx } from "./context";
import { renderInitialPage } from "./renderer";
import { DASHBOARD_PORT, WS_PORT } from "../constants";
import type { Config, SpawnOptions, WorkerCommand, ControllerMessage } from "./types";
import type { Controller } from "./controller";
import type { WorkerPool } from "./worker-pool";

export function startDashboard(controller: Controller, pool: WorkerPool): http.Server {
  const template = buildTemplate();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      const page = renderInitialPage(template, controller.getStatuses());
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page);
      return;
    }

    if (req.method === "GET" && req.url === "/config") {
      const { config } = getCtx();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(config, null, 2));
      return;
    }

    if (req.method === "POST" && req.url === "/config") {
      readBody(req, (err, body) => {
        if (err) { respond(res, 400, { error: "Failed to read body" }); return; }
        try {
          const patch: Partial<Config> = JSON.parse(body);
          if (typeof patch !== "object" || Array.isArray(patch)) {
            respond(res, 400, { error: "Body must be a JSON object" });
            return;
          }
          const { config } = getCtx();
          Object.assign(config, patch);
          respond(res, 200, { ok: true });
        } catch {
          respond(res, 400, { error: "Invalid JSON" });
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/cmd") {
      readBody(req, (err, body) => {
        if (err) { res.writeHead(400); res.end(); return; }
        const params = parseFormOrJson(body);
        const command = params.command as WorkerCommand;
        if (!command) { res.writeHead(400); res.end(); return; }
        const workerIdRaw = params.workerId;
        const workerId = workerIdRaw !== undefined ? parseInt(String(workerIdRaw)) : undefined;
        const { bus } = getCtx();
        const msg: ControllerMessage = { command, ...(workerId !== undefined ? { workerId } : {}) };
        if (workerId !== undefined) {
          bus.emit(`cmd:${workerId}`, msg);
        } else {
          bus.emit("cmd:all", msg);
        }
        res.writeHead(204); res.end();
      });
      return;
    }

    if (req.method === "POST" && req.url === "/spawn-all") {
      pool.spawnAll().then((result) => {
        respond(res, 200, result);
      }).catch((err) => {
        respond(res, 500, { error: String(err) });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/spawn") {
      readBody(req, async (err, body) => {
        if (err) { respond(res, 400, { error: "Failed to read body" }); return; }
        let opts: SpawnOptions = {};
        if (body.trim()) {
          try { opts = parseFormOrJson(body) as SpawnOptions; } catch { respond(res, 400, { error: "Invalid body" }); return; }
        }
        if (typeof opts.count === "string") opts.count = parseInt(opts.count);
        if (typeof opts.workerId === "string") opts.workerId = parseInt(opts.workerId);
        const result = await pool.spawn(opts);
        respond(res, 200, result);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/destroy") {
      readBody(req, async (err, body) => {
        if (err) { respond(res, 400, { error: "Failed to read body" }); return; }
        let workerId: number | undefined;
        try {
          const parsed = parseFormOrJson(body);
          workerId = typeof parsed.workerId === "string" ? parseInt(parsed.workerId) : parsed.workerId as number;
        } catch { respond(res, 400, { error: "Invalid body" }); return; }
        if (typeof workerId !== "number" || isNaN(workerId)) { respond(res, 400, { error: "workerId must be a number" }); return; }
        const result = await pool.destroy(workerId);
        respond(res, result.ok ? 200 : 404, result);
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(DASHBOARD_PORT, () => {
    console.log(`[dashboard] http://localhost:${DASHBOARD_PORT}`);
  });

  return server;
}

function buildTemplate(): string {
  const htmlPath = path.resolve(__dirname, "dashboard.html");
  return fs.readFileSync(htmlPath, "utf-8").replace("__WS_PORT__", String(WS_PORT));
}

function parseFormOrJson(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  return Object.fromEntries(new URLSearchParams(trimmed));
}

function readBody(req: http.IncomingMessage, cb: (err: Error | null, body: string) => void): void {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => cb(null, body));
  req.on("error", (err) => cb(err, ""));
}

function respond(res: http.ServerResponse, status: number, data: object): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
