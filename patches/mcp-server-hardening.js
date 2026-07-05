/**
 * MCP Server Hardening — patch pro server.js
 * Řeší: Node.js event loop freeze způsobený 30+ souběžnými agenty
 *
 * JAK APLIKOVAT (když QNAP SSH pojede):
 * 1. Otevřít /share/Container/mcp-qnap/server.js
 * 2. Vložit SEKCI A na začátek (po const declarations, před app.use(express.json()))
 * 3. Vložit SEKCI B před první app.use(auth middleware)
 * 4. Vložit SEKCI C za app.listen(...)
 * 5. docker compose up --build -d
 */

// ═══════════════════════════════════════════════════════
// SEKCE A — vložit za: const app = express();
// ═══════════════════════════════════════════════════════

const CONCURRENCY_LIMIT = parseInt(process.env.MCP_CONCURRENCY || "15");
const REQUEST_TIMEOUT_MS = parseInt(process.env.MCP_REQUEST_TIMEOUT || "30000");

let activeRequests = 0;

// ═══════════════════════════════════════════════════════
// SEKCE B — vložit jako první app.use() (před auth):
// ═══════════════════════════════════════════════════════

// Health endpoint — veřejný, bez auth (Docker healthcheck + mcp-router)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    activeRequests,
    concurrencyLimit: CONCURRENCY_LIMIT,
    uptime: Math.floor(process.uptime()),
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// Request timeout — zruší požadavek po 30s (zabrání blokování event loop)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: "request_timeout", after_ms: REQUEST_TIMEOUT_MS });
    }
  }, REQUEST_TIMEOUT_MS);
  res.on("finish", () => clearTimeout(timer));
  res.on("close", () => clearTimeout(timer));
  next();
});

// Concurrency limiter — zamítne požadavek když je >15 aktivních
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (activeRequests >= CONCURRENCY_LIMIT) {
    return res.status(429).json({
      error: "too_many_requests",
      active: activeRequests,
      limit: CONCURRENCY_LIMIT,
      retry_after_ms: 5000,
    });
  }
  activeRequests++;
  const done = () => { activeRequests = Math.max(0, activeRequests - 1); };
  res.on("finish", done);
  res.on("close", done);
  next();
});

// ═══════════════════════════════════════════════════════
// SEKCE C — vložit za app.listen(...):
// ═══════════════════════════════════════════════════════

// Graceful uncaught exception handler — zabrání padnutí celého procesu
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err.message);
  // Neukončovat — pouze logovat; Docker healthcheck restartuje pokud je potřeba
});

process.on("unhandledRejection", (reason) => {
  console.error("[WARN] unhandledRejection:", reason);
});

// Pravidelný log zdraví (každých 5 minut) — viditelný v docker logs
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[HEALTH] uptime=${Math.floor(process.uptime())}s active=${activeRequests} rss=${Math.round(mem.rss/1024/1024)}MB`);
}, 5 * 60 * 1000);
