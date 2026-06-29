import express from "express";
import pkg from "pg";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { Pool } = pkg;

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MCP_VERSION = "9.4.1";
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 100);
const MAX_EXPORT_ROWS = Number(process.env.MAX_EXPORT_ROWS || 1000);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 15 * 1024 * 1024);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/app/uploads";
const PUBLIC_UPLOAD_BASE_URL = process.env.PUBLIC_UPLOAD_BASE_URL || "";
const NTFY_BASE_URL = process.env.NTFY_URL || "https://ntfy.vo2info.cz";
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASS = process.env.NTFY_PASS || "";

const _rawDbUrlMab = process.env.DATABASE_URL || '';
const _dbUrlMab = _rawDbUrlMab.includes('connect_timeout') ? _rawDbUrlMab
  : (_rawDbUrlMab.includes('?') ? _rawDbUrlMab + '&connect_timeout=5' : _rawDbUrlMab + '?connect_timeout=5');

const pool = new Pool({
  connectionString: _dbUrlMab,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 10000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT || 8000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[pool] Unexpected idle client error:", err.message);
});

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

  let catalogExists = false;
  try {
    await monPool.query(`SELECT 1 FROM "AgentCatalog" LIMIT 1`);
    catalogExists = true;
  } catch { return; }

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

let pgcryptoAvailable = false;
let citextAvailable = false;
let postgisAvailable = false;
let vectorAvailable = false;

const schemaCache = new Map();
const SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 minut

const metrics = {
  startedAt: new Date().toISOString(),
  requests: 0,
  toolCalls: 0,
  errors: 0,
  inserts: 0,
  updates: 0,
  softDeletes: 0,
  imagesSaved: 0,
  jobsEnqueued: 0,
  migrationsRecorded: 0,
};

const runtimeGovernanceState = {
  lastPromptUpgradeLifecycleReport: null,
  lastPromptUpgradeLifecycleAt: null,
};

const BASE_COLUMNS = [
  "Guid", "CreatedAt", "UpdatedAt", "DeletedAt", "Emoji", "Colors",
  "IsActive", "IsDeleted", "SourceName", "SourceId", "SourceUrl",
  "VerifiedAt", "Notes", "Metadata", "SearchText", "NormalizedName",
  "ShardKey", "ShardName", "ShardHint", "RowVersion"
];

const SCORE_COLUMNS = [
  "FinalScore", "DataScore", "QualityScore", "ConfidenceScore", "PopularityScore",
  "CoverageScore", "FreshnessScore", "ReliabilityScore", "CompletenessScore",
  "ConsistencyScore", "ImportanceScore", "PriorityScore", "TrendScore",
  "ActivityScore", "EngagementScore", "AccuracyScore", "ValidationScore",
  "SourceScore", "RiskScore", "AnomalyScore", "HistoricalScore", "AiScore"
];

const ALL_RESERVED_COLUMNS = new Set([...BASE_COLUMNS, ...SCORE_COLUMNS, "ScoreUpdatedAt", "ScoreReason"]);

const ALLOWED_PG_TYPES = new Set([
  "text", "integer", "bigint", "double precision", "numeric", "numeric(5,2)",
  "numeric(18,4)", "boolean", "uuid", "date", "time", "timestamptz",
  "jsonb", "bytea", "text[]", "uuid[]", "integer[]", "bigint[]",
  "numeric[]", "boolean[]", "citext", "tsvector", "point",
  "geography(Point,4326)", "vector(1536)"
]);

function uuid() { return crypto.randomUUID(); }

function assertIdentifier(name) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(String(name))) throw new Error(`Invalid identifier: ${name}`);
  return `"${name}"`;
}

function normalizeIdentifierName(name) {
  const normalized = String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9_ ]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/^([0-9])/, "C_$1")
    .slice(0, 63);
  if (!normalized) throw new Error(`Invalid empty identifier from: ${name}`);
  return normalized;
}

function sanitizePgType(type) {
  const raw = String(type || "").trim();
  const lower = raw.toLowerCase();
  const allowedLower = new Set([...ALLOWED_PG_TYPES].map(x => x.toLowerCase()));
  if (!allowedLower.has(lower)) throw new Error(`Unsupported PostgreSQL type: ${type}`);
  if (lower === "citext" && !citextAvailable) return "text";
  if (lower === "geography(point,4326)" && !postgisAvailable) return "point";
  if (lower === "vector(1536)" && !vectorAvailable) return "jsonb";
  return raw;
}

function isUuidString(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isGuidColumn(name) { return /Guid$/i.test(String(name || "")); }

function looksLikeDate(value) {
  if (typeof value !== "string") return false;
  if (!/[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isDateOnly(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function isTimeOnly(value) { return typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(value); }
function isDataUrl(value) { return typeof value === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value); }

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

function validateImageMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalized)) {
    throw new Error(`Unsupported image MIME type: "${mimeType}". Allowed: ${[...ALLOWED_IMAGE_MIME_TYPES].join(", ")}`);
  }
  return normalized;
}

function arrayPgType(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return "jsonb";
  if (value.every(v => typeof v === "string" && isUuidString(v))) return "uuid[]";
  if (value.every(v => typeof v === "string")) return "text[]";
  if (value.every(v => typeof v === "number" && Number.isInteger(v))) return "integer[]";
  if (value.every(v => typeof v === "number")) return "numeric[]";
  if (value.every(v => typeof v === "boolean")) return "boolean[]";
  return "jsonb";
}

function pgTypeForKey(key, value, explicitTypes = {}) {
  const name = normalizeIdentifierName(key);
  if (explicitTypes && explicitTypes[name]) return sanitizePgType(explicitTypes[name]);
  if (name === "Guid" || isGuidColumn(name) || isUuidString(value)) return "uuid";
  if (/Score$/i.test(name)) return "numeric(6,3)";
  // Explicit text overrides — prevent false-positive numeric inference from substrings
  // e.g. "Migration" contains "ratio", "Operation" contains "ratio", "Integrate" contains "rate"
  if (/(Name|Hash|Title|Label|Slug|Description|Type|Category|Status|Tag|Token|Key|Path|Url|Uri|Message|Error|Reason|Comment|Summary|Body|Content|Format|Locale|Language|Timezone|Currency|Country|Region|City|Address|Email|Phone|Operation|Migration|Integration|Generation|Iteration|Enumeration|Configuration|Decoration|Duration|Location)$/i.test(name)) {
    if (/Email|NormalizedName|Slug|Code/i.test(name) && citextAvailable) return "citext";
    return "text";
  }
  if (/Amount|Price|Cost|Value|Rate|Ratio|Percent|Percentage|Odds|Weight|Height|Length|Width|Distance|Latitude|Longitude/i.test(name)) return "numeric(18,4)";
  if (/Count|Total|Number|Rank|Position|Year|Age/i.test(name)) return "integer";
  if (/Size|Bytes|RowVersion/i.test(name)) return "bigint";
  if (/^Is[A-Z]|Enabled|Disabled|Active|Deleted|Valid|Verified/i.test(name) || typeof value === "boolean") return "boolean";
  if (/Date$|Day$/i.test(name) || isDateOnly(value)) return "date";
  if (/TimeOnly$|LocalTime$/i.test(name) || isTimeOnly(value)) return "time";
  if (/At$|DateTime$|Timestamp$|Time$/i.test(name) || value instanceof Date || looksLikeDate(value)) return "timestamptz";
  if (/ImageBytes|PhotoBytes|LogoBytes|Binary|Blob|FileBytes/i.test(name)) return "bytea";
  if (/ImageBase64|PhotoBase64|LogoBase64/i.test(name) || isDataUrl(value)) return "bytea";
  if (/Vector$|Embedding$/i.test(name)) return vectorAvailable ? "vector(1536)" : "jsonb";
  if (/SearchVector$/i.test(name)) return "tsvector";
  if (/GeoPoint|Coordinates|LocationPoint/i.test(name)) return postgisAvailable ? "geography(Point,4326)" : "point";
  const arrType = arrayPgType(value);
  if (arrType) return arrType;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return "jsonb";
  if (Buffer.isBuffer(value)) return "bytea";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "numeric(18,4)";
  if (/Email|NormalizedName|Slug|Code/i.test(name) && citextAvailable) return "citext";
  return "text";
}

function pgType(value, key = "", explicitTypes = {}) { return pgTypeForKey(key || "Value", value, explicitTypes); }

function normalizeValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && isDataUrl(value)) return Buffer.from(value.split(",")[1], "base64");
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 1000) / 1000));
}

function normalizeScoreData(data) {
  const out = { ...(data || {}) };
  let touched = false;
  for (const col of SCORE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(out, col)) {
      out[col] = clampScore(out[col]);
      touched = true;
    }
  }
  if (touched && !Object.prototype.hasOwnProperty.call(out, "ScoreUpdatedAt")) out.ScoreUpdatedAt = new Date().toISOString();
  return out;
}

function buildScoreBreakdown(record = {}) {
  const normalized = normalizeScoreData(record);
  const presentScores = {};
  for (const col of SCORE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(normalized, col)) {
      const value = normalized[col];
      if (value !== null && value !== undefined && value !== "") presentScores[col] = Number(value);
    }
  }

  const criticalScores = ["ConfidenceScore", "ValidationScore", "CoverageScore"]
    .filter(key => Object.prototype.hasOwnProperty.call(presentScores, key))
    .map(key => ({ key, value: presentScores[key] }));

  const limitingFactor = criticalScores.length > 0
    ? criticalScores.reduce((lowest, current) => current.value < lowest.value ? current : lowest)
    : null;

  const warnings = [];
  for (const [key, value] of Object.entries(presentScores)) {
    if (value < 40) warnings.push(`${key} is critically low`);
    else if (value < 60) warnings.push(`${key} is below preferred confidence`);
  }

  if (presentScores.FinalScore !== undefined && limitingFactor && presentScores.FinalScore > limitingFactor.value) {
    warnings.push(`FinalScore exceeds limiting critical score ${limitingFactor.key}`);
  }

  return {
    scores: presentScores,
    limitingFactor,
    scoreReason: String(normalized.ScoreReason || ""),
    scoreUpdatedAt: normalized.ScoreUpdatedAt || null,
    warnings
  };
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeLimit(limit, max = 100) {
  const n = Number(limit || 20);
  return Math.min(Math.max(Number.isFinite(n) ? n : 20, 1), max);
}

function buildWhere(criteria, startIndex = 1) {
  const keys = Object.keys(criteria || {});
  if (keys.length === 0) throw new Error("criteria must not be empty");
  const values = [];
  let paramIdx = startIndex;
  const clauses = keys.map((rawKey) => {
    const key = normalizeIdentifierName(rawKey);
    assertIdentifier(key);
    const val = normalizeValue(criteria[rawKey]);
    if (val === null || val === undefined) {
      return `"${key}" IS NULL`;
    }
    values.push(val);
    return `"${key}" = $${paramIdx++}`;
  });
  return { where: clauses.join(" AND "), values };
}

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

function mimeToExtension(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  return ".bin";
}

function safeFileName(name) {
  return String(name || "file").trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120);
}

async function ensureUploadDir() { await fs.mkdir(UPLOAD_DIR, { recursive: true }); }

async function initDb() {
  await ensureUploadDir();
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto"); pgcryptoAvailable = true; } catch (e) { pgcryptoAvailable = false; console.warn("pgcrypto unavailable, using app-side UUID fallback:", e.message); }
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS citext"); citextAvailable = true; } catch { citextAvailable = false; }
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS postgis"); postgisAvailable = true; } catch { postgisAvailable = false; }
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS vector"); vectorAvailable = true; } catch { vectorAvailable = false; }
  await createUpdatedAtTriggerFunction();
  await ensureSystemTables();
}

async function createUpdatedAtTriggerFunction() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW."UpdatedAt" = now();
      NEW."RowVersion" = COALESCE(OLD."RowVersion", 0) + 1;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

async function ensureUpdatedAtTrigger(table) {
  const t = normalizeIdentifierName(table);
  const triggerName = normalizeIdentifierName(`trg_${t}_set_updated_at`).slice(0, 60);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${triggerName}') THEN
        CREATE TRIGGER "${triggerName}"
        BEFORE UPDATE ON "${t}"
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
      END IF;
    END $$;
  `);
}

async function tableExists(table) {
  const t = normalizeIdentifierName(table);
  const r = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS exists`,
    [t]
  );
  return r.rows[0].exists;
}

async function getColumns(table) {
  const t = normalizeIdentifierName(table);
  const cached = schemaCache.get(t);
  if (cached && (Date.now() - cached.loadedAt) < SCHEMA_CACHE_TTL) return new Set(cached.columns);
  const r = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t]);
  const columns = r.rows.map(x => x.column_name);
  schemaCache.set(t, { columns, loadedAt: Date.now() });
  return new Set(columns);
}

function invalidateSchema(table = null) {
  if (table) schemaCache.delete(normalizeIdentifierName(table));
  else schemaCache.clear();
}

function baseColumnsSql() {
  const guidDefault = pgcryptoAvailable ? "DEFAULT gen_random_uuid()" : "";
  return `
    "Guid" uuid PRIMARY KEY ${guidDefault},
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
    "DeletedAt" timestamptz NULL,
    "Emoji" text NOT NULL DEFAULT '',
    "Colors" text NOT NULL DEFAULT '',
    "IsActive" boolean NOT NULL DEFAULT true,
    "IsDeleted" boolean NOT NULL DEFAULT false,
    "SourceName" text NULL,
    "SourceId" text NULL,
    "SourceUrl" text NULL,
    "VerifiedAt" timestamptz NULL,
    "Notes" text NOT NULL DEFAULT '',
    "Metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "SearchText" text NOT NULL DEFAULT '',
    "NormalizedName" text NOT NULL DEFAULT '',
    "ShardKey" text NOT NULL DEFAULT '',
    "ShardName" text NOT NULL DEFAULT '',
    "ShardHint" text NOT NULL DEFAULT '',
    "RowVersion" bigint NOT NULL DEFAULT 0,
    "ScoreUpdatedAt" timestamptz NULL,
    "ScoreReason" text NOT NULL DEFAULT ''
  `;
}

async function ensureSystemTables() {
  await ensureTable("AuditLog");
  await ensureColumnsInternal("AuditLog", { Action: "", TableName: "", Payload: {} });
  await ensureTable("SchemaMigrations");
  await ensureColumnsInternal("SchemaMigrations", { MigrationName: "", MigrationHash: "", ExecutedAt: new Date().toISOString() });
  await ensureTable("JobQueue");
  await ensureColumnsInternal("JobQueue", { JobType: "", Status: "queued", Payload: {}, RetryCount: 0, MaxRetries: 3, LastError: "", RunAt: new Date().toISOString(), LockedAt: new Date().toISOString(), CompletedAt: new Date().toISOString() });
  await ensureTable("DeadLetterQueue");
  await ensureColumnsInternal("DeadLetterQueue", { JobGuid: uuid(), JobType: "", Payload: {}, Error: "", FailedAt: new Date().toISOString() });
  await ensureTable("EntityImages");
  await ensureColumnsInternal("EntityImages", { EntityTable: "", EntityGuid: uuid(), ImagePath: "", ImageUrl: "", OriginalFileName: "", MimeType: "", SizeBytes: 0, Sha256: "", Width: 0, Height: 0 });
}

async function ensureTable(table) {
  const t = normalizeIdentifierName(table);
  await pool.query(`CREATE TABLE IF NOT EXISTS "${t}" (${baseColumnsSql()})`);
  invalidateSchema(t);
  await ensureBaseStructure(t);
  await ensureStandardIndexes(t);
  await ensureUpdatedAtTrigger(t);
  invalidateSchema(t);
}

async function ensureBaseStructure(table) {
  const t = normalizeIdentifierName(table);
  let existing = await getColumns(t);

  async function addColumnIfMissing(name, sql) {
    if (!existing.has(name)) {
      await pool.query(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS ${sql}`);
      invalidateSchema(t);
      existing = await getColumns(t);
    }
  }

  await addColumnIfMissing("Guid", `"Guid" uuid ${pgcryptoAvailable ? "DEFAULT gen_random_uuid()" : ""}`);
  await addColumnIfMissing("CreatedAt", `"CreatedAt" timestamptz NOT NULL DEFAULT now()`);
  await addColumnIfMissing("UpdatedAt", `"UpdatedAt" timestamptz NOT NULL DEFAULT now()`);
  await addColumnIfMissing("DeletedAt", `"DeletedAt" timestamptz NULL`);
  await addColumnIfMissing("Emoji", `"Emoji" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("Colors", `"Colors" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("IsActive", `"IsActive" boolean NOT NULL DEFAULT true`);
  await addColumnIfMissing("IsDeleted", `"IsDeleted" boolean NOT NULL DEFAULT false`);
  await addColumnIfMissing("SourceName", `"SourceName" text NULL`);
  await addColumnIfMissing("SourceId", `"SourceId" text NULL`);
  await addColumnIfMissing("SourceUrl", `"SourceUrl" text NULL`);
  await addColumnIfMissing("VerifiedAt", `"VerifiedAt" timestamptz NULL`);
  await addColumnIfMissing("Notes", `"Notes" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("Metadata", `"Metadata" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await addColumnIfMissing("SearchText", `"SearchText" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("NormalizedName", `"NormalizedName" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("ShardKey", `"ShardKey" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("ShardName", `"ShardName" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("ShardHint", `"ShardHint" text NOT NULL DEFAULT ''`);
  await addColumnIfMissing("RowVersion", `"RowVersion" bigint NOT NULL DEFAULT 0`);
  await addColumnIfMissing("ScoreUpdatedAt", `"ScoreUpdatedAt" timestamptz NULL`);
  await addColumnIfMissing("ScoreReason", `"ScoreReason" text NOT NULL DEFAULT ''`);

  // Batch-fetch all score column types for this table in one query instead of N queries.
  const scoreColsExisting = SCORE_COLUMNS.filter(c => existing.has(c));
  let colTypesMap = {};
  if (scoreColsExisting.length > 0) {
    const typeRes = await pool.query(
      `SELECT column_name, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
         AND column_name = ANY($2::text[])`,
      [t, scoreColsExisting]
    );
    for (const row of typeRes.rows) {
      colTypesMap[row.column_name] = { p: Number(row.numeric_precision), s: Number(row.numeric_scale) };
    }
  }

  for (const col of SCORE_COLUMNS) {
    if (!existing.has(col)) {
      await pool.query(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "${col}" numeric(6,3) NOT NULL DEFAULT 0 CHECK ("${col}" >= 0 AND "${col}" <= 100)`);
      invalidateSchema(t);
      existing = await getColumns(t);
    } else {
      // Migrate existing numeric(5,2) score columns to numeric(6,3) for 3-decimal precision.
      // This is a safe widening cast — no data loss, just increased precision.
      // Skips gracefully when a view or rule depends on the column (PG error 0A000).
      const info = colTypesMap[col];
      if (info && info.p === 5 && info.s === 2) {
        try {
          await pool.query(`ALTER TABLE "${t}" ALTER COLUMN "${col}" TYPE numeric(6,3)`);
          invalidateSchema(t);
        } catch (e) {
          // 0A000 = feature_not_supported: column used by a view or rule — skip silently.
          if (e.code !== "0A000") throw e;
          console.warn(`[migration] Skipped numeric(6,3) cast for "${t}"."${col}" — view dependency: ${e.detail || e.message}`);
        }
      }
    }
  }
}

async function ensureStandardIndexes(table) {
  const t = normalizeIdentifierName(table);
  const cols = await getColumns(t);

  async function createIndex(name, sql) {
    const safeName = normalizeIdentifierName(name).slice(0, 60);
    try { await pool.query(`CREATE INDEX IF NOT EXISTS "${safeName}" ON "${t}" ${sql}`); }
    catch (e) { console.warn(`Index ${safeName} skipped:`, e.message); }
  }

  if (cols.has("Guid")) await createIndex(`idx_${t}_Guid`, `("Guid")`);
  if (cols.has("CreatedAt")) await createIndex(`idx_${t}_CreatedAt`, `("CreatedAt")`);
  if (cols.has("UpdatedAt")) await createIndex(`idx_${t}_UpdatedAt`, `("UpdatedAt")`);
  if (cols.has("IsDeleted")) await createIndex(`idx_${t}_IsDeleted`, `("IsDeleted")`);
  if (cols.has("SourceId")) await createIndex(`idx_${t}_SourceId`, `("SourceId")`);
  if (cols.has("NormalizedName")) await createIndex(`idx_${t}_NormalizedName`, `("NormalizedName")`);
  if (cols.has("SearchText")) await createIndex(`idx_${t}_SearchText_gin`, `USING GIN (to_tsvector('simple', "SearchText"))`);
  if (cols.has("Metadata")) await createIndex(`idx_${t}_Metadata_gin`, `USING GIN ("Metadata")`);
}

async function ensureColumnsInternal(table, data = {}) {
  const t = normalizeIdentifierName(table);
  await ensureTable(t);
  let existing = await getColumns(t);
  const explicitTypes = data.ColumnTypes && typeof data.ColumnTypes === "object" ? data.ColumnTypes : {};

  for (const [rawKey, rawValue] of Object.entries(data || {})) {
    const key = normalizeIdentifierName(rawKey);
    if (!key || key === "ColumnTypes") continue;
    if (ALL_RESERVED_COLUMNS.has(key)) continue;
    if (existing.has(key)) continue;
    const type = pgType(rawValue, key, explicitTypes);
    await pool.query(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "${key}" ${type}`);
    invalidateSchema(t);
    existing = await getColumns(t);
  }

  await autoForeignKeys(t);
  await ensureStandardIndexes(t);
}

async function createForeignKey(table, column, refTable, refColumn = "Guid") {
  const t = normalizeIdentifierName(table);
  const c = normalizeIdentifierName(column);
  const rt = normalizeIdentifierName(refTable);
  const rc = normalizeIdentifierName(refColumn);

  if (!(await tableExists(t))) throw new Error(`Table does not exist: ${t}`);
  if (!(await tableExists(rt))) throw new Error(`Referenced table does not exist: ${rt}`);

  const constraintName = normalizeIdentifierName(`fk_${t}_${c}_${rt}_${rc}`).slice(0, 60);
  const exists = await pool.query(
    `SELECT 1 FROM information_schema.table_constraints WHERE table_schema='public' AND table_name=$1 AND constraint_name=$2 AND constraint_type='FOREIGN KEY'`,
    [t, constraintName]
  );

  if (exists.rowCount === 0) {
    await pool.query(`ALTER TABLE "${t}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${c}") REFERENCES "${rt}"("${rc}")`);
  }

  return constraintName;
}

async function autoForeignKeys(table) {
  const t = normalizeIdentifierName(table);
  const cols = await getColumns(t);

  for (const col of cols) {
    if (!isGuidColumn(col) || col === "Guid") continue;
    const base = col.replace(/Guid$/i, "");
    const candidates = [base, `${base}s`, `${base}es`].map(normalizeIdentifierName);

    for (const candidate of candidates) {
      if (candidate === t) continue;
      if (await tableExists(candidate)) {
        try { await createForeignKey(t, col, candidate, "Guid"); }
        catch (e) { console.warn(`Auto FK skipped for ${t}.${col}:`, e.message); }
        break;
      }
    }
  }
}

async function audit(action, table, payload) {
  try {
    if (table === "AuditLog") return;
    await upsertRecord("AuditLog", { Guid: uuid() }, { Action: action, TableName: table, Payload: payload }, true);
  } catch (e) {
    console.warn("audit failed:", e.message);
  }
}

// dbClient — optional dedicated pg client (for use inside transactions).
// When provided, DML queries run on this client instead of the pool.
// Schema operations (ensureColumnsInternal) always use the pool — DDL is idempotent.
async function upsertRecord(table, criteria, data, skipAudit = false, dbClient = null) {
  const t = normalizeIdentifierName(table);
  const db = dbClient || pool;
  const normalized = normalizeScoreData({ ...(data || {}) });
  if (normalized.Name && !normalized.NormalizedName) normalized.NormalizedName = normalizeSearchText(normalized.Name);
  if (!normalized.SearchText) normalized.SearchText = normalizeSearchText(JSON.stringify({ ...criteria, ...normalized }));

  await ensureColumnsInternal(t, { ...(criteria || {}), ...(normalized || {}) });

  const criteriaKeys = Object.keys(criteria || {});
  let existing = null;

  if (criteriaKeys.length > 0) {
    const where = buildWhere(criteria);
    // Search includes soft-deleted records so we can restore them instead of creating duplicates.
    // Prefer active records (IsDeleted=false) first; fall back to deleted if nothing active found.
    const result = await db.query(
      `SELECT * FROM "${t}" WHERE ${where.where} ORDER BY COALESCE("IsDeleted", false) ASC LIMIT 1`,
      where.values
    );
    existing = result.rows[0] || null;
  }

  if (existing) {
    const updateData = { ...normalized };
    // Restore a previously soft-deleted record automatically on upsert
    if (existing.IsDeleted === true) {
      updateData.IsDeleted = false;
      updateData.IsActive = true;
      updateData.DeletedAt = null;
    }
    const keys = Object.keys(updateData);
    if (keys.length === 0) return { mode: "unchanged", guid: existing.Guid };

    const setClause = keys.map((k, i) => `"${normalizeIdentifierName(k)}" = $${i + 1}`).join(", ");
    const values = keys.map(k => normalizeValue(updateData[k]));
    values.push(existing.Guid);

    await db.query(`UPDATE "${t}" SET ${setClause} WHERE "Guid" = $${keys.length + 1}`, values);
    metrics.updates++;
    if (!skipAudit) await audit("update", t, { criteria, data: updateData });
    return { mode: existing.IsDeleted ? "restore" : "update", guid: existing.Guid };
  }

  const insertData = { Guid: criteria?.Guid || uuid(), ...(criteria || {}), ...(normalized || {}) };
  const keys = Object.keys(insertData);
  const columns = keys.map(k => `"${normalizeIdentifierName(k)}"`).join(", ");
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const values = keys.map(k => normalizeValue(insertData[k]));

  await db.query(`INSERT INTO "${t}" (${columns}) VALUES (${placeholders})`, values);
  metrics.inserts++;
  if (!skipAudit) await audit("insert", t, insertData);
  return { mode: "insert", guid: insertData.Guid };
}

async function findRecords(table, criteria = {}, limit = 20) {
  const t = normalizeIdentifierName(table);
  const safe = safeLimit(limit, 500);
  const cols = await getColumns(t);
  const hasIsDeleted = cols.has("IsDeleted");
  const hasUpdatedAt = cols.has("UpdatedAt");

  const deletedClause = hasIsDeleted ? ` AND "IsDeleted"=false` : "";
  const orderClause = hasUpdatedAt ? ` ORDER BY "UpdatedAt" DESC` : "";

  if (Object.keys(criteria).length === 0) {
    const r = await pool.query(`SELECT * FROM "${t}" WHERE true${deletedClause}${orderClause} LIMIT ${safe}`);
    return r.rows;
  }

  const where = buildWhere(criteria);
  const r = await pool.query(`SELECT * FROM "${t}" WHERE ${where.where}${deletedClause} LIMIT ${safe}`, where.values);
  return r.rows;
}

async function searchRecords(table, query, limit = 20) {
  const t = normalizeIdentifierName(table);
  const safe = safeLimit(limit, 200);
  const normalized = normalizeSearchText(query);
  const cols = await getColumns(t);

  const hasSearchText = cols.has("SearchText");
  const hasNormalizedName = cols.has("NormalizedName");
  if (!hasSearchText && !hasNormalizedName) {
    throw new Error(`Table "${t}" has neither SearchText nor NormalizedName column — search_records requires at least one.`);
  }

  const hasIsDeleted = cols.has("IsDeleted");
  const hasUpdatedAt = cols.has("UpdatedAt");

  const searchCond = hasSearchText && hasNormalizedName
    ? `("SearchText" ILIKE $1 OR "NormalizedName" ILIKE $1)`
    : hasSearchText
      ? `"SearchText" ILIKE $1`
      : `"NormalizedName" ILIKE $1`;
  const deletedClause = hasIsDeleted ? ` AND "IsDeleted"=false` : "";
  const orderClause = hasUpdatedAt ? ` ORDER BY "UpdatedAt" DESC` : "";

  const r = await pool.query(
    `SELECT * FROM "${t}" WHERE ${searchCond}${deletedClause}${orderClause} LIMIT ${safe}`,
    [`%${normalized}%`]
  );
  return r.rows;
}

async function listAgentEntityTables(agentName, entityTables = []) {
  // When explicit table list is provided, use it directly — recommended for all agents.
  if (Array.isArray(entityTables) && entityTables.length > 0) {
    return entityTables.map(normalizeIdentifierName);
  }

  // Auto-detection fallback: return all public base tables except known system tables.
  // NOTE: for precise agent-scoped queries always pass entityTables explicitly —
  // auto-detection cannot reliably infer which tables belong to a given agent
  // when table names do not carry the agent name as a prefix (e.g. sport agents
  // use generic names like Matches, Teams, Players).
  const excludedTables = new Set([
    "AuditLog",
    "MigrationLog",
    "SchemaMigrations",
    "JobQueue",
    "DeadLetterQueue",
    "EntityImages",
    ...ENTERPRISE_530_TABLES
  ].map(name => name.toLowerCase()));

  const r = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  return r.rows
    .map(row => String(row.table_name || "").trim())
    .filter(Boolean)
    .filter(name => !excludedTables.has(name.toLowerCase()))
    .map(normalizeIdentifierName);
}

async function countActiveRows(table) {
  const t = normalizeIdentifierName(table);
  const cols = await getColumns(t);
  const sql = cols.has("IsDeleted")
    ? `SELECT COUNT(*)::int AS row_count FROM "${t}" WHERE "IsDeleted"=false`
    : `SELECT COUNT(*)::int AS row_count FROM "${t}"`;
  const r = await pool.query(sql);
  return Number(r.rows?.[0]?.row_count || 0);
}

async function fetchHistoricalRows(table, limit, offset = 0) {
  const t = normalizeIdentifierName(table);
  const safe = safeLimit(limit, 100);
  const safeOffset = Math.max(0, Number(offset || 0));
  const cols = await getColumns(t);
  const hasIsDeleted = cols.has("IsDeleted");
  const hasCreatedAt = cols.has("CreatedAt");
  const hasUpdatedAt = cols.has("UpdatedAt");

  const deletedClause = hasIsDeleted ? `WHERE "IsDeleted"=false` : "";
  let orderClause = "";
  if (hasCreatedAt && hasUpdatedAt) orderClause = `ORDER BY COALESCE("CreatedAt", "UpdatedAt") ASC NULLS FIRST, "UpdatedAt" ASC NULLS FIRST`;
  else if (hasCreatedAt) orderClause = `ORDER BY "CreatedAt" ASC NULLS FIRST`;
  else if (hasUpdatedAt) orderClause = `ORDER BY "UpdatedAt" ASC NULLS FIRST`;

  const r = await pool.query(
    `SELECT * FROM "${t}" ${deletedClause} ${orderClause} LIMIT $1 OFFSET $2`,
    [safe, safeOffset]
  );
  return r.rows;
}

async function getAgentHistoricalSample({ agentName, entityTables = [], totalLimit = 100 }) {
  const safeTotal = safeLimit(totalLimit, 100);
  const tables = await listAgentEntityTables(agentName, entityTables);
  if (tables.length === 0) {
    return {
      agentName,
      totalRequested: safeTotal,
      totalReturned: 0,
      tablesScanned: 0,
      distribution: [],
      rows: []
    };
  }

  const counts = [];
  for (const table of tables) counts.push({ table, available: await countActiveRows(table), allocated: 0 });

  let remaining = safeTotal;
  while (remaining > 0) {
    const candidates = counts.filter(item => item.allocated < item.available);
    if (candidates.length === 0) break;
    for (const item of candidates) {
      if (remaining <= 0) break;
      item.allocated += 1;
      remaining -= 1;
    }
  }

  const distribution = [];
  const rows = [];
  for (const item of counts) {
    if (item.allocated <= 0) continue;
    const sampledRows = await fetchHistoricalRows(item.table, item.allocated, 0);
    distribution.push({
      table: item.table,
      requested: item.allocated,
      returned: sampledRows.length,
      available: item.available
    });
    for (const row of sampledRows) rows.push({ entityTable: item.table, row });
  }

  return {
    agentName,
    totalRequested: safeTotal,
    totalReturned: rows.length,
    tablesScanned: tables.length,
    distribution,
    rows
  };
}

async function getScoreBreakdownByTableGuid(table, guid) {
  const rows = await findRecords(table, { Guid: guid }, 1);
  if (!rows[0]) {
    return {
      table: normalizeIdentifierName(table),
      guid,
      found: false,
      scoreBreakdown: null
    };
  }

  return {
    table: normalizeIdentifierName(table),
    guid,
    found: true,
    scoreBreakdown: buildScoreBreakdown(rows[0]),
    record: rows[0]
  };
}

async function softDeleteRecord(table, criteria) {
  const t = normalizeIdentifierName(table);
  const cols = await getColumns(t);
  const missing = ["IsDeleted", "IsActive", "DeletedAt"].filter(c => !cols.has(c));
  if (missing.length > 0) {
    throw new Error(`soft_delete_record requires BaseGuid columns missing from "${t}": ${missing.join(", ")}. Run ensure_base_structure first.`);
  }

  const where = buildWhere(criteria);
  const result = await pool.query(
    `UPDATE "${t}" SET "IsDeleted"=true, "IsActive"=false, "DeletedAt"=now() WHERE ${where.where} RETURNING "Guid"`,
    where.values
  );

  metrics.softDeletes += result.rowCount;
  await audit("soft_delete", t, criteria);
  return { affected: result.rowCount };
}


function stripSqlComments(sql) {
  return String(sql || "")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}

function assertSelectSql(sql) {
  const cleaned = stripSqlComments(sql).toLowerCase();
  if (!(cleaned.startsWith("select") || cleaned.startsWith("with"))) {
    throw new Error("Only SELECT/ WITH SELECT SQL is allowed here.");
  }

  const blocked = [
    "insert", "update", "delete", "drop", "alter", "create",
    "truncate", "grant", "revoke", "copy", "call", "do", "execute"
  ];

  for (const word of blocked) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(cleaned)) throw new Error(`Blocked SQL keyword: ${word}`);
  }

  return sql;
}

function assertSafeMigrationSql(sql) {
  const cleaned = stripSqlComments(sql).toLowerCase();
  const blocked = [
    "drop", "delete", "truncate", "grant", "revoke", "copy", "call", "execute"
  ];

  for (const word of blocked) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(cleaned)) throw new Error(`Blocked migration SQL keyword: ${word}`);
  }

  return sql;
}

function nextRetryAt(retryCount) {
  const delayMinutes = Math.min(Math.max(Number(retryCount || 1) * 5, 5), 60);
  return new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
}

async function claimNextJob(status = "queued") {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const r = await client.query(
      `SELECT *
       FROM "JobQueue"
       WHERE "Status"=$1
         AND COALESCE("IsDeleted", false)=false
         AND ("RunAt" IS NULL OR "RunAt" <= now())
       ORDER BY "RunAt" ASC NULLS FIRST, "CreatedAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [status]
    );

    if (r.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const job = r.rows[0];

    await client.query(
      `UPDATE "JobQueue"
       SET "Status"='running', "LockedAt"=now(), "UpdatedAt"=now()
       WHERE "Guid"=$1`,
      [job.Guid]
    );

    await client.query("COMMIT");
    return { ...job, Status: "running" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function completeJob(jobGuid, result = {}) {
  const r = await pool.query(
    `UPDATE "JobQueue"
     SET "Status"='completed', "CompletedAt"=now(), "Metadata"=$2::jsonb, "UpdatedAt"=now()
     WHERE "Guid"=$1
     RETURNING *`,
    [jobGuid, JSON.stringify(result || {})]
  );
  return r.rows[0] || null;
}

async function moveJobToDeadLetter(jobGuid, errorMessage = "") {
  const r = await pool.query(`SELECT * FROM "JobQueue" WHERE "Guid"=$1 LIMIT 1`, [jobGuid]);
  if (r.rowCount === 0) throw new Error("job not found");

  const job = r.rows[0];

  await upsertRecord("DeadLetterQueue", { JobGuid: jobGuid }, {
    JobGuid: jobGuid,
    JobType: job.JobType || job.jobtype || "",
    Payload: job.Payload || job.payload || {},
    Error: errorMessage,
    FailedAt: new Date().toISOString()
  }, true);

  await pool.query(
    `UPDATE "JobQueue"
     SET "Status"='dead_letter', "LastError"=$2, "UpdatedAt"=now()
     WHERE "Guid"=$1`,
    [jobGuid, errorMessage]
  );

  return { moved: true, jobGuid };
}

async function failJob(jobGuid, errorMessage = "") {
  const r = await pool.query(`SELECT * FROM "JobQueue" WHERE "Guid"=$1 LIMIT 1`, [jobGuid]);
  if (r.rowCount === 0) throw new Error("job not found");

  const job = r.rows[0];
  const retryCount = Number(job.RetryCount || 0) + 1;
  const maxRetries = Number(job.MaxRetries || 3);

  if (retryCount >= maxRetries) {
    return await moveJobToDeadLetter(jobGuid, errorMessage);
  }

  const nextRun = nextRetryAt(retryCount);

  const updated = await pool.query(
    `UPDATE "JobQueue"
     SET "Status"='queued', "RetryCount"=$2, "LastError"=$3, "RunAt"=$4, "UpdatedAt"=now()
     WHERE "Guid"=$1
     RETURNING *`,
    [jobGuid, retryCount, errorMessage, nextRun]
  );

  return updated.rows[0] || null;
}

async function retryJob(jobGuid, runAt = null) {
  const r = await pool.query(
    `UPDATE "JobQueue"
     SET "Status"='queued', "RunAt"=$2, "LastError"='', "UpdatedAt"=now()
     WHERE "Guid"=$1
     RETURNING *`,
    [jobGuid, runAt || new Date().toISOString()]
  );
  return r.rows[0] || null;
}

async function saveImageUrl({ entityTable, entityGuid, imageUrl, originalFileName = "image" }) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) throw new Error("Valid http(s) imageUrl required");

  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`image download failed: ${response.status} ${response.statusText}`);

  const rawMime = response.headers.get("content-type") || "application/octet-stream";
  const mimeType = validateImageMimeType(rawMime);  // throws if not in whitelist
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("image too large");

  const base64 = buffer.toString("base64");
  return await saveImage({ entityTable, entityGuid, base64, mimeType, originalFileName });
}

async function listRlsStatus(table = null) {
  const params = [];
  let filter = "";
  if (table) {
    params.push(normalizeIdentifierName(table));
    filter = "AND c.relname = $1";
  }

  const r = await pool.query(
    `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' ${filter}
     ORDER BY c.relname`,
    params
  );
  return r.rows;
}

async function disableRls(table) {
  const t = normalizeIdentifierName(table);
  await pool.query(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
  return { disabled: true, table: t };
}

async function dropRlsPolicy(table, policyName) {
  const t = normalizeIdentifierName(table);
  const p = normalizeIdentifierName(policyName);
  await pool.query(`DROP POLICY IF EXISTS "${p}" ON "${t}"`);
  return { dropped: true, table: t, policyName: p };
}

async function createPartitionedTable(table, partitionColumn = "TargetDate") {
  const t = normalizeIdentifierName(table);
  const c = normalizeIdentifierName(partitionColumn);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${t}" (
      ${baseColumnsSql()},
      "${c}" date NOT NULL
    ) PARTITION BY RANGE ("${c}")`
  );

  invalidateSchema(t);
  return { created: true, table: t, partitionColumn: c };
}

async function createDatePartition(table, partitionName, fromDate, toDate) {
  const t = normalizeIdentifierName(table);
  const p = normalizeIdentifierName(partitionName);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error("fromDate and toDate must be YYYY-MM-DD");
  }

  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${p}"
     PARTITION OF "${t}"
     FOR VALUES FROM ('${fromDate}') TO ('${toDate}')`
  );

  return { created: true, table: t, partitionName: p, fromDate, toDate };
}

function shardPlan(table, shardKey = "ShardKey", shardCount = 4) {
  const t = normalizeIdentifierName(table);
  const key = normalizeIdentifierName(shardKey);
  const count = Math.max(1, Math.min(Number(shardCount || 4), 128));

  return {
    table: t,
    shardKey: key,
    shardCount: count,
    strategy: "metadata_only",
    columns: ["ShardKey", "ShardName", "ShardHint"],
    note: "This MCP stores shard metadata. Real multi-database sharding still needs an external routing layer."
  };
}

async function recordMigration(name, sql) {
  const migrationName = String(name || "").trim();
  if (!migrationName) throw new Error("migration name required");

  assertSafeMigrationSql(sql);

  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  const exists = await pool.query(`SELECT 1 FROM "SchemaMigrations" WHERE "MigrationHash"=$1 LIMIT 1`, [hash]);
  if (exists.rowCount > 0) return { skipped: true, hash };

  // Use a dedicated client so BEGIN/COMMIT/ROLLBACK all stay on the same DB connection.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await upsertRecord("SchemaMigrations", { MigrationHash: hash }, {
      MigrationName: migrationName,
      MigrationHash: hash,
      ExecutedAt: new Date().toISOString()
    }, true, client);
    await client.query("COMMIT");
    metrics.migrationsRecorded++;
    return { executed: true, hash };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function enqueueJob(jobType, payload, runAt = null) {
  const result = await upsertRecord("JobQueue", { Guid: uuid() }, {
    JobType: jobType,
    Status: "queued",
    Payload: payload,
    RetryCount: 0,
    MaxRetries: 3,
    RunAt: runAt || new Date().toISOString()
  }, true);

  metrics.jobsEnqueued++;
  return result;
}

async function saveImage({ entityTable, entityGuid, base64, mimeType = "image/png", originalFileName = "image" }) {
  if (!base64) throw new Error("base64 required");
  validateImageMimeType(mimeType);  // throws if not in whitelist
  let cleanBase64 = base64;
  if (isDataUrl(base64)) cleanBase64 = base64.split(",")[1];

  const buffer = Buffer.from(cleanBase64, "base64");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("image too large");

  const ext = mimeToExtension(mimeType);
  const hash = sha256(buffer);
  const folder = path.join(UPLOAD_DIR, normalizeIdentifierName(entityTable));
  await fs.mkdir(folder, { recursive: true });

  const fileName = `${Date.now()}_${hash.slice(0, 12)}_${safeFileName(originalFileName)}${ext}`;
  const absolutePath = path.join(folder, fileName);
  await fs.writeFile(absolutePath, buffer);

  const relativePath = path.relative(UPLOAD_DIR, absolutePath).replace(/\\/g, "/");
  const publicUrl = PUBLIC_UPLOAD_BASE_URL ? `${PUBLIC_UPLOAD_BASE_URL.replace(/\/$/, "")}/${relativePath}` : relativePath;

  await upsertRecord("EntityImages", { Sha256: hash }, {
    EntityTable: entityTable,
    EntityGuid: entityGuid,
    ImagePath: absolutePath,
    ImageUrl: publicUrl,
    OriginalFileName: originalFileName,
    MimeType: mimeType,
    SizeBytes: buffer.length,
    Sha256: hash
  });

  metrics.imagesSaved++;
  return { imageUrl: publicUrl, imagePath: absolutePath, sha256: hash, sizeBytes: buffer.length };
}

async function createMaterializedView(viewName, sql) {
  const v = normalizeIdentifierName(viewName);
  assertSelectSql(sql);
  await pool.query(`CREATE MATERIALIZED VIEW IF NOT EXISTS "${v}" AS ${sql}`);
  return { created: true, view: v };
}

async function refreshMaterializedView(viewName) {
  const v = normalizeIdentifierName(viewName);
  await pool.query(`REFRESH MATERIALIZED VIEW "${v}"`);
  return { refreshed: true };
}

async function enableRls(table) {
  const t = normalizeIdentifierName(table);
  await pool.query(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  return { enabled: true };
}

async function createRlsPolicy(table, policyName, usingSql = "true") {
  const t = normalizeIdentifierName(table);
  const p = normalizeIdentifierName(policyName);
  await pool.query(`DROP POLICY IF EXISTS "${p}" ON "${t}"`);
  await pool.query(`CREATE POLICY "${p}" ON "${t}" USING (${usingSql})`);
  return { created: true };
}

function createMcpServer() {
  const server = new McpServer({ name: "VO2QNAPDB", version: MCP_VERSION });

  function wrapTool(name, description, schema, handler) {
    server.tool(name, description, schema, async (args) => {
      metrics.toolCalls++;
      try { return await handler(args || {}); }
      catch (e) { metrics.errors++; throw e; }
    });
  }

  wrapTool("db_ping", "Test PostgreSQL connection.", {}, async () => {
    const r = await pool.query("SELECT now() AS now");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, now: r.rows[0].now, version: MCP_VERSION, pgcryptoAvailable, citextAvailable, postgisAvailable, vectorAvailable }, null, 2) }] };
  });

  wrapTool("list_tables", "List public database tables.", {}, async () => {
    const r = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("get_table_schema", "Get columns for a table.", { table: z.string() }, async ({ table }) => {
    const t = normalizeIdentifierName(table);
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [t]
    );
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("describe_database", "Describe database tables, columns, indexes and foreign keys. Use filter to narrow down to matching table names.", {
    filter: z.string().optional()
  }, async ({ filter }) => {
    // All queries in parallel — no N+1 loop
    const [tablesRes, colsRes, idxRes, fkRes] = await Promise.all([
      pool.query(
        filter
          ? `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE $1 ORDER BY table_name`
          : `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
        filter ? [`%${filter}%`] : []
      ),
      pool.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public'
         ORDER BY table_name, ordinal_position`
      ),
      pool.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`),
      pool.query(
        `SELECT tc.table_name, tc.constraint_name, kcu.column_name,
                ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
         WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`
      ),
    ]);

    // Group by table name
    const colsByTable = {};
    for (const r of colsRes.rows) {
      (colsByTable[r.table_name] ||= []).push({ column_name: r.column_name, data_type: r.data_type, is_nullable: r.is_nullable, column_default: r.column_default });
    }
    const idxByTable = {};
    for (const r of idxRes.rows) {
      (idxByTable[r.tablename] ||= []).push({ indexname: r.indexname, indexdef: r.indexdef });
    }
    const fkByTable = {};
    for (const r of fkRes.rows) {
      (fkByTable[r.table_name] ||= []).push({ constraint_name: r.constraint_name, column_name: r.column_name, foreign_table_name: r.foreign_table_name, foreign_column_name: r.foreign_column_name });
    }

    const out = tablesRes.rows.map(({ table_name }) => ({
      table: table_name,
      columns: colsByTable[table_name] || [],
      indexes: idxByTable[table_name] || [],
      foreignKeys: fkByTable[table_name] || [],
    }));

    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  wrapTool("schema_report", "Report schema gaps (missing BaseGuid / score columns) for all public tables. Use filter to narrow results.", {
    filter: z.string().optional()
  }, async ({ filter }) => {
    // Bulk fetch — 2 queries total instead of N+1
    const [tablesRes, colsRes, pkRes] = await Promise.all([
      pool.query(
        filter
          ? `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE $1 ORDER BY table_name`
          : `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
        filter ? [`%${filter}%`] : []
      ),
      pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`),
      pool.query(
        `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'`
      ),
    ]);

    const colsByTable = {};
    for (const r of colsRes.rows) {
      (colsByTable[r.table_name] ||= new Set()).add(r.column_name);
    }
    const pkByTable = {};
    for (const r of pkRes.rows) {
      (pkByTable[r.table_name] ||= []).push(r.column_name);
    }

    const SCORE_ALL = [...SCORE_COLUMNS, "ScoreUpdatedAt", "ScoreReason"];
    const report = tablesRes.rows.map(({ table_name }) => {
      const cols = colsByTable[table_name] || new Set();
      const pkCols = pkByTable[table_name] || [];
      return {
        table: table_name,
        missingBaseColumns: BASE_COLUMNS.filter(c => !cols.has(c)),
        missingScoreColumns: SCORE_ALL.filter(c => !cols.has(c)),
        primaryKey: pkCols,
        guidIsPrimaryKey: pkCols.length === 1 && pkCols[0] === "Guid",
      };
    });

    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  });

  wrapTool("ensure_table", "Create table if missing and ensure base structure.", { table: z.string() }, async ({ table }) => {
    await ensureTable(table);
    await audit("ensure_table", table, { table });
    return { content: [{ type: "text", text: `Table ${table} ready.` }] };
  });

  wrapTool("ensure_base_structure", "Ensure base columns, scores, indexes and trigger.", { table: z.string() }, async ({ table }) => {
    await ensureTable(table);
    return { content: [{ type: "text", text: `Base structure ensured for ${table}.` }] };
  });

  wrapTool("ensure_columns", "Add missing columns with type inference and FK autodetection.", { table: z.string(), data: z.record(z.any()) }, async ({ table, data }) => {
    await ensureColumnsInternal(table, data);
    return { content: [{ type: "text", text: `Columns ensured for ${table}.` }] };
  });

  wrapTool("find_records", "Find records by exact criteria.", { table: z.string(), criteria: z.record(z.any()), limit: z.number().optional() }, async ({ table, criteria, limit = 20 }) => {
    const rows = await findRecords(table, criteria, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  wrapTool("search_records", "Search records using SearchText and NormalizedName.", { table: z.string(), query: z.string(), limit: z.number().optional() }, async ({ table, query, limit = 20 }) => {
    const rows = await searchRecords(table, query, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  wrapTool("get_agent_historical_sample", "Return up to 100 older rows spread across entity tables related to the given agent.", {
    agentName: z.string(),
    entityTables: z.array(z.string()).optional(),
    totalLimit: z.number().optional()
  }, async ({ agentName, entityTables = [], totalLimit = 100 }) => {
    const result = await getAgentHistoricalSample({ agentName, entityTables, totalLimit });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("score_breakdown_report", "Explain score fields, limiting factors, and score warnings for a record.", {
    record: z.record(z.any())
  }, async ({ record }) => {
    const result = buildScoreBreakdown(record);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("score_breakdown_by_guid", "Load a record by table and Guid, then explain score fields, limiting factors, and score warnings.", {
    table: z.string(),
    guid: z.string()
  }, async ({ table, guid }) => {
    const result = await getScoreBreakdownByTableGuid(table, guid);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("prompt_upgrade_lifecycle_report", "Return a runtime prompt upgrade lifecycle audit report.", {
    promptName: z.string().optional(),
    activeRuntimePromptVersion: z.string(),
    canonicalPromptVersion: z.string(),
    fetchOk: z.boolean().optional(),
    verifyOk: z.boolean().optional(),
    compatibilityOk: z.boolean().optional(),
    activateOk: z.boolean().optional()
  }, async (args) => {
    const result = buildPromptUpgradeLifecycle630(args);
    runtimeGovernanceState.lastPromptUpgradeLifecycleReport = result;
    runtimeGovernanceState.lastPromptUpgradeLifecycleAt = new Date().toISOString();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("report_score_visibility_audit", "Audit whether a report exposes the required score fields and numeric visibility.", {
    reportType: z.string(),
    includedScores: z.array(z.string()).optional(),
    omittedNumericScores: z.boolean().optional(),
    materiallyDegraded: z.boolean().optional(),
    disputed: z.boolean().optional(),
    blocked: z.boolean().optional()
  }, async ({ reportType, includedScores = [], omittedNumericScores = false, materiallyDegraded = false, disputed = false, blocked = false }) => {
    const result = buildReportScoreVisibilityAudit({
      reportType,
      includedScores,
      omittedNumericScores,
      materiallyDegraded,
      disputed,
      blocked
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("preview_upsert_record", "Preview upsert. No write.", { table: z.string(), criteria: z.record(z.any()), data: z.record(z.any()) }, async ({ table, criteria, data }) => {
    const found = await findRecords(table, criteria, 1);
    return { content: [{ type: "text", text: JSON.stringify({ action: found.length > 0 ? "would_update" : "would_insert", existing: found[0] || null, criteria, data: normalizeScoreData(data) }, null, 2) }] };
  });

  wrapTool("validate_upsert_plan", "Validate planned upsert.", { table: z.string(), criteria: z.record(z.any()), data: z.record(z.any()) }, async ({ table, criteria, data }) => {
    const problems = [];
    try { normalizeIdentifierName(table); } catch (e) { problems.push(e.message); }
    if (!criteria || Object.keys(criteria).length === 0) problems.push("criteria must not be empty");

    for (const key of Object.keys({ ...(criteria || {}), ...(data || {}) })) {
      try { normalizeIdentifierName(key); } catch (e) { problems.push(e.message); }
    }

    for (const col of SCORE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(data || {}, col)) {
        const n = Number(data[col]);
        if (!Number.isFinite(n) || n < 0 || n > 100) problems.push(`${col} must be between 0 and 100.`);
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ ok: problems.length === 0, problems }, null, 2) }] };
  });

  wrapTool("upsert_record", "Insert or update by criteria.", { table: z.string(), criteria: z.record(z.any()), data: z.record(z.any()) }, async ({ table, criteria, data }) => {
    const result = await upsertRecord(table, criteria, data);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("smart_upsert_batch", "Batch upsert records. All writes execute in a single DB transaction — on error every record is rolled back.", { table: z.string(), records: z.array(z.object({ criteria: z.record(z.any()), data: z.record(z.any()) })) }, async ({ table, records }) => {
    if (records.length > MAX_BATCH_SIZE) throw new Error(`Batch too large. Max ${MAX_BATCH_SIZE}.`);
    // Phase 1: ensure schema for all records outside the transaction (DDL is idempotent)
    for (const record of records) {
      await ensureColumnsInternal(table, { ...(record.criteria || {}), ...(record.data || {}) });
    }
    // Phase 2: all DML in a single transaction on a dedicated client
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const record of records) results.push(await upsertRecord(table, record.criteria, record.data, false, client));
      await client.query("COMMIT");
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  wrapTool("infer_schema", "Infer columns and PostgreSQL types from JSON.", { sample: z.record(z.any()) }, async ({ sample }) => {
    const explicitTypes = sample.ColumnTypes && typeof sample.ColumnTypes === "object" ? sample.ColumnTypes : {};
    const inferred = {};
    for (const [key, value] of Object.entries(sample)) {
      if (key === "ColumnTypes") continue;
      inferred[normalizeIdentifierName(key)] = pgType(value, key, explicitTypes);
    }
    return { content: [{ type: "text", text: JSON.stringify(inferred, null, 2) }] };
  });

  wrapTool("normalize_record", "Normalize record keys.", { data: z.record(z.any()) }, async ({ data }) => {
    const normalized = {};
    for (const [key, value] of Object.entries(data)) normalized[normalizeIdentifierName(key)] = value;
    return { content: [{ type: "text", text: JSON.stringify(normalized, null, 2) }] };
  });

  wrapTool("validate_data", "Validate common data and scores.", { data: z.record(z.any()) }, async ({ data }) => {
    const warnings = [];
    if (data.VIN && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(String(data.VIN))) warnings.push("VIN should be 17 chars and exclude I, O, Q.");
    for (const col of SCORE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(data, col)) {
        const n = Number(data[col]);
        if (!Number.isFinite(n) || n < 0 || n > 100) warnings.push(`${col} must be 0-100.`);
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: warnings.length === 0, warnings }, null, 2) }] };
  });

  wrapTool("deduplicate_table", "Find duplicate groups.", { table: z.string(), columns: z.array(z.string()) }, async ({ table, columns }) => {
    const t = normalizeIdentifierName(table);
    const tableCols = await getColumns(t);
    const missing = ["Guid", "CreatedAt", "IsDeleted"].filter(c => !tableCols.has(c));
    if (missing.length > 0) {
      throw new Error(`deduplicate_table requires BaseGuid columns missing from "${t}": ${missing.join(", ")}. Run ensure_base_structure first.`);
    }
    const safeColumns = columns.map(normalizeIdentifierName);
    const colsSql = safeColumns.map(c => `"${c}"`).join(", ");
    const r = await pool.query(`
      SELECT ${colsSql}, COUNT(*) AS count, ARRAY_AGG("Guid" ORDER BY "CreatedAt") AS guids
      FROM "${t}"
      WHERE "IsDeleted"=false
      GROUP BY ${colsSql}
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `);
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("table_stats", "Return row count (fast estimate) and last update.", { table: z.string() }, async ({ table }) => {
    const t = normalizeIdentifierName(table);
    const cols = await getColumns(t);
    const hasIsDeleted = cols.has("IsDeleted");
    const hasUpdatedAt = cols.has("UpdatedAt");

    // Fast estimate from pg_class, exact COUNT only for small tables (<50k rows)
    const est = await pool.query(
      `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname=$1 AND relnamespace='public'::regnamespace`,
      [t]
    );
    const estimate = Number(est.rows[0]?.estimate ?? -1);
    let row_count, exact;
    if (estimate < 50000) {
      const countSql = hasIsDeleted
        ? `SELECT COUNT(*)::int AS row_count FROM "${t}" WHERE "IsDeleted"=false`
        : `SELECT COUNT(*)::int AS row_count FROM "${t}"`;
      const r = await pool.query(countSql);
      row_count = r.rows[0].row_count;
      exact = true;
    } else {
      row_count = estimate;
      exact = false;
    }
    const last_update = hasUpdatedAt
      ? (await pool.query(`SELECT MAX("UpdatedAt") AS last_update FROM "${t}"`)).rows[0]?.last_update
      : null;
    return { content: [{ type: "text", text: JSON.stringify({ table: t, row_count, exact, last_update }, null, 2) }] };
  });

  wrapTool("run_select_sql", "Run safe read-only SELECT SQL.", { sql: z.string() }, async ({ sql }) => {
    assertSelectSql(sql);
    const r = await pool.query(sql);
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("list_indexes", "List indexes for a table.", { table: z.string() }, async ({ table }) => {
    const t = normalizeIdentifierName(table);
    const r = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`, [t]);
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("create_index", "Create safe index.", { table: z.string(), columns: z.array(z.string()), unique: z.boolean().optional() }, async ({ table, columns, unique = false }) => {
    const t = normalizeIdentifierName(table);
    const safeColumns = columns.map(normalizeIdentifierName);
    const indexName = normalizeIdentifierName(`${unique ? "uniq" : "idx"}_${t}_${safeColumns.join("_")}`).slice(0, 60);
    const cols = safeColumns.map(c => `"${c}"`).join(", ");
    await pool.query(`CREATE ${unique ? "UNIQUE" : ""} INDEX IF NOT EXISTS "${indexName}" ON "${t}" (${cols})`);
    return { content: [{ type: "text", text: `Index ${indexName} ready.` }] };
  });

  wrapTool("create_unique_index", "Create unique index.", { table: z.string(), columns: z.array(z.string()) }, async ({ table, columns }) => {
    const t = normalizeIdentifierName(table);
    const safeColumns = columns.map(normalizeIdentifierName);
    const indexName = normalizeIdentifierName(`uniq_${t}_${safeColumns.join("_")}`).slice(0, 60);
    const cols = safeColumns.map(c => `"${c}"`).join(", ");
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${t}" (${cols})`);
    return { content: [{ type: "text", text: `Unique index ${indexName} ready.` }] };
  });

  wrapTool("create_foreign_key", "Create FK.", { table: z.string(), column: z.string(), refTable: z.string(), refColumn: z.string().optional() }, async ({ table, column, refTable, refColumn = "Guid" }) => {
    const name = await createForeignKey(table, column, refTable, refColumn);
    return { content: [{ type: "text", text: `Foreign key ${name} ready.` }] };
  });

  wrapTool("list_foreign_keys", "List FKs.", { table: z.string() }, async ({ table }) => {
    const t = normalizeIdentifierName(table);
    const r = await pool.query(
      `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
       WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND tc.table_name=$1
       ORDER BY tc.constraint_name`,
      [t]
    );
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("audit_log", "Write custom audit event.", { action: z.string(), table: z.string(), data: z.record(z.any()).optional() }, async ({ action, table, data = {} }) => {
    await audit(action, table, data);
    return { content: [{ type: "text", text: "Audit log written." }] };
  });

  wrapTool("get_recent_changes", "Get recent audit log entries.", { limit: z.number().optional() }, async ({ limit = 50 }) => {
    const r = await pool.query(`SELECT * FROM "AuditLog" ORDER BY "CreatedAt" DESC LIMIT $1`, [safeLimit(limit, 200)]);
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("export_table", "Export rows as JSON.", { table: z.string(), limit: z.number().optional() }, async ({ table, limit = 100 }) => {
    const rows = await findRecords(table, {}, safeLimit(limit, MAX_EXPORT_ROWS));
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  wrapTool("reindex_table", "REINDEX TABLE.", { table: z.string() }, async ({ table }) => {
    const t = normalizeIdentifierName(table);
    await pool.query(`REINDEX TABLE "${t}"`);
    return { content: [{ type: "text", text: `Table ${t} reindexed.` }] };
  });

  wrapTool("soft_delete_record", "Soft delete by criteria.", { table: z.string(), criteria: z.record(z.any()) }, async ({ table, criteria }) => {
    const result = await softDeleteRecord(table, criteria);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("save_image_base64", "Save image to QNAP uploads and store metadata.", {
    entityTable: z.string(),
    entityGuid: z.string(),
    base64: z.string(),
    mimeType: z.string().optional(),
    originalFileName: z.string().optional()
  }, async ({ entityTable, entityGuid, base64, mimeType = "image/png", originalFileName = "image" }) => {
    const result = await saveImage({ entityTable, entityGuid, base64, mimeType, originalFileName });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("list_entity_images", "List images for an entity.", { entityTable: z.string(), entityGuid: z.string() }, async ({ entityTable, entityGuid }) => {
    const rows = await findRecords("EntityImages", { EntityTable: entityTable, EntityGuid: entityGuid }, 100);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  wrapTool("record_migration", "Run and record migration SQL.", { migrationName: z.string(), sql: z.string() }, async ({ migrationName, sql }) => {
    const result = await recordMigration(migrationName, sql);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("enqueue_job", "Add job to JobQueue.", { jobType: z.string(), payload: z.record(z.any()), runAt: z.string().optional() }, async ({ jobType, payload, runAt }) => {
    const result = await enqueueJob(jobType, payload, runAt);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("list_jobs", "List jobs.", { status: z.string().optional(), limit: z.number().optional() }, async ({ status = "queued", limit = 50 }) => {
    const rows = await findRecords("JobQueue", { Status: status }, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  wrapTool("create_materialized_view", "Create materialized view from SELECT SQL.", { viewName: z.string(), sql: z.string() }, async ({ viewName, sql }) => {
    const result = await createMaterializedView(viewName, sql);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("refresh_materialized_view", "Refresh materialized view.", { viewName: z.string() }, async ({ viewName }) => {
    const result = await refreshMaterializedView(viewName);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("enable_rls", "Enable row-level security.", { table: z.string() }, async ({ table }) => {
    const result = await enableRls(table);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("create_rls_policy", "Create RLS policy.", { table: z.string(), policyName: z.string(), usingSql: z.string().optional() }, async ({ table, policyName, usingSql = "true" }) => {
    const result = await createRlsPolicy(table, policyName, usingSql);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });


  wrapTool("save_image_url", "Download image from URL to QNAP uploads and store metadata.", {
    entityTable: z.string(),
    entityGuid: z.string(),
    imageUrl: z.string(),
    originalFileName: z.string().optional()
  }, async ({ entityTable, entityGuid, imageUrl, originalFileName = "image" }) => {
    const result = await saveImageUrl({ entityTable, entityGuid, imageUrl, originalFileName });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("claim_next_job", "Atomically claim the next queued job using FOR UPDATE SKIP LOCKED.", {
    status: z.string().optional()
  }, async ({ status = "queued" }) => {
    const result = await claimNextJob(status);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("complete_job", "Mark a job as completed and store result metadata.", {
    jobGuid: z.string(),
    result: z.record(z.any()).optional()
  }, async ({ jobGuid, result = {} }) => {
    const updated = await completeJob(jobGuid, result);
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  });

  wrapTool("fail_job", "Mark a job failed; retry until MaxRetries, then move to DeadLetterQueue.", {
    jobGuid: z.string(),
    error: z.string()
  }, async ({ jobGuid, error }) => {
    const result = await failJob(jobGuid, error);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("retry_job", "Reset a failed/running/dead-letter job back to queued.", {
    jobGuid: z.string(),
    runAt: z.string().optional()
  }, async ({ jobGuid, runAt = null }) => {
    const result = await retryJob(jobGuid, runAt);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("move_job_to_dead_letter", "Move a job to DeadLetterQueue immediately.", {
    jobGuid: z.string(),
    error: z.string().optional()
  }, async ({ jobGuid, error = "manual dead letter" }) => {
    const result = await moveJobToDeadLetter(jobGuid, error);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("list_dead_letters", "List dead-letter queue entries.", {
    limit: z.number().optional()
  }, async ({ limit = 50 }) => {
    const rows = await findRecords("DeadLetterQueue", {}, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  });

  wrapTool("list_rls_status", "List row-level security status for public tables.", {
    table: z.string().optional()
  }, async ({ table = null }) => {
    const result = await listRlsStatus(table);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("disable_rls", "Disable row-level security for a table.", {
    table: z.string()
  }, async ({ table }) => {
    const result = await disableRls(table);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("drop_rls_policy", "Drop an RLS policy from a table.", {
    table: z.string(),
    policyName: z.string()
  }, async ({ table, policyName }) => {
    const result = await dropRlsPolicy(table, policyName);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("create_partitioned_table", "Create a range-partitioned table by date column.", {
    table: z.string(),
    partitionColumn: z.string().optional()
  }, async ({ table, partitionColumn = "TargetDate" }) => {
    const result = await createPartitionedTable(table, partitionColumn);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("create_date_partition", "Create a date range partition for a partitioned table.", {
    table: z.string(),
    partitionName: z.string(),
    fromDate: z.string(),
    toDate: z.string()
  }, async ({ table, partitionName, fromDate, toDate }) => {
    const result = await createDatePartition(table, partitionName, fromDate, toDate);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("shard_plan", "Return a sharding plan and metadata convention for a table.", {
    table: z.string(),
    shardKey: z.string().optional(),
    shardCount: z.number().optional()
  }, async ({ table, shardKey = "ShardKey", shardCount = 4 }) => {
    const result = shardPlan(table, shardKey, shardCount);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  wrapTool("validate_sql_safety", "Validate SELECT or migration SQL safety without executing it.", {
    sql: z.string(),
    mode: z.enum(["select", "migration"]).optional()
  }, async ({ sql, mode = "select" }) => {
    if (mode === "select") assertSelectSql(sql);
    else assertSafeMigrationSql(sql);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, mode }, null, 2) }] };
  });

  wrapTool("invalidate_schema_cache", "Clear schema cache.", { table: z.string().optional() }, async ({ table }) => {
    invalidateSchema(table || null);
    return { content: [{ type: "text", text: table ? `Schema cache cleared for ${table}.` : "Schema cache cleared." }] };
  });

  wrapTool("score_columns", "List score columns.", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify(SCORE_COLUMNS, null, 2) }] };
  });

  wrapTool("send_notification", "Send a notification to ntfy.vo2info.cz.", {
    topic:    z.enum(["agent-runs", "agent-errors", "agent-alerts", "agent-maintenance", "qnap-health", "qnap-alerts"]),
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
      const res = await fetch(ntfyUrl, {
        method: "POST",
        headers,
        body,
      });
      status = res.status;
      responseText = await res.text();
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }, null, 2) }] };
    }
    const ok = status >= 200 && status < 300;
    return { content: [{ type: "text", text: JSON.stringify({ ok, status, topic, title, response: responseText }, null, 2) }] };
  });

  wrapTool("rate_limit_guard", "Show limits and safety rules.", {}, async () => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          version: MCP_VERSION,
          maxBatchSize: MAX_BATCH_SIZE,
          maxExportRows: MAX_EXPORT_ROWS,
          maxImageBytes: MAX_IMAGE_BYTES,
          uploadDir: UPLOAD_DIR,
          publicUploadBaseUrl: PUBLIC_UPLOAD_BASE_URL,
          rawWriteSqlAllowed: false,
          deleteAllowed: false,
          dropAllowed: false,
          truncateAllowed: false,
          softDeleteAllowed: true,
          pgcryptoAvailable,
          citextAvailable,
          postgisAvailable,
          vectorAvailable,
          supportsImageUrlDownload: true,
          supportsJobRetryTools: true,
          supportsPartitioningHelpers: true,
          supportsShardingPlan: true
        }, null, 2)
      }]
    };
  });

  wrapTool("sheets_get_values", "Read all rows from a Google Sheet. Returns array of rows (each row is array of cell strings). Row 0 is the header.", {
    spreadsheetId: z.string().describe("Spreadsheet ID (from URL or sheets_create_spreadsheet)"),
    range: z.string().default("Sheet1").describe("Sheet name or A1 range, e.g. 'Sheet1' or 'Sheet1!A1:E'"),
  }, async ({ spreadsheetId, range }) => {
    const data = await sheetsGet(`spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    const values = data.values || [];
    return { content: [{ type: "text", text: JSON.stringify({ spreadsheetId, range, rowCount: values.length, values }, null, 2) }] };
  });

  wrapTool("sheets_append_rows", "Append one or more rows to a Google Sheet. Each row is an array of cell strings.", {
    spreadsheetId: z.string(),
    range: z.string().default("Sheet1").describe("Sheet name, e.g. 'Sheet1'"),
    rows: z.array(z.array(z.string())).describe("Array of rows; each row is array of cell values"),
  }, async ({ spreadsheetId, range, rows }) => {
    const data = await sheetsPost(
      `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: rows }
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, updatedRows: data.updates?.updatedRows ?? rows.length, spreadsheetId }, null, 2) }] };
  });

  wrapTool("sheets_update_row", "Update a specific range in a Google Sheet. Use A1 notation for the range, e.g. 'Sheet1!A3:E3'.", {
    spreadsheetId: z.string(),
    range: z.string().describe("A1 range to update, e.g. 'Sheet1!A3:E3'"),
    values: z.array(z.string()).describe("Cell values for the row (one cell per column in range)"),
  }, async ({ spreadsheetId, range, values }) => {
    const data = await sheetsPut(
      `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { values: [values] }
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, updatedCells: data.updatedCells, range }, null, 2) }] };
  });

  wrapTool("sheets_find_row", "Find a row in a Google Sheet by matching a value in a specific column. Returns 1-based rowIndex and rowValues.", {
    spreadsheetId: z.string(),
    sheetName: z.string().default("Sheet1"),
    column: z.number().int().min(0).describe("0-based column index to search in"),
    value: z.string().describe("Value to match (case-insensitive exact match)"),
  }, async ({ spreadsheetId, sheetName, column, value }) => {
    const data = await sheetsGet(`spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}`);
    const rows = data.values || [];
    const lv = value.toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][column] ?? "").toLowerCase() === lv) {
        return { content: [{ type: "text", text: JSON.stringify({ found: true, rowIndex: i + 1, rowValues: rows[i] }, null, 2) }] };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ found: false, rowIndex: null, searchedRows: rows.length }, null, 2) }] };
  });

  wrapTool("sheets_create_spreadsheet", "Create a new Google Spreadsheet and move it to a Drive folder. Returns spreadsheetId and URL.", {
    title: z.string().describe("Spreadsheet title, e.g. '{AgentName}_entities'"),
    folderId: z.string().optional().describe("Drive folder ID to place the spreadsheet in"),
    sheets: z.array(z.string()).optional().describe("Sheet (tab) names, default ['Sheet1']"),
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
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, spreadsheetId, title, folderId: folderId ?? null, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` }, null, 2) }] };
  });

  wrapTool("log_run", "Log agent run result to AgentMonitor DB. Call at the end of every run.", {
    agent_name:     z.string().describe("Agent name, e.g. SportGameCatalog"),
    agent_type:     z.string().optional().describe("Catalog, Manager, Importer, Generator, Collector, Checker"),
    prompt_version: z.string().optional(),
    status:         z.enum(["success", "partial", "error", "critical"]),
    inserted:       z.number().int().optional().default(0),
    updated:        z.number().int().optional().default(0),
    errors:         z.number().int().optional().default(0),
    duration_s:     z.number().optional().describe("Run duration in seconds"),
    notes:          z.string().optional(),
  }, async ({ agent_name, agent_type, prompt_version, status, inserted = 0, updated = 0, errors = 0, duration_s, notes }) => {
    if (!monPool) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "AGENT_MONITOR_URL not configured" }) }] };
    const r = await monPool.query(
      `INSERT INTO agent_runs (agent_name, agent_type, prompt_version, status, inserted, updated, errors, duration_s, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, run_at`,
      [agent_name, agent_type || null, prompt_version || null, status, inserted, updated, errors, duration_s || null, notes || null]
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, run_id: r.rows[0].id, run_at: r.rows[0].run_at }, null, 2) }] };
  });

  wrapTool("set_agent_status", "Update agent status in monitoring DB. Call at run start (running) and end (idle/error).", {
    agent_name:  z.string(),
    status:      z.enum(["idle", "running", "error", "disabled"]),
    details:     z.string().optional(),
    last_run_id: z.number().int().optional(),
  }, async ({ agent_name, status, details, last_run_id }) => {
    if (!monPool) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "AGENT_MONITOR_URL not configured" }) }] };
    await monPool.query(
      `INSERT INTO agent_status (agent_name, status, details, last_run_id, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (agent_name) DO UPDATE
         SET status=EXCLUDED.status, details=EXCLUDED.details, last_run_id=EXCLUDED.last_run_id, updated_at=NOW()`,
      [agent_name, status, details || null, last_run_id || null]
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, agent_name, status }, null, 2) }] };
  });

  wrapTool("schedule_run", "Schedule next agent run at specific datetime. Cron will pick it up.", {
    agent_name: z.string(),
    run_at:     z.string().describe("ISO 8601 datetime, e.g. 2026-06-14T18:00:00Z"),
    notes:      z.string().optional(),
  }, async ({ agent_name, run_at, notes }) => {
    if (!monPool) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "AGENT_MONITOR_URL not configured" }) }] };
    const r = await monPool.query(
      `INSERT INTO agent_schedule (agent_name, run_at, notes) VALUES ($1,$2,$3) RETURNING id`,
      [agent_name, run_at, notes || null]
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, schedule_id: r.rows[0].id, agent_name, run_at }, null, 2) }] };
  });

  wrapTool("send_email", "Send email via SMTP. Use for important alerts, weekly digest, or failures.", {
    subject: z.string(),
    body:    z.string(),
    to:      z.string().optional().describe("Recipient email, defaults to EMAIL_DEFAULT_TO env var"),
    html:    z.boolean().optional().describe("Set true if body is HTML"),
  }, async ({ subject, body, to, html = false }) => {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS" }) }] };
    const recipient = to || EMAIL_DEFAULT_TO;
    if (!recipient) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "No recipient — pass to param or set EMAIL_DEFAULT_TO" }) }] };
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    const info = await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER, to: recipient, subject,
      ...(html ? { html: body } : { text: body }),
    });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, messageId: info.messageId, to: recipient }, null, 2) }] };
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
    const data = { SpreadsheetId: spreadsheet_id ?? null, DriveFolder: drive_folder ?? null, Sheets: sheets ?? null, IsActive: is_active, UpdatedAt: new Date() };
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

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use((req, res, next) => {
  res.setTimeout(45000, () => {
    if (!res.headersSent) res.status(503).json({ error: "Request timeout" });
  });
  metrics.requests++;
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", name: "VO2QNAPDB MCP", version: MCP_VERSION });
});

app.get("/ping", (req, res) => {
  res.json({ ok: true, version: MCP_VERSION });
});

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT now() AS now");
    res.json({
      status: "ok",
      version: MCP_VERSION,
      db: "ok",
      now: r.rows[0].now,
      uptime: process.uptime(),
      hostname: os.hostname(),
      pgcryptoAvailable,
      citextAvailable,
      postgisAvailable,
      vectorAvailable,
      promptUpgradeLifecycle: runtimeGovernanceState.lastPromptUpgradeLifecycleReport,
      promptUpgradeLifecycleCheckedAt: runtimeGovernanceState.lastPromptUpgradeLifecycleAt
    });
  } catch (e) {
    if (res.headersSent) return;
    res.status(500).json({
      status: "error",
      version: MCP_VERSION,
      db: "error",
      error: e.message,
      promptUpgradeLifecycle: runtimeGovernanceState.lastPromptUpgradeLifecycleReport,
      promptUpgradeLifecycleCheckedAt: runtimeGovernanceState.lastPromptUpgradeLifecycleAt
    });
  }
});

app.get("/metrics", (req, res) => {
  res.json({
    ...metrics,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    schemaCacheSize: schemaCache.size,
    promptUpgradeLifecycle: runtimeGovernanceState.lastPromptUpgradeLifecycleReport,
    promptUpgradeLifecycleCheckedAt: runtimeGovernanceState.lastPromptUpgradeLifecycleAt
  });
});

app.post("/mcp", async (req, res) => {
  if (!AUTH_TOKEN) {
    return res.status(500).json({ status: "error", version: MCP_VERSION, error: "AUTH_TOKEN is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Normalize Accept header — Claude.ai and some MCP clients omit text/event-stream.
  // @hono/node-server reads from rawHeaders (not headers), so both must be updated.
  if (!req.headers["accept"] || !req.headers["accept"].includes("text/event-stream")) {
    req.headers["accept"] = "application/json, text/event-stream";
    const idx = req.rawHeaders.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === "accept");
    if (idx === -1) req.rawHeaders.push("Accept", "application/json, text/event-stream");
    else req.rawHeaders[idx + 1] = "application/json, text/event-stream";
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on("close", async () => {
    await transport.close();
    await server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP handler error', message: err.message });
    }
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`VO2QNAPDB MCP ${MCP_VERSION} running on port ${PORT}`);
});

async function initDbWithRetry(attempt = 1) {
  try {
    await initDb();
    console.log(`VO2QNAPDB MCP ${MCP_VERSION} DB initialized OK`);
  } catch (err) {
    const delay = Math.min(attempt * 5000, 60000);
    console.warn(`DB init attempt ${attempt} failed (${err.message}) — retry in ${delay / 1000}s`);
    setTimeout(() => initDbWithRetry(attempt + 1), delay);
  }
}

initDbWithRetry()
  .then(() => startSheetsSyncLoop())
  .catch(err => {
    console.error("Unexpected error in initDbWithRetry:", err);
  });


// ============================================================================
// Enterprise Governance Extension Registry 5.3.0
// Non-breaking registry additions for release, capability negotiation, runtime
// modes, temporal validity, evidence graphs and advanced sports governance.
// Existing runtime behavior is preserved.
// ============================================================================

const ENTERPRISE_GOVERNANCE_VERSION_530 = "5.3.0";

const ENTERPRISE_RUNTIME_MODES_530 = [
  "safe_mode",
  "read_only_mode",
  "dry_run_mode",
  "repair_mode",
  "migration_mode",
  "archive_mode",
  "live_mode",
  "forensic_mode",
  "emergency_mode",
  "degraded_mode",
  "scheduled_mode",
  "manual_operator_mode"
];

const ENTERPRISE_CAPABILITY_CLASSES_530 = [
  "required",
  "optional",
  "fallback",
  "deprecated",
  "experimental",
  "unsupported",
  "forbidden"
];

const ENTERPRISE_TEMPORAL_FIELDS_530 = [
  "ValidFrom",
  "ValidTo",
  "ObservedAt",
  "PublishedAt",
  "ExtractedAt",
  "CorrectedAt",
  "SupersededAt",
  "ArchivedAt",
  "EffectiveFrom",
  "EffectiveTo",
  "KnowledgeEpoch"
];

const ENTERPRISE_EVIDENCE_NODE_TYPES_530 = [
  "source",
  "excerpt",
  "document",
  "dataset",
  "entity",
  "relation",
  "transformation",
  "validation",
  "view",
  "report",
  "highlight",
  "approval",
  "warning",
  "blocker"
];

const SPORTS_MATCH_STATES_530 = [
  "scheduled",
  "pregame",
  "live",
  "halftime",
  "overtime",
  "penalty_shootout",
  "delayed",
  "postponed",
  "suspended",
  "abandoned",
  "canceled",
  "walkover",
  "forfeited",
  "completed",
  "official_final",
  "corrected_final",
  "disputed",
  "annulled"
];

const SPORTS_ARCHIVE_CONFIDENCE_TIERS_530 = [
  "official",
  "federation_verified",
  "league_verified",
  "club_verified",
  "archive_verified",
  "newspaper_verified",
  "structured_provider",
  "community_verified",
  "OCR_only",
  "inferred",
  "speculative"
];

const ENTERPRISE_530_TOOLS = [
  "release_governance_report",
  "prompt_integrity_report",
  "runtime_contract_report",
  "data_retention_report",
  "privacy_pii_report",
  "licensing_copyright_report",
  "evaluation_framework_report",
  "rollback_recovery_plan",
  "data_contract_version_report",
  "operator_ux_report",
  "risk_acceptance_report",
  "quarantine_report",
  "release_readiness_check",
  "capability_negotiation_report",
  "runtime_mode_report",
  "advanced_confidence_propagation_report",
  "semantic_identity_report",
  "event_timeline_report",
  "autonomous_repair_report",
  "multi_agent_coordination_report",
  "runtime_budget_report",
  "temporal_validity_report",
  "evidence_graph_report",
  "compatibility_matrix_report",
  "scheduled_language_policy_report",
  "critical_missing_capability_report",
  "match_state_machine_report",
  "historical_corrections_report",
  "transfer_registration_report",
  "competition_format_report",
  "betting_odds_governance_report",
  "fantasy_simulation_report",
  "sports_ontology_expansion_report",
  "live_data_reliability_report",
  "archive_confidence_tiers_report",
  "hall_of_fame_legacy_lineage_report",
  "sports_weather_venue_context_report"
];

const ENTERPRISE_530_TABLES = [
  "ReleaseGovernance",
  "PromptIntegrity",
  "RuntimeContracts",
  "DataRetentionPolicies",
  "PrivacyAssessments",
  "LicensingAssessments",
  "EvaluationMetrics",
  "RollbackPlans",
  "RecoveryActions",
  "DataContractVersions",
  "OperatorUxProfiles",
  "RiskAcceptances",
  "QuarantineRecords",
  "ReleaseReadinessChecks",
  "CapabilityNegotiationLog",
  "RuntimeModeExecutions",
  "AdvancedConfidencePropagation",
  "SemanticIdentityStates",
  "EntityTimelineEvents",
  "AutonomousRepairActions",
  "MultiAgentCoordinationLocks",
  "RuntimeBudgets",
  "TemporalValidityRecords",
  "EvidenceGraphNodes",
  "EvidenceGraphEdges",
  "PromptRuntimeCompatibilityMatrix",
  "ScheduledLanguagePolicy",
  "CriticalMissingCapabilities",
  "MatchStateTransitions",
  "HistoricalCorrections",
  "TransferRegistrations",
  "CompetitionFormats",
  "BettingOddsSignals",
  "FantasySimulationRegistry",
  "SportsOntologyTerms",
  "LiveDataReliability",
  "ArchiveConfidenceTiers",
  "LegacyLineageRecords",
  "SportsVenueWeatherContext"
];

function normalizeRuntimeMode530(mode = "safe_mode") {
  const value = String(mode || "safe_mode");
  return ENTERPRISE_RUNTIME_MODES_530.includes(value) ? value : "degraded_mode";
}

function classifyCapability530(input = {}) {
  const capabilityClass = String(input.capabilityClass || "optional");
  return {
    name: String(input.name || "unknown"),
    capabilityClass: ENTERPRISE_CAPABILITY_CLASSES_530.includes(capabilityClass) ? capabilityClass : "optional",
    verified: Boolean(input.verified),
    available: Boolean(input.available),
    warning: input.warning || null,
    blocker: Boolean(input.blocker),
    checkedAt: input.checkedAt || new Date().toISOString()
  };
}

function isValidSportsMatchState530(state) {
  return SPORTS_MATCH_STATES_530.includes(String(state || ""));
}

function normalizeReleaseReadiness530(input = {}) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  const blockers = checks.filter(x => x && (x.blocker === true || x.status === "warning_blocker" || x.severity === "CRITICAL" || x.severity === "HIGH"));
  return {
    version: input.version || ENTERPRISE_GOVERNANCE_VERSION_530,
    ready: blockers.length === 0,
    blockers,
    checkedAt: input.checkedAt || new Date().toISOString()
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.ENTERPRISE_GOVERNANCE_VERSION_530 = ENTERPRISE_GOVERNANCE_VERSION_530;
  module.exports.ENTERPRISE_RUNTIME_MODES_530 = ENTERPRISE_RUNTIME_MODES_530;
  module.exports.ENTERPRISE_CAPABILITY_CLASSES_530 = ENTERPRISE_CAPABILITY_CLASSES_530;
  module.exports.ENTERPRISE_TEMPORAL_FIELDS_530 = ENTERPRISE_TEMPORAL_FIELDS_530;
  module.exports.ENTERPRISE_EVIDENCE_NODE_TYPES_530 = ENTERPRISE_EVIDENCE_NODE_TYPES_530;
  module.exports.SPORTS_MATCH_STATES_530 = SPORTS_MATCH_STATES_530;
  module.exports.SPORTS_ARCHIVE_CONFIDENCE_TIERS_530 = SPORTS_ARCHIVE_CONFIDENCE_TIERS_530;
  module.exports.ENTERPRISE_530_TOOLS = ENTERPRISE_530_TOOLS;
  module.exports.ENTERPRISE_530_TABLES = ENTERPRISE_530_TABLES;
  module.exports.normalizeRuntimeMode530 = normalizeRuntimeMode530;
  module.exports.classifyCapability530 = classifyCapability530;
  module.exports.isValidSportsMatchState530 = isValidSportsMatchState530;
  module.exports.normalizeReleaseReadiness530 = normalizeReleaseReadiness530;
}

// ============================================================================
// Repository Distribution Prompt Diagnostics 5.4.0
// Repository mirrors remain distribution-only diagnostics and must not be used
// as prompt activation sources.
// ============================================================================

const PROMPT_SYNC_GOVERNANCE_VERSION_540 = "5.4.0";
const CANONICAL_GOVERNANCE_DRIVE_FOLDER_540 = "https://drive.google.com/drive/u/0/folders/1GKqFES4r1zoEBsWjfOD0qs2-Tc08a8xQ";
const CATALOG_PROMPT_REPO_PATH_540 = "CommonCatalog/CatalogPrompt.txt";
const MANAGER_PROMPT_REPO_PATH_540 = "SportManager/ManagerPrompt.txt";
const CATALOG_PROMPT_SKILLS_REPO_PATH_540 = "CommonCatalog/CatalogPromptSkills.txt";
const MANAGER_PROMPT_SKILLS_REPO_PATH_540 = "SportManager/ManagerPromptSkills.txt";
// Legacy aliases for backward compatibility
const COMMON_PROMPT_REPO_PATH_540 = CATALOG_PROMPT_REPO_PATH_540;
const SPORT_PROMPT_REPO_PATH_540 = MANAGER_PROMPT_REPO_PATH_540;

const CANONICAL_PROMPT_MANIFEST_540 = {
  governanceVersion: PROMPT_SYNC_GOVERNANCE_VERSION_540,
  canonicalDriveFolder: CANONICAL_GOVERNANCE_DRIVE_FOLDER_540,
  prompts: {
    CatalogPrompt: {
      canonicalDocumentId: "1PrTRbf0yiBb7_ShC1LR1TVb0CoIA8FAShafr1jVvhwY",
      canonicalDocumentUrl: "https://docs.google.com/document/d/1PrTRbf0yiBb7_ShC1LR1TVb0CoIA8FAShafr1jVvhwY/edit?usp=drivesdk",
      distributionRepoPath: CATALOG_PROMPT_REPO_PATH_540,
      skillsRepoPath: CATALOG_PROMPT_SKILLS_REPO_PATH_540,
      activationSource: "google_drive_canonical_document",
      agentPattern: "Agent: x.y.z Catalog of [TOPIC_1], [TOPIC_2], [TOPIC_3], [TOPIC_4], [TOPIC_5]",
      minimumBaselineEntityCount: 25
    },
    ManagerPrompt: {
      canonicalDocumentId: "1NVBWFa9it6oRpkwuHlfnj4io-kQNLrWrWkC4LZkn8t8",
      canonicalDocumentUrl: "https://docs.google.com/document/d/1NVBWFa9it6oRpkwuHlfnj4io-kQNLrWrWkC4LZkn8t8/edit?usp=drivesdk",
      distributionRepoPath: MANAGER_PROMPT_REPO_PATH_540,
      skillsRepoPath: MANAGER_PROMPT_SKILLS_REPO_PATH_540,
      activationSource: "google_drive_canonical_document",
      agentPattern: "Agent: x.y.z [SPORT_NAME] Data Manager",
      minimumBaselineEntityCount: 25
    },
    // Legacy aliases — resolved to canonical names above
    CommonPrompt: null,
    SportPrompt: null
  }
};

function parseSemver540(version) {
  const value = String(version || "").trim();
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver540(left, right) {
  const a = parseSemver540(left);
  const b = parseSemver540(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

function buildCanonicalPromptManifest540() {
  return {
    ...CANONICAL_PROMPT_MANIFEST_540,
    serverVersion: MCP_VERSION,
    generatedAt: new Date().toISOString()
  };
}

function buildPromptSyncDecision540(input = {}) {
  const promptName = String(input.promptName || "CatalogPrompt");
  const activePromptVersion = String(input.activePromptVersion || "");
  const repoPromptVersion = String(input.repoPromptVersion || "");
  const canonicalPromptVersion = String(input.canonicalPromptVersion || "");
  const repoPromptPath = String(input.repoPromptPath || (promptName === "ManagerPrompt" || promptName === "SportPrompt" ? MANAGER_PROMPT_REPO_PATH_540 : CATALOG_PROMPT_REPO_PATH_540));
  const compareRepoVsActive = compareSemver540(repoPromptVersion, activePromptVersion);
  const warnings = [];
  let decision = "distribution_mirror_matches_canonical";
  let applyPrompt = false;

  if (!repoPromptVersion) {
    decision = "distribution_mirror_missing";
    warnings.push("Repository distribution mirror prompt version missing or unreadable.");
  } else if (compareRepoVsActive === null) {
    decision = "distribution_mirror_unreadable";
    warnings.push("Repository distribution mirror prompt version could not be parsed as semver.");
  } else if (compareRepoVsActive !== 0) {
    decision = "distribution_mirror_mismatch";
  }

  const compareRepoVsCanonical = compareSemver540(repoPromptVersion, canonicalPromptVersion);
  if (repoPromptVersion && canonicalPromptVersion && compareRepoVsCanonical !== null && compareRepoVsCanonical !== 0) {
    warnings.push("Repository distribution mirror prompt version differs from canonical Google Drive version.");
    decision = "distribution_mirror_mismatch";
  }

  return {
    governanceVersion: PROMPT_SYNC_GOVERNANCE_VERSION_540,
    promptName,
    repoPromptPath,
    activePromptVersion,
    repoPromptVersion,
    canonicalPromptVersion,
    decision,
    applyPrompt,
    warnings,
    activationSourceAllowed: false,
    checkedAt: new Date().toISOString()
  };
}

function buildPromptRuntimeCompatibility540(input = {}) {
  const promptName = String(input.promptName || "CatalogPrompt");
  const activePromptVersion = String(input.activePromptVersion || "");
  const repoPromptVersion = String(input.repoPromptVersion || "");
  const canonicalPromptVersion = String(input.canonicalPromptVersion || "");
  const serverVersion = String(input.serverVersion || MCP_VERSION);
  const activeVsServer = compareSemver540(activePromptVersion, serverVersion);
  const repoVsServer = compareSemver540(repoPromptVersion, serverVersion);
  const canonicalVsServer = compareSemver540(canonicalPromptVersion, serverVersion);

  return {
    governanceVersion: PROMPT_SYNC_GOVERNANCE_VERSION_540,
    promptName,
    serverVersion,
    activePromptVersion,
    repoPromptVersion,
    canonicalPromptVersion,
    activeMatchesServer: activeVsServer === 0,
    repoMatchesServer: repoPromptVersion ? repoVsServer === 0 : null,
    canonicalMatchesServer: canonicalPromptVersion ? canonicalVsServer === 0 : null,
    compatible: activeVsServer === 0 && (canonicalPromptVersion ? canonicalVsServer === 0 : true),
    checkedAt: new Date().toISOString()
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.PROMPT_SYNC_GOVERNANCE_VERSION_540 = PROMPT_SYNC_GOVERNANCE_VERSION_540;
  module.exports.CANONICAL_GOVERNANCE_DRIVE_FOLDER_540 = CANONICAL_GOVERNANCE_DRIVE_FOLDER_540;
  module.exports.CANONICAL_PROMPT_MANIFEST_540 = CANONICAL_PROMPT_MANIFEST_540;
  module.exports.parseSemver540 = parseSemver540;
  module.exports.compareSemver540 = compareSemver540;
  module.exports.buildCanonicalPromptManifest540 = buildCanonicalPromptManifest540;
  module.exports.buildPromptSyncDecision540 = buildPromptSyncDecision540;
  module.exports.buildPromptRuntimeCompatibility540 = buildPromptRuntimeCompatibility540;
}
// ============================================================================
// Canonical Google Drive Startup Version Sync Governance 6.11.0
// Canonical Google Drive document identity is the only valid activation source.
// PromptVersion discovery and activation must complete before DB validation.
// ============================================================================

const CANONICAL_DRIVE_STARTUP_GOVERNANCE_VERSION_600 = "6.11.0";
const CANONICAL_GOVERNANCE_DRIVE_FOLDER_600 = "https://drive.google.com/drive/u/0/folders/1GKqFES4r1zoEBsWjfOD0qs2-Tc08a8xQ";
const CANONICAL_SERVER_FILE_ID_600 = "1gAG8ncvQRUeCA-ij0VtVRphbHeduagLh";
const CANONICAL_SERVER_FILE_NAME_600 = "server.js";
const CANONICAL_SERVER_EXPECTED_NAME_600 = "server.js";
const RELEASE_640_METADATA = {
  releaseReason: "version-first agent identity, concise bootstrap and scheduled-run instruction contracts, baseline-25 preservation, and server-side agent-header validation",
  compatibilityExpectation: "prompt synchronization validates Agent headers against PromptVersion, preserves the minimum baseline of 25 entities, rejects attached or mirrored prompt artifacts as activation sources, and keeps score fields on a bounded 0-100 contract",
  rollbackNote: "fall back to the last approved 6.10.x handoff if agent-header validation or baseline-25 enforcement causes operational issues"
};

function parseAgentHeaderVersion650(agentHeader) {
  const value = String(agentHeader || "").trim();
  const match = value.match(/^Agent:\s*(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

function normalizeCatalogTopics650(topicText) {
  return String(topicText || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

function validatePromptAgentHeader650(input = {}) {
  // Accept both new canonical names and legacy aliases
  const rawPromptName = String(input.promptName || "CatalogPrompt").trim() || "CatalogPrompt";
  const promptName = rawPromptName === "SportPrompt" ? "ManagerPrompt"
    : rawPromptName === "CommonPrompt" ? "CatalogPrompt"
    : rawPromptName;
  const agentHeader = String(input.agentHeader || "").trim();
  const promptVersion = String(input.promptVersion || input.canonicalPromptVersion || "").trim();
  const expectedSportName = String(input.expectedSportName || "").trim();
  const headerVersion = parseAgentHeaderVersion650(agentHeader);
  const issues = [];
  let formatValid = false;
  let identityMatchesExpected = false;
  let topicCount = null;
  let expectedPatternDescription = "";

  if (!agentHeader) {
    issues.push("Agent header is missing.");
  }

  if (promptName === "ManagerPrompt") {
    expectedPatternDescription = "Agent: x.y.z [SPORT_NAME] Data Manager";
    const match = agentHeader.match(/^Agent:\s*(\d+\.\d+\.\d+)\s+\[(.+?)\]\s+Data Manager$/);
    formatValid = Boolean(match);
    if (!formatValid) {
      issues.push("ManagerPrompt Agent header does not match the required sport-agent format.");
    } else {
      const parsedSportName = String(match[2] || "").trim();
      identityMatchesExpected = parsedSportName.length > 0;
      if (expectedSportName && expectedSportName !== "[SPORT_NAME]" && parsedSportName !== expectedSportName) {
        identityMatchesExpected = false;
        issues.push("ManagerPrompt Agent header sport identity does not match the expected sport name.");
      }
      if (!identityMatchesExpected) {
        issues.push("ManagerPrompt Agent header sport identity is missing or invalid.");
      }
    }
  } else {
    expectedPatternDescription = "Agent: x.y.z Catalog of [TOPIC_1], [TOPIC_2], [TOPIC_3], [TOPIC_4], [TOPIC_5]";
    const match = agentHeader.match(/^Agent:\s*(\d+\.\d+\.\d+)\s+Catalog of\s+(.+)$/);
    formatValid = Boolean(match);
    if (!formatValid) {
      issues.push("CatalogPrompt Agent header does not match the required catalog-agent format.");
    } else {
      const topics = normalizeCatalogTopics650(match[2]);
      topicCount = topics.length;
      identityMatchesExpected = topicCount === 5;
      if (!identityMatchesExpected) {
        issues.push("CatalogPrompt Agent header must list exactly five catalog topics.");
      }
    }
  }

  const versionMatchesPrompt = Boolean(promptVersion && headerVersion && compareSemver540(headerVersion, promptVersion) === 0);
  if (promptVersion && !versionMatchesPrompt) {
    issues.push("Agent header version does not match PromptVersion.");
  }

  return {
    promptName,
    agentHeader,
    promptVersion,
    headerVersion,
    expectedPatternDescription,
    formatValid,
    identityMatchesExpected,
    topicCount,
    versionMatchesPrompt,
    compliant: Boolean(agentHeader) && formatValid && identityMatchesExpected && versionMatchesPrompt,
    issues
  };
}

function buildBaselineEntityStatus650(input = {}) {
  const minimumBaselineEntityCount = Number.isFinite(Number(input.minimumBaselineEntityCount))
    ? Number(input.minimumBaselineEntityCount)
    : 25;
  if (input.baselineEntityCount === undefined || input.baselineEntityCount === null || input.baselineEntityCount === "") {
    return {
      minimumBaselineEntityCount,
      baselineEntityCount: null,
      status: "unverified",
      compliant: null,
      issues: ["Baseline entity count was not provided for validation."]
    };
  }

  const baselineEntityCount = Number(input.baselineEntityCount);
  if (!Number.isFinite(baselineEntityCount)) {
    return {
      minimumBaselineEntityCount,
      baselineEntityCount: null,
      status: "invalid",
      compliant: false,
      issues: ["Baseline entity count is unreadable or invalid."]
    };
  }

  if (baselineEntityCount < minimumBaselineEntityCount) {
    return {
      minimumBaselineEntityCount,
      baselineEntityCount,
      status: "blocked_below_minimum_25",
      compliant: false,
      issues: [`Baseline entity count ${baselineEntityCount} is below the required minimum of ${minimumBaselineEntityCount}.`]
    };
  }

  return {
    minimumBaselineEntityCount,
    baselineEntityCount,
    status: "verified_minimum_25",
    compliant: true,
    issues: []
  };
}

function isCanonicalActivationSourceType640(sourceType) {
  return String(sourceType || "").trim() === "google_drive_canonical_document";
}

function sourceUrlMatchesCanonical640(sourceUrl, canonicalDocumentUrl) {
  const left = String(sourceUrl || "").trim();
  const right = String(canonicalDocumentUrl || "").trim();
  if (!left || !right) return false;
  return left === right;
}

function parseSemverFromPromptTitle600(title, promptName) {
  const normalizedTitle = String(title || "").trim();
  const normalizedPromptName = String(promptName || "").trim();
  if (!normalizedTitle || !normalizedPromptName) return null;
  if (!normalizedTitle.toLowerCase().startsWith(normalizedPromptName.toLowerCase())) return null;
  const match = normalizedTitle.match(/(?:^|\s|[-_()])v?(\d+\.\d+\.\d+)(?=$|\s|[-_()])/i);
  return match ? match[1] : null;
}

function normalizeCanonicalDriveCandidate600(candidate = {}, promptName = "CatalogPrompt") {
  const title = String(candidate.title || candidate.name || "").trim();
  const id = String(candidate.id || "").trim() || null;
  const url = String(candidate.url || candidate.documentUrl || candidate.canonicalDocumentUrl || "").trim() || null;
  const titleVersion = parseSemverFromPromptTitle600(title, promptName);
  // Precedence is explicit: body PromptVersion outranks title semver, and the
  // effective version is the strongest readable signal available.
  const bodyPromptVersion = String(
    candidate.bodyPromptVersion ||
    candidate.promptVersion ||
    candidate.documentBodyPromptVersion ||
    candidate.PromptVersion ||
    ""
  ).trim() || null;
  return {
    title,
    id,
    url,
    titleVersion,
    bodyPromptVersion,
    sourceType: isCanonicalActivationSourceType640(candidate.sourceType || "google_drive_canonical_document")
      ? "google_drive_canonical_document"
      : String(candidate.sourceType || "google_drive_canonical_document"),
    effectivePromptVersion: bodyPromptVersion || titleVersion || null
  };
}

function buildCanonicalDrivePromptDecision600(input = {}) {
  const promptName = String(input.promptName || "CatalogPrompt").trim() || "CatalogPrompt";
  const activePromptVersion = String(input.activePromptVersion || "").trim();
  const folderReadable = input.folderReadable !== false;
  const candidates = Array.isArray(input.driveCandidates) ? input.driveCandidates : [];
  const manifestPrompt = CANONICAL_PROMPT_MANIFEST_540.prompts[promptName] || null;
  const normalizedCandidates = candidates
    .map(candidate => normalizeCanonicalDriveCandidate600(candidate, promptName))
    .filter(candidate => candidate.title && candidate.title.toLowerCase().startsWith(promptName.toLowerCase()))
    .filter(candidate => !manifestPrompt || (
      candidate.id === manifestPrompt.canonicalDocumentId ||
      sourceUrlMatchesCanonical640(candidate.url, manifestPrompt.canonicalDocumentUrl)
    ));
  const versionedCandidates = normalizedCandidates.filter(candidate => candidate.effectivePromptVersion);
  const warnings = [];
  let decision = "continue_with_active_prompt";
  let applyPrompt = false;
  let selectedCandidate = null;
  let highestDrivePromptVersion = "";
  let highestDriveTitleVersion = "";

  if (!folderReadable) {
    decision = "warning_drive_folder_unreadable";
    warnings.push("Canonical Google Drive folder unreadable before DB validation.");
  } else if (normalizedCandidates.length === 0) {
    decision = "warning_drive_prompt_missing";
    warnings.push("No canonical Google Drive prompt candidate found for the requested prompt name.");
  } else if (versionedCandidates.length === 0) {
    decision = "warning_drive_prompt_version_unreadable";
    warnings.push("Canonical Google Drive prompt candidates found, but no readable PromptVersion was present in the body or title.");
  } else {
    const sortedCandidates = [...versionedCandidates].sort((left, right) => {
      const comparison = compareSemver540(left.effectivePromptVersion, right.effectivePromptVersion);
      if (comparison === null) return 0;
      if (comparison !== 0) return comparison * -1;
      return left.title.localeCompare(right.title);
    });

    selectedCandidate = sortedCandidates[0] || null;
    highestDrivePromptVersion = selectedCandidate ? selectedCandidate.effectivePromptVersion : "";
    highestDriveTitleVersion = selectedCandidate ? selectedCandidate.titleVersion : "";

    const sameHighest = highestDrivePromptVersion
      ? sortedCandidates.filter(candidate => compareSemver540(candidate.effectivePromptVersion, highestDrivePromptVersion) === 0)
      : [];

    if (sameHighest.length > 1) {
      decision = "warning_drive_prompt_ambiguous";
      warnings.push("Multiple canonical Google Drive prompt candidates expose the same highest effective PromptVersion.");
    } else {
      const compareDriveVsActive = compareSemver540(highestDrivePromptVersion, activePromptVersion);
      if (compareDriveVsActive === null) {
        decision = "warning_drive_prompt_version_unreadable";
        warnings.push("Canonical Google Drive effective PromptVersion could not be compared as semver.");
      } else if (compareDriveVsActive > 0) {
        decision = "apply_canonical_drive_prompt";
        applyPrompt = true;
      } else if (compareDriveVsActive < 0) {
        decision = "do_not_downgrade";
      }
    }
  }

  return {
    governanceVersion: CANONICAL_DRIVE_STARTUP_GOVERNANCE_VERSION_600,
    canonicalDriveFolder: CANONICAL_GOVERNANCE_DRIVE_FOLDER_600,
    promptName,
    activePromptVersion,
    highestDrivePromptVersion,
    highestDriveTitleVersion,
    canonicalDocumentId: manifestPrompt ? manifestPrompt.canonicalDocumentId : null,
    canonicalDocumentUrl: manifestPrompt ? manifestPrompt.canonicalDocumentUrl : null,
    selectedDocumentBodyPromptVersion: selectedCandidate ? selectedCandidate.bodyPromptVersion : null,
    selectedDocumentTitle: selectedCandidate ? selectedCandidate.title : null,
    selectedDocumentId: selectedCandidate ? selectedCandidate.id : null,
    selectedDocumentUrl: selectedCandidate ? selectedCandidate.url : null,
    candidateCount: normalizedCandidates.length,
    versionedCandidateCount: versionedCandidates.length,
    decision,
    applyPrompt,
    warnings,
    checkedAt: new Date().toISOString()
  };
}

function buildCanonicalDrivePromptCompatibility600(input = {}) {
  const promptName = String(input.promptName || "CatalogPrompt").trim() || "CatalogPrompt";
  const activePromptVersion = String(input.activePromptVersion || "").trim();
  const highestDrivePromptVersion = String(input.highestDrivePromptVersion || input.highestDriveTitleVersion || "").trim();
  const highestDriveTitleVersion = String(input.highestDriveTitleVersion || "").trim();
  const serverVersion = String(input.serverVersion || MCP_VERSION).trim();
  const activeVsServer = compareSemver540(activePromptVersion, serverVersion);
  const driveVsServer = compareSemver540(highestDrivePromptVersion, serverVersion);

  return {
    governanceVersion: CANONICAL_DRIVE_STARTUP_GOVERNANCE_VERSION_600,
    canonicalDriveFolder: CANONICAL_GOVERNANCE_DRIVE_FOLDER_600,
    promptName,
    serverVersion,
    activePromptVersion,
    highestDrivePromptVersion,
    highestDriveTitleVersion,
    activeMatchesServer: activeVsServer === 0,
    drivePromptMatchesServer: highestDrivePromptVersion ? driveVsServer === 0 : null,
    compatible: activeVsServer === 0 && (highestDrivePromptVersion ? driveVsServer === 0 : true),
    checkedAt: new Date().toISOString()
  };
}

function buildPromptUpgradeLifecycle630(input = {}) {
  const promptName = String(input.promptName || "CatalogPrompt").trim() || "CatalogPrompt";
  const manifestPrompt = CANONICAL_PROMPT_MANIFEST_540.prompts[promptName] || CANONICAL_PROMPT_MANIFEST_540.prompts["CatalogPrompt"] || null;
  const activeRuntimePromptVersion = String(input.activeRuntimePromptVersion || input.activePromptVersion || "").trim();
  const runtimePromptVersionAfterActivation = String(input.runtimePromptVersionAfterActivation || input.runtimePromptVersion || "").trim();
  const canonicalPromptVersion = String(
    input.canonicalPromptVersion ||
    input.detectedCanonicalPromptVersion ||
    input.highestDrivePromptVersion ||
    ""
  ).trim();
  const fetchOk = input.fetchOk === true;
  const verifyOk = input.verifyOk === true;
  const activateOk = input.activateOk === true;
  const compatibilityOk = input.compatibilityOk !== false;
  const activationStatus = String(input.activationStatus || "").trim();
  const runtimePromptSourceDocumentId = String(input.runtimePromptSourceDocumentId || input.sourceDocumentId || "").trim();
  const runtimePromptSourceDocumentUrl = String(input.runtimePromptSourceDocumentUrl || input.sourceDocumentUrl || "").trim();
  const activationSourceType = String(input.activationSourceType || "google_drive_canonical_document").trim();
  const sessionStartedAfterActivation = input.sessionStartedAfterActivation === true;
  const expectedCanonicalDocumentId = manifestPrompt ? manifestPrompt.canonicalDocumentId : "";
  const expectedCanonicalDocumentUrl = manifestPrompt ? manifestPrompt.canonicalDocumentUrl : "";
  const agentValidation = validatePromptAgentHeader650({
    promptName,
    agentHeader: input.agentHeader,
    promptVersion: runtimePromptVersionAfterActivation || canonicalPromptVersion
  });
  const baselineEntityStatus = buildBaselineEntityStatus650({
    baselineEntityCount: input.baselineEntityCount,
    minimumBaselineEntityCount: manifestPrompt ? manifestPrompt.minimumBaselineEntityCount : 25
  });

  let decision = "continue_with_active_prompt";
  let blockedPhase = null;
  let blockedReason = null;
  let activationResult = "not_required";
  let reachedPhase = "detect";

  const compareCanonicalVsActive = compareSemver540(canonicalPromptVersion, activeRuntimePromptVersion);

  if (!canonicalPromptVersion) {
    decision = "blocked_prompt_verify_failed";
    blockedPhase = "detect";
    blockedReason = "Canonical PromptVersion was not detected from the canonical document body.";
    activationResult = "blocked";
  } else if (!activeRuntimePromptVersion) {
    decision = "blocked_prompt_verify_failed";
    blockedPhase = "detect";
    blockedReason = "Active runtime PromptVersion is missing or unreadable.";
    activationResult = "blocked";
  } else if (compareCanonicalVsActive === null) {
    decision = "blocked_prompt_verify_failed";
    blockedPhase = "detect";
    blockedReason = "Prompt versions could not be compared as semver.";
    activationResult = "blocked";
  } else if (compareCanonicalVsActive <= 0) {
    decision = compareCanonicalVsActive < 0 ? "do_not_downgrade" : "continue_with_active_prompt";
    activationResult = "not_required";
  } else if (!fetchOk) {
    reachedPhase = "fetch";
    decision = "blocked_prompt_fetch_failed";
    blockedPhase = "fetch";
    blockedReason = "A newer canonical prompt was detected, but a full canonical prompt fetch was not confirmed.";
    activationResult = "blocked";
  } else if (!verifyOk) {
    reachedPhase = "verify";
    decision = "blocked_prompt_verify_failed";
    blockedPhase = "verify";
    blockedReason = "The fetched canonical prompt could not be verified for integrity, completeness, or lineage safety.";
    activationResult = "blocked";
  } else if (!compatibilityOk) {
    reachedPhase = "verify";
    decision = "blocked_prompt_compatibility_failed";
    blockedPhase = "verify";
    blockedReason = "The fetched canonical prompt is not confirmed as compatible with the active runtime or server version.";
    activationResult = "blocked";
  } else if (!activateOk) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "The canonical prompt was fetched and verified, but activation into runtime was not confirmed.";
    activationResult = "blocked";
  } else if (activationStatus !== "active") {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Activation status is not explicitly confirmed as active.";
    activationResult = "blocked";
  } else if (!runtimePromptVersionAfterActivation) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Runtime PromptVersion after activation was not recorded.";
    activationResult = "blocked";
  } else if (compareSemver540(runtimePromptVersionAfterActivation, canonicalPromptVersion) !== 0) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Runtime PromptVersion after activation does not match the canonical PromptVersion.";
    activationResult = "blocked";
  } else if (!isCanonicalActivationSourceType640(activationSourceType)) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Runtime prompt activation source type is not the canonical Google Drive document.";
    activationResult = "blocked";
  } else if (expectedCanonicalDocumentId && runtimePromptSourceDocumentId !== expectedCanonicalDocumentId) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Runtime prompt source document id does not match the canonical Google Drive document id.";
    activationResult = "blocked";
  } else if (expectedCanonicalDocumentUrl && !sourceUrlMatchesCanonical640(runtimePromptSourceDocumentUrl, expectedCanonicalDocumentUrl)) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Runtime prompt source document url does not match the canonical Google Drive document url.";
    activationResult = "blocked";
  } else if (!agentValidation.compliant) {
    reachedPhase = "activate";
    decision = "blocked_prompt_agent_header_invalid";
    blockedPhase = "activate";
    blockedReason = agentValidation.issues[0] || "Agent header validation failed.";
    activationResult = "blocked";
  } else if (baselineEntityStatus.compliant === false) {
    reachedPhase = "activate";
    decision = "blocked_prompt_baseline_invalid";
    blockedPhase = "activate";
    blockedReason = baselineEntityStatus.issues[0] || "Baseline entity validation failed.";
    activationResult = "blocked";
  } else if (!sessionStartedAfterActivation) {
    reachedPhase = "activate";
    decision = "blocked_prompt_activate_failed";
    blockedPhase = "activate";
    blockedReason = "Runtime session did not prove that it started after activation of the canonical prompt.";
    activationResult = "blocked";
  } else {
    reachedPhase = "activate";
    decision = "apply_canonical_drive_prompt";
    activationResult = "activated";
  }

  return {
    governanceVersion: CANONICAL_DRIVE_STARTUP_GOVERNANCE_VERSION_600,
    promptName,
    activeRuntimePromptVersion,
    runtimePromptVersionAfterActivation,
    canonicalPromptVersion,
    fetchOk,
    verifyOk,
    compatibilityOk,
    activateOk,
    activationStatus,
    activationSourceType,
    runtimePromptSourceDocumentId,
    runtimePromptSourceDocumentUrl,
    expectedCanonicalDocumentId,
    expectedCanonicalDocumentUrl,
    agentHeaderValidation: agentValidation,
    baselineEntityStatus,
    sessionStartedAfterActivation,
    reachedPhase,
    blockedPhase,
    blockedReason,
    activationResult,
    decision,
    checkedAt: new Date().toISOString()
  };
}

function buildReportScoreVisibilityAudit(input = {}) {
  const reportType = String(input.reportType || "").trim();
  const includedScores = Array.isArray(input.includedScores) ? input.includedScores.map(String) : [];
  const omittedNumericScores = input.omittedNumericScores === true;
  const materiallyDegraded = input.materiallyDegraded === true;
  const disputed = input.disputed === true;
  const blocked = input.blocked === true;

  const requiredByReportType = {
    SuccessHighlights: ["ConfidenceScore", "ReliabilityScore"],
    HistoricalAllTimeReport: ["HistoricalScore", "CoverageScore", "ConfidenceScore"],
    RankingReport: ["ConfidenceScore", "ValidationScore", "CoverageScore"],
    StandingsReport: ["ValidationScore", "CoverageScore"],
    SnapshotReport: ["HistoricalScore", "ConfidenceScore"],
    MergeConflictReport: ["ConfidenceScore", "ReliabilityScore", "ValidationScore"],
    DataQualityReport: ["QualityScore", "ValidationScore", "CoverageScore", "AnomalyScore"],
    ReleaseReadinessReport: ["FinalScore", "ValidationScore"]
  };

  const requiredScores = requiredByReportType[reportType] || [];
  const missingRequiredScores = requiredScores.filter(score => !includedScores.includes(score));
  const warnings = [];

  if (missingRequiredScores.length > 0) {
    warnings.push(`Missing required score fields for ${reportType}: ${missingRequiredScores.join(", ")}`);
  }
  if ((blocked || materiallyDegraded || disputed) && omittedNumericScores) {
    warnings.push("Numeric score display should not be omitted for blocked, degraded, or disputed reports.");
  }

  return {
    reportType,
    includedScores,
    requiredScores,
    missingRequiredScores,
    omittedNumericScores,
    materiallyDegraded,
    disputed,
    blocked,
    compliant: missingRequiredScores.length === 0 && !((blocked || materiallyDegraded || disputed) && omittedNumericScores),
    warnings
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.CANONICAL_DRIVE_STARTUP_GOVERNANCE_VERSION_600 = CANONICAL_DRIVE_STARTUP_GOVERNANCE_VERSION_600;
  module.exports.CANONICAL_GOVERNANCE_DRIVE_FOLDER_600 = CANONICAL_GOVERNANCE_DRIVE_FOLDER_600;
  module.exports.CANONICAL_SERVER_FILE_ID_600 = CANONICAL_SERVER_FILE_ID_600;
  module.exports.CANONICAL_SERVER_FILE_NAME_600 = CANONICAL_SERVER_FILE_NAME_600;
  module.exports.CANONICAL_SERVER_EXPECTED_NAME_600 = CANONICAL_SERVER_EXPECTED_NAME_600;
  module.exports.RELEASE_640_METADATA = RELEASE_640_METADATA;
  module.exports.buildScoreBreakdown = buildScoreBreakdown;
  module.exports.parseSemverFromPromptTitle600 = parseSemverFromPromptTitle600;
  module.exports.normalizeCanonicalDriveCandidate600 = normalizeCanonicalDriveCandidate600;
  module.exports.buildCanonicalDrivePromptDecision600 = buildCanonicalDrivePromptDecision600;
  module.exports.buildCanonicalDrivePromptCompatibility600 = buildCanonicalDrivePromptCompatibility600;
  module.exports.parseAgentHeaderVersion650 = parseAgentHeaderVersion650;
  module.exports.validatePromptAgentHeader650 = validatePromptAgentHeader650;
  module.exports.buildBaselineEntityStatus650 = buildBaselineEntityStatus650;
  module.exports.buildPromptUpgradeLifecycle630 = buildPromptUpgradeLifecycle630;
  module.exports.buildReportScoreVisibilityAudit = buildReportScoreVisibilityAudit;
}
