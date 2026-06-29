/**
 * mcp-usm.js — UniSportManager Image Storage MCP
 * Receives a pre-generated image (base64 or URL) and assigns it to a USM entity.
 * Version: 1.0.0
 * DB: sportManager
 * Port: 3006
 *
 * Supported entity types:
 *   Teams  — saves to LogoUrl column (added if missing)
 *   Players — saves to PhotoUrl column (added if missing)
 *
 * Primary use case: bot teams (IsBot=true) need logos,
 *                   bot players (IsBot=true) need portrait photos.
 */
import express from "express";
import pkg from "pg";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { Pool } = pkg;

const PORT = Number(process.env.PORT || 3006);
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/app/uploads";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const MCP_VERSION = "9.4.1";
const NTFY_BASE_URL = process.env.NTFY_URL || "https://ntfy.vo2info.cz";
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASS = process.env.NTFY_PASS || "";

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

const metrics = {
  startedAt: new Date().toISOString(),
  saved: 0,
  failed: 0,
  requests: 0,
};

// ─── Column setup ─────────────────────────────────────────────────────────────
async function ensureImageColumns() {
  await pool.query(`ALTER TABLE "Teams"   ADD COLUMN IF NOT EXISTS "LogoUrl"  text NULL`);
  await pool.query(`ALTER TABLE "Players" ADD COLUMN IF NOT EXISTS "PhotoUrl" text NULL`);
  console.log("LogoUrl on Teams and PhotoUrl on Players ensured");
}

// ─── Image helpers ────────────────────────────────────────────────────────────
function isDataUrl(v) {
  return typeof v === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(v);
}

function mimeToExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("webp")) return "webp";
  if (m.includes("png"))  return "png";
  if (m.includes("gif"))  return "gif";
  return "jpg";
}

async function saveBase64(base64Input, folder, guid) {
  let rawBase64 = base64Input;
  let ext = "jpg";
  if (isDataUrl(base64Input)) {
    const match = base64Input.match(/^data:image\/(\w+);base64,(.+)$/i);
    if (match) { ext = mimeToExt(match[1]); rawBase64 = match[2]; }
  }
  const buffer = Buffer.from(rawBase64, "base64");
  const fileName = `${guid}.${ext}`;
  await fs.writeFile(path.join(folder, fileName), buffer);
  return { fileName, sizeBytes: buffer.length };
}

async function saveUrl(imageUrl, folder, guid) {
  const res = await fetch(imageUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const ext = mimeToExt(res.headers.get("content-type") || "image/jpeg");
  const buffer = Buffer.from(await res.arrayBuffer());
  const fileName = `${guid}.${ext}`;
  await fs.writeFile(path.join(folder, fileName), buffer);
  return { fileName, sizeBytes: buffer.length };
}

function buildPublicUrl(subFolder, fileName) {
  return PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL.replace(/\/$/, "")}/${subFolder}/${fileName}`
    : `/${subFolder}/${fileName}`;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

// ─── Google Sheets / Drive helpers ────────────────────────────────────────────
import crypto from "crypto";

let _sheetsToken = null;
let _sheetsTokenExpiry = 0;

async function getSheetsToken() {
  if (_sheetsToken && Date.now() < _sheetsTokenExpiry - 60_000) return _sheetsToken;
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured — Sheets API unavailable");
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })).toString("base64url");
  const sign = crypto.createSign("SHA256");
  sign.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${sign.sign(sa.private_key, "base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`);
  const d = await res.json();
  _sheetsToken = d.access_token;
  _sheetsTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000;
  return _sheetsToken;
}

async function sheetsGet(path) {
  const token = await getSheetsToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sheetsPost(path, body) {
  const token = await getSheetsToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sheetsPut(path, body) {
  const token = await getSheetsToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function drivePatch(fileId, params) {
  const token = await getSheetsToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?${qs}&fields=id,parents`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Agent Catalog Sheets Sync ──────────────────────────────────────────────────
const SHEETS_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LOCAL_SHEETS_DIR = path.join(UPLOAD_DIR, "sheets");
const DEFAULT_CATALOG_SHEETS = ["Entities", "Names", "Urls", "Errors"];
const ENTITY_TYPE_MAP = { Entities: "entity", Names: "name", Urls: "url", Errors: "error" };

async function syncAgentCatalogSheets() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  if (!monPool) return;

  try { await monPool.query(`SELECT 1 FROM "AgentCatalog" LIMIT 1`); } catch { return; }

  const result = await monPool.query(
    `SELECT "Name", "SpreadsheetId", "Sheets" FROM "AgentCatalog" WHERE "SpreadsheetId" IS NOT NULL AND "IsActive" = TRUE`
  );
  let synced = 0, errors = 0;

  for (const agent of result.rows) {
    const sheetNames = agent.Sheets
      ? agent.Sheets.split(",").map(s => s.trim()).filter(Boolean)
      : DEFAULT_CATALOG_SHEETS;
    const dir = path.join(LOCAL_SHEETS_DIR, agent.Name);
    await fs.mkdir(dir, { recursive: true });

    for (const sheetName of sheetNames) {
      try {
        const data = await sheetsGet(`spreadsheets/${agent.SpreadsheetId}/values/${encodeURIComponent(sheetName)}`);
        const values = data.values ?? [];
        await fs.writeFile(
          path.join(dir, `${sheetName}.json`),
          JSON.stringify({ syncedAt: new Date().toISOString(), agentName: agent.Name, sheet: sheetName, rowCount: values.length, values }, null, 2)
        );
        const entityType = ENTITY_TYPE_MAP[sheetName];
        if (entityType && values.length > 1) {
          for (const row of values.slice(1)) {
            const value = String(row[0] ?? "").trim();
            if (!value) continue;
            await monPool.query(
              `INSERT INTO agent_entities (agent_name, entity_type, value, updated_at)
               VALUES ($1,$2,$3,NOW())
               ON CONFLICT (agent_name, entity_type, value)
               DO UPDATE SET updated_at=NOW(), active=TRUE`,
              [agent.Name, entityType, value]
            ).catch(() => {});
          }
        }
        synced++;
      } catch (e) {
        console.error(`[sheets-sync] ${agent.Name}/${sheetName}: ${e.message}`);
        errors++;
      }
    }
    await monPool.query(`UPDATE "AgentCatalog" SET "LastSyncedAt" = NOW() WHERE "Name" = $1`, [agent.Name]).catch(() => {});
  }
  console.log(`[sheets-sync] ${result.rows.length} agents, ${synced} sheets OK, ${errors} errors`);
}

function startSheetsSyncLoop() {
  setTimeout(async () => {
    await syncAgentCatalogSheets().catch(e => console.error("[sheets-sync] Startup sync failed:", e.message));
    setInterval(
      () => syncAgentCatalogSheets().catch(e => console.error("[sheets-sync] Periodic sync failed:", e.message)),
      SHEETS_SYNC_INTERVAL_MS
    );
  }, 30_000);
}

// ─── Monitoring pool (AgentMonitor DB) ────────────────────────────────────────
const AGENT_MONITOR_URL = process.env.AGENT_MONITOR_URL;
const monPool = AGENT_MONITOR_URL ? new Pool({
  connectionString: AGENT_MONITOR_URL,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
}) : null;
if (!AGENT_MONITOR_URL) console.warn("[monPool] AGENT_MONITOR_URL not set — monitoring tools disabled");

// ─── SMTP config ──────────────────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "";
const EMAIL_DEFAULT_TO = process.env.EMAIL_DEFAULT_TO || "";

function createMcpServer() {
  const server = new McpServer({ name: "USM-Image-MCP", version: MCP_VERSION });

  function wrap(name, desc, schema, fn) {
    server.tool(name, desc, schema, async (args) => {
      metrics.requests++;
      try {
        return { content: [{ type: "text", text: JSON.stringify(await fn(args || {}), null, 2) }] };
      } catch (e) {
        metrics.failed++;
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
      }
    });
  }

  // Coverage stats
  wrap("get_stats", "Image coverage stats: how many bot teams/players have logos/photos.", {}, async () => {
    const teamTotal   = await pool.query(`SELECT COUNT(*)::int AS n FROM "Teams" WHERE "IsBot"=true AND "IsActive"=true`);
    const teamMissing = await pool.query(`SELECT COUNT(*)::int AS n FROM "Teams" WHERE "IsBot"=true AND "IsActive"=true AND ("LogoUrl" IS NULL OR "LogoUrl"='')`);
    const plTotal     = await pool.query(`SELECT COUNT(*)::int AS n FROM "Players" WHERE "IsBot"=true AND "IsActive"=true`);
    const plMissing   = await pool.query(`SELECT COUNT(*)::int AS n FROM "Players" WHERE "IsBot"=true AND "IsActive"=true AND ("PhotoUrl" IS NULL OR "PhotoUrl"='')`);
    return {
      botTeams:   { total: teamTotal.rows[0].n, missing: teamMissing.rows[0].n, covered: teamTotal.rows[0].n - teamMissing.rows[0].n },
      botPlayers: { total: plTotal.rows[0].n,   missing: plMissing.rows[0].n,   covered: plTotal.rows[0].n - plMissing.rows[0].n },
      metrics,
    };
  });

  // List bot teams without logos
  wrap("list_bot_teams_without_logos", "List bot teams that have no logo assigned yet.", {
    limit: z.number().optional(),
  }, async ({ limit = 100 }) => {
    const r = await pool.query(
      `SELECT "Guid", "Name", "Code3", "Stadium", "BotProfile", "BotSkill"
       FROM "Teams"
       WHERE "IsBot"=true AND "IsActive"=true AND ("LogoUrl" IS NULL OR "LogoUrl"='')
       ORDER BY "Name"
       LIMIT $1`,
      [Math.min(limit, 500)]
    );
    return { count: r.rowCount, teams: r.rows };
  });

  // List bot players without photos
  wrap("list_bot_players_without_photos", "List bot players that have no photo assigned yet.", {
    limit: z.number().optional(),
  }, async ({ limit = 100 }) => {
    const r = await pool.query(
      `SELECT "Guid", "FullName", "Forename", "Surname", "Position", "BotArchetype"
       FROM "Players"
       WHERE "IsBot"=true AND "IsActive"=true AND ("PhotoUrl" IS NULL OR "PhotoUrl"='')
       ORDER BY "FullName"
       LIMIT $1`,
      [Math.min(limit, 500)]
    );
    return { count: r.rowCount, players: r.rows };
  });

  // Assign logo to a team
  wrap("assign_team_logo", "Assign a pre-generated logo (base64 or URL) to a team. Saves file and updates LogoUrl in Teams.", {
    guid:     z.string().describe("Team Guid (UUID)"),
    image:    z.string().describe("Image as base64 (with or without data: prefix) OR https:// URL"),
    meta:     z.string().optional().describe("Optional note about the image source/generation"),
  }, async ({ guid, image, meta }) => {
    const folder = path.join(UPLOAD_DIR, "team-logos");
    await fs.mkdir(folder, { recursive: true });

    const isUrl = /^https?:\/\//i.test(image);
    const { fileName, sizeBytes } = isUrl
      ? await saveUrl(image, folder, guid)
      : await saveBase64(image, folder, guid);

    const publicUrl = buildPublicUrl("team-logos", fileName);

    await pool.query(
      `UPDATE "Teams" SET "LogoUrl"=$1, "UpdatedAt"=now() WHERE "Guid"=$2`,
      [publicUrl, guid]
    );

    metrics.saved++;
    return { ok: true, guid, publicUrl, sizeBytes, meta: meta || null };
  });

  // Assign photo to a player
  wrap("assign_player_photo", "Assign a pre-generated portrait photo (base64 or URL) to a player. Saves file and updates PhotoUrl in Players.", {
    guid:     z.string().describe("Player Guid (UUID)"),
    image:    z.string().describe("Image as base64 (with or without data: prefix) OR https:// URL"),
    meta:     z.string().optional(),
  }, async ({ guid, image, meta }) => {
    const folder = path.join(UPLOAD_DIR, "player-photos");
    await fs.mkdir(folder, { recursive: true });

    const isUrl = /^https?:\/\//i.test(image);
    const { fileName, sizeBytes } = isUrl
      ? await saveUrl(image, folder, guid)
      : await saveBase64(image, folder, guid);

    const publicUrl = buildPublicUrl("player-photos", fileName);

    await pool.query(
      `UPDATE "Players" SET "PhotoUrl"=$1, "UpdatedAt"=now() WHERE "Guid"=$2`,
      [publicUrl, guid]
    );

    metrics.saved++;
    return { ok: true, guid, publicUrl, sizeBytes, meta: meta || null };
  });

  // Get team info
  wrap("get_team_info", "Get current info for a team (name, bot profile, logo status).", {
    guid: z.string(),
  }, async ({ guid }) => {
    const r = await pool.query(
      `SELECT "Guid", "Name", "Code3", "Stadium", "IsBot", "BotProfile", "BotSkill", "LogoUrl", "IsActive"
       FROM "Teams" WHERE "Guid"=$1`,
      [guid]
    );
    if (!r.rowCount) return { error: "Team not found" };
    return r.rows[0];
  });

  // Get player info
  wrap("get_player_info", "Get current info for a player (name, position, bot archetype, photo status).", {
    guid: z.string(),
  }, async ({ guid }) => {
    const r = await pool.query(
      `SELECT "Guid", "FullName", "Forename", "Surname", "Position", "IsBot", "BotArchetype", "PhotoUrl", "IsActive"
       FROM "Players" WHERE "Guid"=$1`,
      [guid]
    );
    if (!r.rowCount) return { error: "Player not found" };
    return r.rows[0];
  });

  // Search bot team by name
  wrap("search_team", "Search for a bot team by name (partial match). Useful to find Guid before assigning logo.", {
    name:  z.string().describe("Partial team name (case-insensitive)"),
    limit: z.number().optional(),
  }, async ({ name, limit = 10 }) => {
    const r = await pool.query(
      `SELECT "Guid", "Name", "Code3", "Stadium", "BotProfile", "LogoUrl"
       FROM "Teams"
       WHERE "IsBot"=true AND LOWER("Name") LIKE LOWER($1)
       ORDER BY "Name" LIMIT $2`,
      [`%${name}%`, Math.min(limit, 50)]
    );
    return { count: r.rowCount, teams: r.rows };
  });

  // Search bot player by name
  wrap("search_player", "Search for a bot player by name (partial match). Useful to find Guid before assigning photo.", {
    name:  z.string().describe("Partial player name (case-insensitive)"),
    limit: z.number().optional(),
  }, async ({ name, limit = 10 }) => {
    const r = await pool.query(
      `SELECT "Guid", "FullName", "Position", "BotArchetype", "PhotoUrl"
       FROM "Players"
       WHERE "IsBot"=true AND LOWER("FullName") LIKE LOWER($1)
       ORDER BY "FullName" LIMIT $2`,
      [`%${name}%`, Math.min(limit, 50)]
    );
    return { count: r.rowCount, players: r.rows };
  });

  // List bot teams that already HAVE a logo (verification)
  wrap("list_teams_with_logos", "List bot teams that already have a logo assigned (for review/verification).", {
    limit: z.number().optional(),
  }, async ({ limit = 50 }) => {
    const r = await pool.query(
      `SELECT "Guid", "Name", "Code3", "LogoUrl" FROM "Teams"
       WHERE "IsBot"=true AND "IsActive"=true AND "LogoUrl" IS NOT NULL AND "LogoUrl" != ''
       ORDER BY "UpdatedAt" DESC LIMIT $1`,
      [Math.min(limit, 200)]
    );
    return { count: r.rowCount, teams: r.rows };
  });

  // List bot players that already HAVE a photo (verification)
  wrap("list_players_with_photos", "List bot players that already have a photo assigned (for review/verification).", {
    limit: z.number().optional(),
  }, async ({ limit = 50 }) => {
    const r = await pool.query(
      `SELECT "Guid", "FullName", "Position", "PhotoUrl" FROM "Players"
       WHERE "IsBot"=true AND "IsActive"=true AND "PhotoUrl" IS NOT NULL AND "PhotoUrl" != ''
       ORDER BY "UpdatedAt" DESC LIMIT $1`,
      [Math.min(limit, 200)]
    );
    return { count: r.rowCount, players: r.rows };
  });

  // Clear/reset team logo (error recovery)
  wrap("clear_team_logo", "Remove the assigned logo from a team (sets LogoUrl to NULL). Use to correct wrong assignments.", {
    guid: z.string(),
  }, async ({ guid }) => {
    await pool.query(`UPDATE "Teams" SET "LogoUrl" = NULL WHERE "Guid" = $1`, [guid]);
    return { ok: true, guid, cleared: "LogoUrl" };
  });

  // Clear/reset player photo (error recovery)
  wrap("clear_player_photo", "Remove the assigned photo from a player (sets PhotoUrl to NULL). Use to correct wrong assignments.", {
    guid: z.string(),
  }, async ({ guid }) => {
    await pool.query(`UPDATE "Players" SET "PhotoUrl" = NULL WHERE "Guid" = $1`, [guid]);
    return { ok: true, guid, cleared: "PhotoUrl" };
  });

  // List available sports (for filtering teams by sport)
  wrap("list_sports", "List all available sports in the database. Use SportId to filter teams by sport.", {}, async () => {
    const r = await pool.query(`SELECT "Guid", "Name", "Discriminator" FROM "Sports" ORDER BY "Name"`);
    return { count: r.rowCount, sports: r.rows };
  });

  // DB ping as MCP tool
  wrap("db_ping", "Verify database connectivity. Call before starting a batch to ensure DB is reachable.", {}, async () => {
    const r = await pool.query("SELECT now() AS now");
    return { ok: true, db: "UniSportManager", version: MCP_VERSION, now: r.rows[0].now, uptime: process.uptime() };
  });

  wrap("send_notification", "Send a notification to ntfy.vo2info.cz.", {
    topic:    z.enum(["agent-runs", "agent-errors", "agent-alerts", "agent-maintenance", "agent-digest"]),
    title:    z.string(),
    message:  z.string(),
    priority: z.enum(["min", "low", "default", "high", "urgent"]).optional(),
    tags:     z.array(z.string()).optional(),
  }, async ({ topic, title, message, priority = "default", tags = [] }) => {
    const ntfyUrl = `${NTFY_BASE_URL}/${topic}`;
    const body = message;
    const headers = { "Content-Type": "text/plain; charset=utf-8" };
    headers["Title"] = title;
    headers["Priority"] = priority;
    if (tags && tags.length > 0) headers["Tags"] = tags.join(",");
    if (NTFY_USER && NTFY_PASS) {
      headers["Authorization"] = "Basic " + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString("base64");
    }
    let status, responseText;
    try {
      const res = await fetch(ntfyUrl, { method: "POST", headers, body });
      status = res.status;
      responseText = await res.text();
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }] };
    }
    const ok = status >= 200 && status < 300;
    return { content: [{ type: "text", text: JSON.stringify({ ok, status, topic, title, response: responseText }) }] };
  });

  wrap("sheets_get_values", "Read all rows from a Google Sheet. Row 0 is the header.", {
    spreadsheetId: z.string(),
    range:         z.string().optional(),
  }, async ({ spreadsheetId, range = "Sheet1" }) => {
    const data = await sheetsGet(`spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    const values = data.values || [];
    return { spreadsheetId, range, rowCount: values.length, values };
  });

  wrap("sheets_append_rows", "Append one or more rows to a Google Sheet. Each row is an array of cell strings.", {
    spreadsheetId: z.string(),
    range:         z.string().optional(),
    rows:          z.array(z.array(z.string())),
  }, async ({ spreadsheetId, range = "Sheet1", rows }) => {
    const data = await sheetsPost(
      `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: rows }
    );
    return { ok: true, updatedRows: data.updates?.updatedRows ?? rows.length, spreadsheetId };
  });

  wrap("sheets_update_row", "Update a specific range in a Google Sheet (A1 notation).", {
    spreadsheetId: z.string(),
    range:         z.string(),
    values:        z.array(z.string()),
  }, async ({ spreadsheetId, range, values }) => {
    const data = await sheetsPut(
      `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { values: [values] }
    );
    return { ok: true, updatedCells: data.updatedCells, range };
  });

  wrap("sheets_find_row", "Find a row by matching a value in a column. Returns 1-based rowIndex.", {
    spreadsheetId: z.string(),
    sheetName:     z.string().optional(),
    column:        z.number().int().min(0),
    value:         z.string(),
  }, async ({ spreadsheetId, sheetName = "Sheet1", column, value }) => {
    const data = await sheetsGet(`spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}`);
    const rows = data.values || [];
    const lv = value.toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][column] ?? "").toLowerCase() === lv)
        return { found: true, rowIndex: i + 1, rowValues: rows[i] };
    }
    return { found: false, rowIndex: null, searchedRows: rows.length };
  });

  wrap("sheets_create_spreadsheet", "Create a new Google Spreadsheet and optionally move it to a Drive folder.", {
    title:    z.string(),
    folderId: z.string().optional(),
    sheets:   z.array(z.string()).optional(),
  }, async ({ title, folderId, sheets }) => {
    const created = await sheetsPost("spreadsheets", {
      properties: { title },
      sheets: (sheets?.length ? sheets : ["Sheet1"]).map(n => ({ properties: { title: n } })),
    });
    const spreadsheetId = created.spreadsheetId;
    if (folderId) {
      const token = await getSheetsToken();
      const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=parents`, { headers: { Authorization: `Bearer ${token}` } });
      const meta = await metaRes.json();
      const currentParents = (meta.parents || []).join(",");
      await drivePatch(spreadsheetId, { addParents: folderId, removeParents: currentParents });
    }
    return { ok: true, spreadsheetId, title, folderId: folderId ?? null, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  });

  wrap("log_run", "Log agent run result to AgentMonitor DB. Call at end of every run.", {
    agent_name:     z.string(),
    agent_type:     z.string().optional(),
    prompt_version: z.string().optional(),
    status:         z.enum(["success", "partial", "error", "critical"]),
    inserted:       z.number().int().optional(),
    updated:        z.number().int().optional(),
    errors:         z.number().int().optional(),
    duration_s:     z.number().optional(),
    notes:          z.string().optional(),
  }, async ({ agent_name, agent_type, prompt_version, status, inserted = 0, updated = 0, errors = 0, duration_s, notes }) => {
    if (!monPool) return { ok: false, reason: "AGENT_MONITOR_URL not configured" };
    const r = await monPool.query(
      `INSERT INTO agent_runs (agent_name, agent_type, prompt_version, status, inserted, updated, errors, duration_s, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, run_at`,
      [agent_name, agent_type || null, prompt_version || null, status, inserted, updated, errors, duration_s || null, notes || null]
    );
    return { ok: true, run_id: r.rows[0].id, run_at: r.rows[0].run_at };
  });

  wrap("set_agent_status", "Update agent status in monitoring DB (idle/running/error/disabled).", {
    agent_name:  z.string(),
    status:      z.enum(["idle", "running", "error", "disabled"]),
    details:     z.string().optional(),
    last_run_id: z.number().int().optional(),
  }, async ({ agent_name, status, details, last_run_id }) => {
    if (!monPool) return { ok: false, reason: "AGENT_MONITOR_URL not configured" };
    await monPool.query(
      `INSERT INTO agent_status (agent_name, status, details, last_run_id, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (agent_name) DO UPDATE
         SET status=EXCLUDED.status, details=EXCLUDED.details, last_run_id=EXCLUDED.last_run_id, updated_at=NOW()`,
      [agent_name, status, details || null, last_run_id || null]
    );
    return { ok: true, agent_name, status };
  });

  wrap("schedule_run", "Schedule next agent run at a specific datetime. Cron picks it up.", {
    agent_name: z.string(),
    run_at:     z.string(),
    notes:      z.string().optional(),
  }, async ({ agent_name, run_at, notes }) => {
    if (!monPool) return { ok: false, reason: "AGENT_MONITOR_URL not configured" };
    const r = await monPool.query(
      `INSERT INTO agent_schedule (agent_name, run_at, notes) VALUES ($1,$2,$3) RETURNING id`,
      [agent_name, run_at, notes || null]
    );
    return { ok: true, schedule_id: r.rows[0].id, agent_name, run_at };
  });

  wrap("send_email", "Send email via SMTP. For important alerts, digest, or failures.", {
    subject: z.string(),
    body:    z.string(),
    to:      z.string().optional(),
    html:    z.boolean().optional(),
  }, async ({ subject, body, to, html = false }) => {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return { ok: false, reason: "SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS" };
    const recipient = to || EMAIL_DEFAULT_TO;
    if (!recipient) return { ok: false, reason: "No recipient — pass to param or set EMAIL_DEFAULT_TO" };
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    const info = await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER, to: recipient, subject,
      ...(html ? { html: body } : { text: body }),
    });
    return { ok: true, messageId: info.messageId, to: recipient };
  });


  wrapTool("sync_agent_entities", "Sync rows from a Drive Sheet into AgentMonitor DB. Call during agent init after sheets_get_values. Upserts new/changed rows, returns diff.", {
    agent_name:  z.string().describe("Agent name (matches agent_entities.agent_name)"),
    entity_type: z.enum(["entity","name","url","error"]).describe("Type of entity"),
    rows:        z.array(z.any()).describe("All rows from the Sheet (including header row 0 which is skipped)"),
    value_col:   z.number().optional().describe("0-based column index for the main value (default: 0)"),
    meta_cols:   z.array(z.string()).optional().describe("Column names for extra metadata columns (after value_col)"),
  }, async ({ agent_name, entity_type, rows, value_col = 0, meta_cols = [] }) => {
    if (!monPool) return { ok: false, reason: "AGENT_MONITOR_URL not configured" };
    const dataRows = rows.slice(1); // skip header
    let inserted = 0, updated = 0, skipped = 0;
    for (const row of dataRows) {
      const value = (row[value_col] ?? "").trim();
      if (!value) { skipped++; continue; }
      const metadata = {};
      meta_cols.forEach((col, i) => { if (row[value_col + 1 + i] !== undefined) metadata[col] = row[value_col + 1 + i]; });
      const res = await monPool.query(
        `INSERT INTO agent_entities (agent_name, entity_type, value, metadata, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (agent_name, entity_type, value)
         DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=NOW(), active=TRUE
         RETURNING (xmax = 0) AS is_insert`,
        [agent_name, entity_type, value, JSON.stringify(metadata)]
      );
      if (res.rows[0].is_insert) inserted++; else updated++;
    }
    return { ok: true, agent_name, entity_type, inserted, updated, skipped, total: dataRows.length };
  });

  wrapTool("get_agent_entities", "Read agent base entities from AgentMonitor DB. Fast — no Drive call needed after sync.", {
    agent_name:  z.string().describe("Agent name"),
    entity_type: z.enum(["entity","name","url","error"]).describe("Type of entity"),
    active_only: z.boolean().optional().describe("Return only active=true rows (default: true)"),
  }, async ({ agent_name, entity_type, active_only = true }) => {
    if (!monPool) return { ok: false, reason: "AGENT_MONITOR_URL not configured" };
    const res = await monPool.query(
      `SELECT id, value, metadata, active, created_at, updated_at
       FROM agent_entities
       WHERE agent_name=$1 AND entity_type=$2 ${active_only ? "AND active=TRUE" : ""}
       ORDER BY id`,
      [agent_name, entity_type]
    );
    return { ok: true, agent_name, entity_type, count: res.rowCount, rows: res.rows };
  });


  // ── Agent Catalog Tools ─────────────────────────────────────────────────────

  wrapTool("upsert_agent_catalog", "Register or update an agent in the local catalog with its Google SpreadsheetId for automatic QNAP sync.", {
    name:           z.string().describe("Unique agent name"),
    spreadsheet_id: z.string().optional().describe("Google Spreadsheet ID (from URL)"),
    drive_folder:   z.string().optional().describe("Google Drive folder ID (optional)"),
    sheets:         z.string().optional().describe("Comma-separated sheet names to sync (default: Entities,Names,Urls,Errors)"),
    is_active:      z.boolean().optional().describe("Whether to include in automatic sync (default: true)"),
  }, async ({ name, spreadsheet_id, drive_folder, sheets, is_active = true }) => {
    if (!monPool) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "AGENT_MONITOR_URL not configured" }) }] };
    await monPool.query(`
      CREATE TABLE IF NOT EXISTS "AgentCatalog" (
        "Name" TEXT PRIMARY KEY,
        "SpreadsheetId" TEXT,
        "DriveFolder" TEXT,
        "Sheets" TEXT,
        "LastSyncedAt" TIMESTAMPTZ,
        "IsActive" BOOLEAN DEFAULT TRUE,
        "CreatedAt" TIMESTAMPTZ DEFAULT NOW(),
        "UpdatedAt" TIMESTAMPTZ DEFAULT NOW()
      )`);
    await monPool.query(
      `INSERT INTO "AgentCatalog" ("Name","SpreadsheetId","DriveFolder","Sheets","IsActive","UpdatedAt")
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT ("Name") DO UPDATE SET
         "SpreadsheetId"=COALESCE($2,"AgentCatalog"."SpreadsheetId"),
         "DriveFolder"=COALESCE($3,"AgentCatalog"."DriveFolder"),
         "Sheets"=COALESCE($4,"AgentCatalog"."Sheets"),
         "IsActive"=$5, "UpdatedAt"=NOW()`,
      [name, spreadsheet_id ?? null, drive_folder ?? null, sheets ?? null, is_active]
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, name, spreadsheetId: spreadsheet_id ?? null }) }] };
  });

  wrapTool("get_agent_catalog", "List all agents in the catalog with their SpreadsheetId and last sync time.", {
    active_only: z.boolean().optional().describe("Return only active agents (default: false)"),
  }, async ({ active_only = false }) => {
    if (!monPool) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "AGENT_MONITOR_URL not configured" }) }] };
    try {
      const res = await monPool.query(
        `SELECT * FROM "AgentCatalog" ${active_only ? 'WHERE "IsActive" = TRUE' : ''} ORDER BY "Name"`
      );
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: res.rowCount, agents: res.rows }) }] };
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, agents: [], note: "AgentCatalog table does not exist yet" }) }] };
    }
  });

  wrapTool("sync_sheets_now", "Manually trigger immediate sync of all agent catalog spreadsheets to local QNAP storage.", {}, async () => {
    await syncAgentCatalogSheets();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, message: "Sync completed — check server logs for details" }) }] };
  });

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT now() AS now");
    res.json({ status: "ok", version: MCP_VERSION, db: "ok", now: r.rows[0].now, uptime: process.uptime(), metrics });
  } catch (e) {
    if (res.headersSent) return;
    res.status(500).json({ status: "error", version: MCP_VERSION, db: "error", error: e.message });
  }
});

app.get("/ping", (req, res) => res.json({ ok: true, version: MCP_VERSION }));

app.post("/mcp", async (req, res) => {
  if (!AUTH_TOKEN) return res.status(500).json({ error: "AUTH_TOKEN not configured" });
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) return res.status(401).json({ error: "Unauthorized" });
  // Normalize Accept header — Claude.ai and some MCP clients omit text/event-stream.
  // @hono/node-server reads from rawHeaders (not headers), so both must be updated.
  if (!req.headers["accept"] || !req.headers["accept"].includes("text/event-stream")) {
    req.headers["accept"] = "application/json, text/event-stream";
    const idx = req.rawHeaders.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === "accept");
    if (idx === -1) req.rawHeaders.push("Accept", "application/json, text/event-stream");
    else req.rawHeaders[idx + 1] = "application/json, text/event-stream";
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", async () => { await transport.close(); await server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP handler error', message: err.message });
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
await fs.mkdir(path.join(UPLOAD_DIR, "team-logos"),    { recursive: true });
await fs.mkdir(path.join(UPLOAD_DIR, "player-photos"), { recursive: true });
// ─── Init ─────────────────────────────────────────────────────────────────────
await fs.mkdir(path.join(UPLOAD_DIR, "team-logos"),    { recursive: true });
await fs.mkdir(path.join(UPLOAD_DIR, "player-photos"), { recursive: true });

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`USM Image MCP v${MCP_VERSION} running on port ${PORT}`);
});

// Graceful shutdown + SIGPIPE guard
async function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} — draining...`);
  httpServer.close(async () => { try { await pool.end(); } catch(e) {} process.exit(0); });
  setTimeout(() => process.exit(1), 15000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGPIPE", () => console.warn("[signal] SIGPIPE ignored"));

async function initDbWithRetry(attempt = 1) {
  try {
    await pool.query("SELECT 1");
    console.log("DB connection OK — sportManager");
    await ensureImageColumns();
    console.log(`USM Image MCP v${MCP_VERSION} DB initialized OK`);
  } catch (e) {
    const delay = Math.min(attempt * 5000, 60000);
    console.warn(`DB init attempt ${attempt} failed (${e.message}) — retry in ${delay/1000}s`);
    setTimeout(() => initDbWithRetry(attempt + 1), delay);
  }
}
initDbWithRetry().then(() => startSheetsSyncLoop()).catch(err => {
  console.error("Unexpected error in initDbWithRetry:", err);
});
