import express from "express";
import pkg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { Pool } = pkg;

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MCP_VERSION = "1.0.1";
const MAX_SELECT_ROWS = Number(process.env.MAX_SELECT_ROWS || 500);
const SELECT_TIMEOUT_MS = Number(process.env.SELECT_TIMEOUT_MS || 30000);
const PORT = Number(process.env.PORT || 3002);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[pool] idle error:", err.message);
});

// ── Rate limiting ──────────────────────────────────────────────────────────────
const rateBuckets = new Map();

function checkRateLimit(key, maxPerMinute) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const bucket = (rateBuckets.get(key) || []).filter(t => t > windowStart);
  if (bucket.length >= maxPerMinute) return false;
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return true;
}

// ── SQL safety ─────────────────────────────────────────────────────────────────
function assertSelectSql(sql) {
  const s = sql.trim().toLowerCase();
  if (!s.startsWith("select") && !s.startsWith("with")) {
    throw new Error("Only SELECT or WITH (CTE) queries are allowed on this read-only connector.");
  }
  const forbidden = ["insert ", "update ", "delete ", "drop ", "truncate ", "alter ", "create ", "grant ", "revoke "];
  for (const kw of forbidden) {
    if (s.includes(kw)) throw new Error(`Forbidden keyword in read-only connector: ${kw.trim()}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function normalizeId(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 63);
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── MCP Server ─────────────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "VO2QNAPDBSR", version: MCP_VERSION });

  function tool(name, desc, schema, handler) {
    server.tool(name, desc, schema, async (args) => {
      try { return await handler(args || {}); }
      catch (e) { throw e; }
    });
  }

  // ── Connectivity ───────────────────────────────────────────────────────────
  tool("db_ping", "Test DB connection.", {}, async () => {
    const r = await pool.query("SELECT now() AS now, current_database() AS db");
    return ok({ ok: true, db: r.rows[0].db, now: r.rows[0].now, MCP_VERSION, readonly: true });
  });

  tool("rate_limit_guard", "Returns maxBatchSize. Call once at run start.", {}, async () => {
    return ok({ ok: true, maxBatchSize: 50, MAX_SELECT_ROWS, note: "read-only connector" });
  });

  // ── Schema discovery ───────────────────────────────────────────────────────
  tool("list_tables", "List all public tables.", {}, async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`
    );
    return ok({ tables: r.rows.map(x => x.table_name), count: r.rowCount });
  });

  tool("get_table_schema", "Get columns for a table.", { table: z.string() }, async ({ table }) => {
    const t = normalizeId(table);
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [t]
    );
    return ok({ table: t, columns: r.rows });
  });

  // ── Sports ─────────────────────────────────────────────────────────────────
  tool("sr_list_sports", "List active sports.", {}, async () => {
    const r = await pool.query(
      `SELECT "Guid" AS "Id", "SportName" AS "Name", lower("SportName") AS "NormalizedName", NOT "IsDeleted" AS "IsActive"
       FROM "Sports"
       WHERE "IsDeleted" = false
       ORDER BY "SportName"`
    );
    return ok({ sports: r.rows, count: r.rowCount });
  });

  // ── Matches ────────────────────────────────────────────────────────────────
  tool("sr_get_matches",
    "Finished matches from a sport table (e.g. FootballMatches, CyclingRaces). Filter by date range.",
    {
      matchTable: z.string(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ matchTable, dateFrom, dateTo, limit = 100, offset = 0 }) => {
      const t = normalizeId(matchTable);
      const effectiveLimit = Math.min(limit, MAX_SELECT_ROWS);
      const conditions = [`"Finished" = true`, `"Cancelled" = false`];
      const params = [];
      if (dateFrom) { params.push(dateFrom); conditions.push(`"StartTime" >= $${params.length}::date`); }
      if (dateTo)   { params.push(dateTo);   conditions.push(`"StartTime" <= $${params.length}::date`); }
      params.push(effectiveLimit, offset);
      const where = conditions.join(" AND ");
      const sql = `SELECT "Id","HomeTeamId","AwayTeamId","StartTime","Finished","Cancelled",
                          "ScoreHome","ScoreAway","LeagueId","Season","Round"
                   FROM "${t}"
                   WHERE ${where}
                   ORDER BY "StartTime" DESC
                   LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const client = await pool.connect();
      try {
        await client.query(`SET LOCAL statement_timeout = ${SELECT_TIMEOUT_MS}`);
        const r = await client.query(sql, params);
        return ok({ matchTable: t, rowCount: r.rowCount, rows: r.rows, offset, limit: effectiveLimit });
      } finally {
        client.release();
      }
    }
  );

  // ── Teams ──────────────────────────────────────────────────────────────────
  tool("sr_get_teams",
    "Teams from a sport table (e.g. FootballTeams). Optional leagueId filter.",
    {
      teamTable: z.string(),
      leagueId: z.number().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ teamTable, leagueId, limit = 200, offset = 0 }) => {
      const t = normalizeId(teamTable);
      const effectiveLimit = Math.min(limit, MAX_SELECT_ROWS);
      const params = [effectiveLimit, offset];
      const leagueFilter = leagueId ? `WHERE "LeagueId" = ${Number(leagueId)}` : "";
      const sql = `SELECT "Id","Name","ShortName","FullName","LeagueId","Overall","Rating","Level","CountryId","FoundedYear"
                   FROM "${t}" ${leagueFilter}
                   ORDER BY "Name"
                   LIMIT $1 OFFSET $2`;
      const client = await pool.connect();
      try {
        await client.query(`SET LOCAL statement_timeout = ${SELECT_TIMEOUT_MS}`);
        const r = await client.query(sql, params);
        return ok({ teamTable: t, rowCount: r.rowCount, rows: r.rows });
      } finally {
        client.release();
      }
    }
  );

  // ── Players ────────────────────────────────────────────────────────────────
  tool("sr_get_players",
    "Players from a sport table (e.g. FootballPlayers, MmaFighters). Optional teamId filter via TeamPlayers join.",
    {
      playerTable: z.string(),
      teamId: z.number().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ playerTable, teamId, limit = 200, offset = 0 }) => {
      const t = normalizeId(playerTable);
      const tp = t.replace("Players", "TeamPlayers");
      const effectiveLimit = Math.min(limit, MAX_SELECT_ROWS);
      let sql, params;
      if (teamId) {
        params = [Number(teamId), effectiveLimit, offset];
        sql = `SELECT p."Id", p."FirstName", p."LastName", p."PositionText", p."Rating",
                      p."Nationality", p."BirthDate", p."ShirtNumber", p."HeightCm"
               FROM "${t}" p
               JOIN "${tp}" tp ON tp."PlayerId" = p."Id"
               WHERE tp."TeamId" = $1
               ORDER BY p."LastName"
               LIMIT $2 OFFSET $3`;
      } else {
        params = [effectiveLimit, offset];
        sql = `SELECT "Id","FirstName","LastName","PositionText","Rating","Nationality","BirthDate","ShirtNumber","HeightCm"
               FROM "${t}"
               ORDER BY "LastName"
               LIMIT $1 OFFSET $2`;
      }
      const client = await pool.connect();
      try {
        await client.query(`SET LOCAL statement_timeout = ${SELECT_TIMEOUT_MS}`);
        const r = await client.query(sql, params);
        return ok({ playerTable: t, rowCount: r.rowCount, rows: r.rows });
      } finally {
        client.release();
      }
    }
  );

  // ── Leagues ────────────────────────────────────────────────────────────────
  tool("sr_get_leagues",
    "Leagues from a sport table (e.g. FootballLeagues). Optional countryId filter.",
    {
      leagueTable: z.string(),
      countryId: z.number().optional(),
      limit: z.number().optional(),
    },
    async ({ leagueTable, countryId, limit = 200 }) => {
      const t = normalizeId(leagueTable);
      const effectiveLimit = Math.min(limit, MAX_SELECT_ROWS);
      const params = [effectiveLimit];
      const countryFilter = countryId ? `AND "CountryId" = ${Number(countryId)}` : "";
      const sql = `SELECT "Id","Name","CountryId","Confederation","NumberOfTeams","CurrentChampion","FoundedYear"
                   FROM "${t}"
                   WHERE 1=1 ${countryFilter}
                   ORDER BY "Name"
                   LIMIT $1`;
      const r = await pool.query(sql, params);
      return ok({ leagueTable: t, rowCount: r.rowCount, rows: r.rows });
    }
  );

  // ── League seasons ─────────────────────────────────────────────────────────
  tool("sr_get_league_seasons",
    "League seasons. Optional leagueId filter, currentOnly flag.",
    {
      leagueId: z.number().optional(),
      currentOnly: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ leagueId, currentOnly = false, limit = 100 }) => {
      const effectiveLimit = Math.min(limit, MAX_SELECT_ROWS);
      const conditions = [];
      const params = [effectiveLimit];
      if (leagueId) { params.push(Number(leagueId)); conditions.push(`"LeagueId" = $${params.length}`); }
      if (currentOnly) conditions.push(`"IsCurrent" = true`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT "Id","LeagueId","SeasonLabel","StartYear","EndYear","IsCurrent","IsDone"
                   FROM "LeagueSeasons"
                   ${where}
                   ORDER BY "StartYear" DESC
                   LIMIT $1`;
      const r = await pool.query(sql, params);
      return ok({ rowCount: r.rowCount, rows: r.rows });
    }
  );

  // ── Generic read-only SQL ──────────────────────────────────────────────────
  tool("run_select_sql",
    `SELECT only. Max ${MAX_SELECT_ROWS} rows. Always LIMIT. Never SELECT *.`,
    { sql: z.string(), limit: z.number().optional() },
    async ({ sql, limit }) => {
      assertSelectSql(sql);
      if (!checkRateLimit("select_sql", 60)) throw new Error("Rate limit: max 60 SELECT queries/minute.");
      const effectiveLimit = Math.min(limit ?? MAX_SELECT_ROWS, MAX_SELECT_ROWS);
      const hasLimit = /\blimit\b/i.test(sql);
      const safeSql = hasLimit ? sql : `${sql.trimEnd().replace(/;$/, "")} LIMIT ${effectiveLimit}`;
      const client = await pool.connect();
      try {
        await client.query(`SET LOCAL statement_timeout = ${SELECT_TIMEOUT_MS}`);
        await client.query(`SET LOCAL work_mem = '64MB'`);
        const r = await client.query(safeSql);
        return ok({ rowCount: r.rowCount, rows: r.rows });
      } catch (e) {
        throw e;
      } finally {
        client.release();
      }
    }
  );

  return server;
}

// ── Express + auth ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "4mb" }));

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: MCP_VERSION, connector: "VO2QNAPDBSR", readonly: true });
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[VO2QNAPDBSR] SportReal read-only MCP v${MCP_VERSION} listening on :${PORT}`);
});
