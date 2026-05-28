import fs from "fs";
import path from "path";
import express from "express";
import http from "http";
import crypto from "crypto";
import { Metrics } from "./metrics";
import { SaleState } from "./state";

interface DemoConfig {
  port: number;
  ticketCount: number;
  saleOpenTime: string;
}

const cfg: DemoConfig = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../config.json"), "utf-8")
);

const PORT = cfg.port ?? 4000;
const TICKETS = cfg.ticketCount ?? 10;
const QUEUE_DRAIN_MS = 800;
const saleOpenTime = new Date(cfg.saleOpenTime);

const app = express();
const server = http.createServer(app);
const metrics = new Metrics();
const sale = new SaleState(TICKETS);

app.use(express.urlencoded({ extended: false }));

function sessionId(req: express.Request, res: express.Response): string {
  const existing = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (existing) return existing;
  const id = crypto.randomBytes(8).toString("hex");
  res.setHeader("Set-Cookie", `sid=${id}; Path=/; HttpOnly`);
  return id;
}

app.use((req, res, next) => {
  const sid = sessionId(req, res);
  metrics.recordRequest(sid);
  (req as any).sid = sid;
  next();
});

app.get("/", (req, res) => {
  const sid = (req as any).sid as string;
  metrics.setSessionState(sid, "landing");

  if (sale.phase === "active") return res.redirect("/sale");
  if (sale.phase === "queue") return res.redirect("/queue");
  if (sale.phase === "soldout") return res.redirect("/sold-out");

  res.send(landingPage());
});

app.get("/queue", (req, res) => {
  const sid = (req as any).sid as string;
  if (sale.phase === "presale") return res.redirect("/");
  if (sale.phase === "active") return res.redirect("/sale");
  if (sale.phase === "soldout") return res.redirect("/sold-out");

  const session = sale.getOrCreateSession(sid);
  metrics.setSessionState(sid, "queue");
  res.send(queuePage(session.queuePosition));
});

app.get("/sale", (req, res) => {
  const sid = (req as any).sid as string;
  if (sale.phase === "soldout") return res.redirect("/sold-out");
  if (sale.phase !== "active") return res.redirect("/");

  metrics.setSessionState(sid, "sale");
  res.send(salePage(sale.remaining));
});

app.post("/buy", (req, res) => {
  const sid = (req as any).sid as string;
  metrics.recordClick(sid);

  const result = sale.tryBuy(sid);
  if (result === "ok") {
    metrics.recordCheckout(sid);
    metrics.setSessionState(sid, "checkout");
    return res.redirect("/checkout");
  }
  if (result === "soldout") return res.redirect("/sold-out");
  return res.redirect("/sale");
});

app.get("/checkout", (req, res) => {
  const sid = (req as any).sid as string;
  metrics.setSessionState(sid, "checkout");
  res.send(checkoutPage());
});

app.get("/sold-out", (req, res) => {
  const sid = (req as any).sid as string;
  metrics.setSessionState(sid, "soldout");
  res.send(soldOutPage());
});

app.post("/admin/open-queue", (_req, res) => {
  sale.openQueue();
  res.json({ ok: true, phase: sale.phase });
});

app.post("/admin/open-sale", (_req, res) => {
  sale.openSale();
  metrics.recordSaleOpen();
  res.json({ ok: true, phase: sale.phase });
});

app.get("/admin/phase", (_req, res) => {
  res.json({ phase: sale.phase, remaining: sale.remaining });
});

setInterval(() => {
  const s = metrics.snapshot();
  const stateStr = Object.entries(s.stateCounts)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  process.stdout.write(
    `\r[${s.uptimeS}s] rps:${s.rps} cps:${s.cps} peak:${s.peakRps} sessions:${s.sessions} checkouts:${s.checkouts}${s.firstCheckoutMs !== null ? ` first:${s.firstCheckoutMs}ms` : ""} | ${stateStr}   `
  );
}, 1000);

scheduleSaleOpen(saleOpenTime);

server.listen(PORT, () => {
  console.log(`\n[demo] ticket site running at http://localhost:${PORT}`);
  console.log(`[demo] ${TICKETS} tickets available`);
  console.log(`[demo] sale opens at ${saleOpenTime.toLocaleString()} (${msUntil(saleOpenTime)}ms from now)`);
  console.log(`[demo] manual override:`);
  console.log(`  curl -X POST http://localhost:${PORT}/admin/open-queue`);
  console.log(`  curl -X POST http://localhost:${PORT}/admin/open-sale\n`);
});

function msUntil(t: Date): number {
  return Math.max(0, t.getTime() - Date.now());
}

function scheduleSaleOpen(t: Date): void {
  const ms = t.getTime() - Date.now();
  if (ms <= 0) {
    sale.openSale();
    metrics.recordSaleOpen();
    console.log("[demo] sale open time already passed — opening immediately");
    return;
  }

  const queueMs = Math.max(0, ms - 5_000);
  setTimeout(() => {
    sale.openQueue();
    console.log("[demo] queue opened (T-5s)");
  }, queueMs);

  const poll = setInterval(() => {
    if (Date.now() >= t.getTime()) {
      clearInterval(poll);
      sale.openSale();
      metrics.recordSaleOpen();
      console.log("\n[demo] SALE IS LIVE");
    }
  }, 50);
}

function landingPage() {
  return html(`
    <div class="hero">
      <div class="tag">WORLD TOUR</div>
      <h1>BTS</h1>
      <div class="sub">ARIRANG</div>
      <div class="venue">Gelora Bung Karno · Jakarta</div>
      <div class="date">December 26, 2026</div>
      <div class="status-box">
        <div class="dot pulse"></div>
        <span>Ticket sale opens soon</span>
      </div>
      <div class="countdown" id="cd"></div>
      <p class="note">Stay on this page. You will be redirected automatically when the queue opens.</p>
    </div>
    <script>
      const openAt = ${saleOpenTime.getTime()};
      function tick() {
        const diff = openAt - Date.now();
        if (diff <= 0) { location.reload(); return; }
        const s = Math.floor(diff / 1000);
        const ms = diff % 1000;
        document.getElementById('cd').textContent =
          s > 60 ? Math.floor(s/60) + 'm ' + (s%60) + 's' : s + '.' + String(ms).padStart(3,'0').slice(0,1) + 's';
        setTimeout(tick, diff > 5000 ? 500 : 50);
      }
      tick();
    </script>
  `);
}

function queuePage(position: number) {
  return html(`
    <div class="hero">
      <div class="tag">VIRTUAL QUEUE</div>
      <h1>You're in line</h1>
      <div class="queue-pos">#${position.toLocaleString()}</div>
      <p class="note">Please wait. Do not close this tab.<br/>You will be moved forward automatically.</p>
      <div class="progress-bar"><div class="progress-fill" id="fill"></div></div>
    </div>
    <script>
      setTimeout(() => location.reload(), 2500);
    </script>
  `);
}

function salePage(remaining: number) {
  return html(`
    <div class="hero">
      <div class="tag live">● LIVE NOW</div>
      <h1>BTS ARIRANG</h1>
      <div class="venue">Jakarta · Dec 26, 2026</div>
      <div class="remaining">${remaining} ticket${remaining !== 1 ? "s" : ""} remaining</div>
      <form method="POST" action="/buy">
        <button type="submit" class="buy-btn">Buy Now</button>
      </form>
      <p class="note">Tickets are limited. First come, first served.</p>
    </div>
  `);
}

function checkoutPage() {
  return html(`
    <div class="hero">
      <div class="tag success">✓ SUCCESS</div>
      <h1>You got a ticket!</h1>
      <div class="sub">Order confirmed</div>
      <p class="note">BTS ARIRANG · Jakarta · Dec 26, 2026<br/>Check your email for confirmation.</p>
    </div>
  `);
}

function soldOutPage() {
  return html(`
    <div class="hero">
      <div class="tag sold">SOLD OUT</div>
      <h1>All tickets sold</h1>
      <p class="note">All available tickets have been claimed.</p>
    </div>
  `);
}

function html(body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BTS ARIRANG — Tickets</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background: #08080e;
    color: #f0f0f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .hero {
    text-align: center;
    max-width: 480px;
    width: 100%;
  }
  .tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 3px;
    color: #888;
    border: 1px solid #333;
    padding: 4px 12px;
    border-radius: 20px;
    margin-bottom: 20px;
    text-transform: uppercase;
  }
  .tag.live { color: #ff4d4d; border-color: #ff4d4d; }
  .tag.success { color: #00cc66; border-color: #00cc66; }
  .tag.sold { color: #ff4d4d; border-color: #ff4d4d; }
  h1 {
    font-size: clamp(40px, 10vw, 80px);
    font-weight: 900;
    letter-spacing: -2px;
    line-height: 1;
    color: #fff;
    margin-bottom: 6px;
  }
  .sub {
    font-size: 18px;
    letter-spacing: 8px;
    color: #666;
    margin-bottom: 16px;
  }
  .venue { color: #aaa; font-size: 14px; margin-bottom: 4px; }
  .date { color: #666; font-size: 13px; margin-bottom: 28px; }
  .status-box {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #111;
    border: 1px solid #222;
    padding: 10px 20px;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: 14px;
    color: #ccc;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #f0a500;
  }
  .dot.pulse { animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .queue-pos {
    font-size: 72px;
    font-weight: 900;
    color: #f0a500;
    letter-spacing: -3px;
    margin: 16px 0;
  }
  .remaining {
    font-size: 16px;
    color: #ff6b6b;
    font-weight: 600;
    margin-bottom: 24px;
  }
  .buy-btn {
    background: #fff;
    color: #000;
    border: none;
    padding: 16px 48px;
    font-size: 17px;
    font-weight: 800;
    letter-spacing: 1px;
    border-radius: 6px;
    cursor: pointer;
    width: 100%;
    max-width: 300px;
    transition: background 0.15s, transform 0.1s;
  }
  .buy-btn:hover { background: #eee; }
  .buy-btn:active { transform: scale(0.98); }
  .note {
    margin-top: 20px;
    font-size: 13px;
    color: #555;
    line-height: 1.6;
  }
  .progress-bar {
    height: 3px;
    background: #1a1a1a;
    border-radius: 2px;
    margin-top: 24px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: #f0a500;
    width: 60%;
    animation: slide 2s linear infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
  }
  .countdown {
    font-size: 13px;
    color: #444;
    margin-top: 8px;
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
