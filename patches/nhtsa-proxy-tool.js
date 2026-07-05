/**
 * NHTSA Proxy Tool pro MCP server
 * Přidat do server.js — agenti volají NHTSA přes QNAP IP místo OpenAI cloudu (NHTSA blokuje OpenAI IPs)
 *
 * JAK APLIKOVAT:
 * 1. Najít v server.js: wrapTool("send_notification", ...)
 * 2. Před tuto funkci vložit tento kód
 * 3. docker compose up --build -d
 */

const NHTSA_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";
const NHTSA_AGENT = "Mozilla/5.0 (compatible; VO2Agent/1.0; +https://vo2info.cz)";

wrapTool("fetch_nhtsa_vin", "Decode a VIN via NHTSA API (proxied through QNAP — avoids cloud IP blocks). Returns decoded vehicle attributes.", {
  vin: z.string().length(17).describe("17-character VIN to decode"),
}, async ({ vin }) => {
  const url = `${NHTSA_BASE}/decodevin/${encodeURIComponent(vin.toUpperCase())}?format=json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": NHTSA_AGENT, "Accept": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`NHTSA ${resp.status}: ${await resp.text().catch(() => "")}`);
  const data = await resp.json();
  const results = (data.Results || []).reduce((acc, r) => {
    if (r.Value && r.Value !== "Not Applicable" && r.Value !== "0") {
      acc[r.Variable] = r.Value;
    }
    return acc;
  }, {});
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, vin: vin.toUpperCase(), results }, null, 2) }] };
});

wrapTool("fetch_nhtsa_wmi", "Get WMI info for a manufacturer via NHTSA API (proxied through QNAP).", {
  manufacturer: z.string().describe("Manufacturer name or WMI code (e.g. 'toyota', '1HG')"),
}, async ({ manufacturer }) => {
  const url = `${NHTSA_BASE}/GetWMIsForManufacturer/${encodeURIComponent(manufacturer)}?format=json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": NHTSA_AGENT, "Accept": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`NHTSA WMI ${resp.status}`);
  const data = await resp.json();
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, manufacturer, count: data.Count, results: data.Results || [] }, null, 2) }] };
});

wrapTool("fetch_nhtsa_manufacturers", "List vehicle manufacturers from NHTSA API (proxied through QNAP).", {
  type: z.enum(["Motorcycle", "Multipurpose Passenger Vehicle (MPV)", "Passenger Car", "Truck", "Bus", "Trailer", "Incomplete Vehicle"]).optional().describe("Vehicle type filter"),
  page: z.number().int().min(1).default(1).describe("Page number"),
}, async ({ type, page }) => {
  const params = new URLSearchParams({ format: "json", page: String(page) });
  if (type) params.set("type", type);
  const url = `${NHTSA_BASE}/GetAllManufacturers?${params}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": NHTSA_AGENT, "Accept": "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`NHTSA manufacturers ${resp.status}`);
  const data = await resp.json();
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: data.Count, page, results: data.Results || [] }, null, 2) }] };
});
