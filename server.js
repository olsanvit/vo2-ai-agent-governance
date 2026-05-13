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

const AUTH_TOKEN = process.env.AUTH_TOKEN || "Roundnet575Padel";
const MCP_VERSION = "5.3.0";
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 100);
const MAX_EXPORT_ROWS = Number(process.env.MAX_EXPORT_ROWS || 1000);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 15 * 1024 * 1024);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/app/uploads";
const PUBLIC_UPLOAD_BASE_URL = process.env.PUBLIC_UPLOAD_BASE_URL || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT || 10000),
});

let pgcryptoAvailable = false;
let citextAvailable = false;
let postgisAvailable = false;
let vectorAvailable = false;

const schemaCache = new Map();

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
  if (/Score$/i.test(name)) return "numeric(5,2)";
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
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
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
  const where = keys.map((rawKey, i) => {
    const key = normalizeIdentifierName(rawKey);
    assertIdentifier(key);
    return `"${key}" = $${i + startIndex}`;
  }).join(" AND ");
  return { where, values: keys.map(k => normalizeValue(criteria[k])) };
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
  if (schemaCache.has(t)) return new Set(schemaCache.get(t).columns);
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
      await pool.query(`ALTER TABLE "${t}" ADD COLUMN ${sql}`);
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

  for (const col of SCORE_COLUMNS) {
    if (!existing.has(col)) {
      await pool.query(`ALTER TABLE "${t}" ADD COLUMN "${col}" numeric(5,2) NOT NULL DEFAULT 0 CHECK ("${col}" >= 0 AND "${col}" <= 100)`);
      invalidateSchema(t);
      existing = await getColumns(t);
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
    await pool.query(`ALTER TABLE "${t}" ADD COLUMN "${key}" ${type}`);
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

async function upsertRecord(table, criteria, data, skipAudit = false) {
  const t = normalizeIdentifierName(table);
  const normalized = normalizeScoreData({ ...(data || {}) });
  if (normalized.Name && !normalized.NormalizedName) normalized.NormalizedName = normalizeSearchText(normalized.Name);
  if (!normalized.SearchText) normalized.SearchText = normalizeSearchText(JSON.stringify({ ...criteria, ...normalized }));

  await ensureColumnsInternal(t, { ...(criteria || {}), ...(normalized || {}) });

  const criteriaKeys = Object.keys(criteria || {});
  let existing = null;

  if (criteriaKeys.length > 0) {
    const where = buildWhere(criteria);
    const result = await pool.query(`SELECT * FROM "${t}" WHERE ${where.where} AND COALESCE("IsDeleted", false)=false LIMIT 1`, where.values);
    existing = result.rows[0] || null;
  }

  if (existing) {
    const updateData = { ...normalized };
    const keys = Object.keys(updateData);
    if (keys.length === 0) return { mode: "unchanged", guid: existing.Guid };

    const setClause = keys.map((k, i) => `"${normalizeIdentifierName(k)}" = $${i + 1}`).join(", ");
    const values = keys.map(k => normalizeValue(updateData[k]));
    values.push(existing.Guid);

    await pool.query(`UPDATE "${t}" SET ${setClause} WHERE "Guid" = $${keys.length + 1}`, values);
    metrics.updates++;
    if (!skipAudit) await audit("update", t, { criteria, data: updateData });
    return { mode: "update", guid: existing.Guid };
  }

  const insertData = { Guid: criteria?.Guid || uuid(), ...(criteria || {}), ...(normalized || {}) };
  const keys = Object.keys(insertData);
  const columns = keys.map(k => `"${normalizeIdentifierName(k)}"`).join(", ");
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const values = keys.map(k => normalizeValue(insertData[k]));

  await pool.query(`INSERT INTO "${t}" (${columns}) VALUES (${placeholders})`, values);
  metrics.inserts++;
  if (!skipAudit) await audit("insert", t, insertData);
  return { mode: "insert", guid: insertData.Guid };
}

async function findRecords(table, criteria = {}, limit = 20) {
  const t = normalizeIdentifierName(table);
  const safe = safeLimit(limit, 500);

  if (Object.keys(criteria).length === 0) {
    const r = await pool.query(`SELECT * FROM "${t}" WHERE COALESCE("IsDeleted", false)=false ORDER BY "UpdatedAt" DESC LIMIT ${safe}`);
    return r.rows;
  }

  const where = buildWhere(criteria);
  const r = await pool.query(`SELECT * FROM "${t}" WHERE ${where.where} AND COALESCE("IsDeleted", false)=false LIMIT ${safe}`, where.values);
  return r.rows;
}

async function searchRecords(table, query, limit = 20) {
  const t = normalizeIdentifierName(table);
  const safe = safeLimit(limit, 200);
  const normalized = normalizeSearchText(query);

  const r = await pool.query(
    `SELECT * FROM "${t}"
     WHERE COALESCE("IsDeleted", false)=false
     AND ("SearchText" ILIKE $1 OR "NormalizedName" ILIKE $1)
     ORDER BY "UpdatedAt" DESC
     LIMIT ${safe}`,
    [`%${normalized}%`]
  );

  return r.rows;
}

async function softDeleteRecord(table, criteria) {
  const t = normalizeIdentifierName(table);
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

  const mimeType = response.headers.get("content-type") || "application/octet-stream";
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

  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await upsertRecord("SchemaMigrations", { MigrationHash: hash }, {
      MigrationName: migrationName,
      MigrationHash: hash,
      ExecutedAt: new Date().toISOString()
    }, true);
    await pool.query("COMMIT");
    metrics.migrationsRecorded++;
    return { executed: true, hash };
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
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

  wrapTool("describe_database", "Describe database tables, columns, indexes and foreign keys.", {}, async () => {
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    const out = [];

    for (const row of tables.rows) {
      const table = row.table_name;
      const columns = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1
         ORDER BY ordinal_position`,
        [table]
      );
      const indexes = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`, [table]);
      const foreignKeys = await pool.query(
        `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
         WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND tc.table_name=$1`,
        [table]
      );
      out.push({ table, columns: columns.rows, indexes: indexes.rows, foreignKeys: foreignKeys.rows });
    }

    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  wrapTool("schema_report", "Report schema gaps.", {}, async () => {
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    const report = [];

    for (const row of tables.rows) {
      const table = row.table_name;
      const cols = await getColumns(table);
      const pk = await pool.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'`,
        [table]
      );
      const pkCols = pk.rows.map(x => x.column_name);
      report.push({
        table,
        missingBaseColumns: BASE_COLUMNS.filter(c => !cols.has(c)),
        missingScoreColumns: [...SCORE_COLUMNS, "ScoreUpdatedAt", "ScoreReason"].filter(c => !cols.has(c)),
        primaryKey: pkCols,
        guidIsPrimaryKey: pkCols.length === 1 && pkCols[0] === "Guid"
      });
    }

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

  wrapTool("smart_upsert_batch", "Batch upsert records.", { table: z.string(), records: z.array(z.object({ criteria: z.record(z.any()), data: z.record(z.any()) })) }, async ({ table, records }) => {
    if (records.length > MAX_BATCH_SIZE) throw new Error(`Batch too large. Max ${MAX_BATCH_SIZE}.`);
    const results = [];
    for (const record of records) results.push(await upsertRecord(table, record.criteria, record.data));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
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
    const safeColumns = columns.map(normalizeIdentifierName);
    const cols = safeColumns.map(c => `"${c}"`).join(", ");
    const r = await pool.query(`
      SELECT ${cols}, COUNT(*) AS count, ARRAY_AGG("Guid" ORDER BY "CreatedAt") AS guids
      FROM "${t}"
      WHERE COALESCE("IsDeleted", false)=false
      GROUP BY ${cols}
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `);
    return { content: [{ type: "text", text: JSON.stringify(r.rows, null, 2) }] };
  });

  wrapTool("table_stats", "Return row count and last update.", { table: z.string() }, async ({ table }) => {
    const t = normalizeIdentifierName(table);
    const r = await pool.query(`
      SELECT COUNT(*)::int AS row_count, MAX("UpdatedAt") AS last_update
      FROM "${t}"
      WHERE COALESCE("IsDeleted", false)=false
    `);
    return { content: [{ type: "text", text: JSON.stringify(r.rows[0], null, 2) }] };
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

  return server;
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use((req, res, next) => {
  metrics.requests++;
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", name: "VO2QNAPDB MCP", version: MCP_VERSION });
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
      vectorAvailable
    });
  } catch (e) {
    res.status(500).json({ status: "error", version: MCP_VERSION, db: "error", error: e.message });
  }
});

app.get("/metrics", (req, res) => {
  res.json({
    ...metrics,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    schemaCacheSize: schemaCache.size
  });
});

app.post("/mcp", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
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

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

initDb()
  .then(() => {
    app.listen(3000, "0.0.0.0", () => {
      console.log(`VO2QNAPDB MCP ${MCP_VERSION} running on port 3000`);
    });
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
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
