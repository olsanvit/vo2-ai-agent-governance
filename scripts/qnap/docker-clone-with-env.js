// Znovu vytvoří kontejnery se stejnou konfigurací (Docker API), změní jen NTFY_USER/NTFY_PASS.
// PROČ přes API: aplikace mají různé porty, sítě s aliasy, mounty a limity — ruční `docker run`
// by snadno něco vynechal. Údaje publisheru přicházejí v env (NTFY_NEW_USER/NTFY_NEW_PASS).
const http = require("http");
const NAMES = process.argv.slice(2);
const NEW_USER = process.env.NTFY_NEW_USER, NEW_PASS = process.env.NTFY_NEW_PASS;
if (!NEW_USER || !NEW_PASS) { console.log("❌ chybí údaje publisheru"); process.exit(1); }

function api(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ socketPath: "/var/run/docker.sock", method, path,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, r => {
      let b = ""; r.on("data", c => b += c); r.on("end", () => res({ code: r.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null }));
    });
    req.on("error", rej); if (data) req.write(data); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = encodeURIComponent;

async function waitOk(id, hasHealth) {
  let stableSince = null;
  for (let i = 0; i < 60; i++) {           // max ~120 s
    const r = await api("GET", `/containers/${id}/json`);
    const s = r.body.State;
    if (!s.Running || s.Restarting) { if (i > 5 && !s.Running) return `neběží (exit ${s.ExitCode})`; stableSince = null; }
    else {
      stableSince = stableSince ?? Date.now();
      const healthy = !hasHealth || (s.Health && s.Health.Status === "healthy");
      if (s.Health && s.Health.Status === "unhealthy") return "unhealthy";
      if (healthy && Date.now() - stableSince >= 20000 && r.body.RestartCount === 0) return null;
    }
    await sleep(2000);
  }
  return "nestabilní v časovém limitu";
}

(async () => {
  const done = [];
  for (const name of NAMES) {
    const g = await api("GET", `/containers/${q(name)}/json`);
    if (g.code !== 200) { console.log(`❌ ${name}: nenalezen`); process.exit(1); }
    const c = g.body;
    const env = c.Config.Env || [];
    if (!env.some(e => e.startsWith("NTFY_PASS="))) { console.log(`- ${name}: bez NTFY_PASS, přeskočeno`); continue; }
    if ((c.Mounts || []).some(m => m.Type === "volume")) { console.log(`❌ ${name}: má volume — ručně`); process.exit(1); }
    if ((await api("GET", `/containers/${q(name + "-prentfy")}/json`)).code === 200) { console.log(`❌ ${name}-prentfy existuje`); process.exit(1); }

    const newEnv = env.map(e => e.startsWith("NTFY_PASS=") ? `NTFY_PASS=${NEW_PASS}` : e.startsWith("NTFY_USER=") ? `NTFY_USER=${NEW_USER}` : e);
    if (!newEnv.some(e => e.startsWith("NTFY_USER="))) newEnv.push(`NTFY_USER=${NEW_USER}`);
    const shortId = c.Id.slice(0, 12);
    const nets = c.NetworkSettings.Networks || {};
    const mode = c.HostConfig.NetworkMode;
    const endpoints = {};
    for (const [n, v] of Object.entries(nets)) {
      if (["host", "none", "bridge", "default"].includes(n) && n === mode) continue;
      endpoints[n] = { Aliases: (v.Aliases || []).filter(a => a !== shortId && a !== c.Config.Hostname),
                       IPAMConfig: v.IPAMConfig || undefined, Links: v.Links || undefined };
    }
    const primary = endpoints[mode] ? { [mode]: endpoints[mode] } : {};
    const extra = Object.entries(endpoints).filter(([n]) => n !== mode);
    const body = { ...c.Config, Image: c.Image, Env: newEnv, HostConfig: c.HostConfig,
                   NetworkingConfig: { EndpointsConfig: primary } };
    delete body.Hostname;   // nový kontejner dostane vlastní (původní = zkrácené ID starého)
    const wasRunning = c.State.Running;
    const hasHealth = !!(c.Config.Healthcheck && c.Config.Healthcheck.Test && c.Config.Healthcheck.Test[0] !== "NONE");

    const rollback = async (why, newId) => {
      console.log(`❌ ${name}: ${why} → vracím původní`);
      if (newId) await api("DELETE", `/containers/${newId}?force=true`);
      await api("POST", `/containers/${q(name + "-prentfy")}/rename?name=${q(name)}`);
      if (wasRunning) await api("POST", `/containers/${q(name)}/start`);
      process.exit(1);
    };

    await api("POST", `/containers/${q(name)}/rename?name=${q(name + "-prentfy")}`);
    if (wasRunning) await api("POST", `/containers/${q(name + "-prentfy")}/stop?t=30`);
    const cr = await api("POST", `/containers/create?name=${q(name)}`, body);
    if (cr.code !== 201) await rollback(`create ${cr.code} ${JSON.stringify(cr.body).slice(0, 150)}`);
    const id = cr.body.Id;
    for (const [n, v] of extra) {
      const r = await api("POST", `/networks/${q(n)}/connect`, { Container: id, EndpointConfig: v });
      if (r.code !== 200) await rollback(`síť ${n}: ${r.code}`, id);
    }
    if (wasRunning) {
      const st = await api("POST", `/containers/${id}/start`);
      if (st.code !== 204) await rollback(`start ${st.code} ${JSON.stringify(st.body).slice(0, 150)}`, id);
      const err = await waitOk(id, hasHealth);
      if (err) await rollback(err, id);
    }
    const chk = (await api("GET", `/containers/${id}/json`)).body;
    if (!chk.Config.Env.includes(`NTFY_PASS=${NEW_PASS}`) || chk.Image !== c.Image) await rollback("kontrola env/image", id);
    console.log(`✓ ${name}: ${wasRunning ? "běží stabilně" : "vytvořen (zůstává zastavený)"}${hasHealth ? ", healthy" : ""}, sítě ${Object.keys(chk.NetworkSettings.Networks).join(",")}`);
    done.push(name);
  }
  for (const name of done) {
    const d = await api("DELETE", `/containers/${q(name + "-prentfy")}?force=true`);
    console.log(`  smazán ${name}-prentfy (${d.code})`);
  }
  console.log(`✅ hotovo: ${done.length} kontejnerů`);
})().catch(e => { console.log("❌ výjimka: " + e.message); process.exit(1); });
