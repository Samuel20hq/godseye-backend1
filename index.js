// index.js — God's Eye unified telemetry engine (Cloudflare Worker)
// Capas: flight (OpenSky) · hazard (USGS) · camera (CCTV/webcams)
//
// Rutas:
//   GET /?lamin=..&lamax=..&lomin=..&lomax=..   → JSON maestro (bounding box opcional)
//   GET /?verify=1                              → comprueba qué URLs de cámara responden

const UPSTREAM_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// CÁMARAS — el campo `url` es obligatorio y se valida (https). Un nodo sin URL
// válida NO se emite. Son páginas públicas de visionado; muchas webcams no
// ofrecen imagen/stream directo estable. Comprueba cuáles responden con
// /?verify=1 y sustituye las que fallen por el enlace que prefieras.
// ---------------------------------------------------------------------------
const CAMERAS = [
  { id: "cam_ny",         title: "CCTV TIMES SQUARE // NYC",      lat: 40.7580, lon: -73.9855,
    url: "https://www.earthcam.com/usa/newyork/timessquare/" },
  { id: "cam_tokyo",      title: "CCTV TOKYO TOWER",              lat: 35.6586, lon: 139.7454,
    url: "https://www.earthcam.com/world/japan/tokyo/" },
  { id: "cam_madrid",     title: "CCTV PUERTA DEL SOL // MAD",    lat: 40.4169, lon: -3.7035,
    url: "https://es.windfinder.com/webcams/madrid_madrid_spain" },
  { id: "cam_piccadilly", title: "CCTV PICCADILLY CIRCUS // LON", lat: 51.5100, lon: -0.1342,
    url: "https://www.earthcam.com/world/england/london/" },
  { id: "cam_shibuya",    title: "CCTV SHIBUYA CROSSING // TYO",  lat: 35.6595, lon: 139.7004,
    url: "https://www.earthcam.com/world/japan/tokyo/" }
];

const isValidHttpsUrl = (u) => {
  try { return new URL(u).protocol === "https:"; } catch { return false; }
};

const CORS = { "Access-Control-Allow-Origin": "*" };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra }
  });

// fetch con timeout: nunca cuelga el Worker y devuelve null si falla la red.
const safeFetch = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }).catch(() => null);

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS" }
      });
    }

    const url = new URL(request.url);

    // ---------------- Diagnóstico de cámaras ----------------
    if (url.searchParams.get("verify") === "1") {
      const report = await Promise.all(CAMERAS.map(async (c) => {
        if (!isValidHttpsUrl(c.url)) return { id: c.id, url: c.url, ok: false, status: "invalid_url" };
        const r = await safeFetch(c.url, { method: "GET", redirect: "follow" });
        return { id: c.id, url: c.url, ok: !!r && r.ok, status: r ? r.status : "unreachable" };
      }));
      return json({ cameras: report }, 200, { "Cache-Control": "no-store" });
    }

    // ---------------- Bounding box ----------------
    const lamin = parseFloat(url.searchParams.get("lamin"));
    const lamax = parseFloat(url.searchParams.get("lamax"));
    const lomin = parseFloat(url.searchParams.get("lomin"));
    const lomax = parseFloat(url.searchParams.get("lomax"));
    const hasBounds =
      [lamin, lamax, lomin, lomax].every(Number.isFinite) &&
      lamin <= lamax &&
      Math.abs(lamin) <= 90 && Math.abs(lamax) <= 90 &&
      Math.abs(lomin) <= 180 && Math.abs(lomax) <= 180;

    const inBounds = (lat, lon) => {
      if (!hasBounds) return true;
      if (lat < lamin || lat > lamax) return false;
      // lomin > lomax = la caja cruza el antimeridiano
      return lomin <= lomax ? (lon >= lomin && lon <= lomax) : (lon >= lomin || lon <= lomax);
    };

    try {
      const nowSec = Math.floor(Date.now() / 1000);

      // ---------------- Peticiones paralelas ----------------
      const [openSkyRes, usgsRes] = await Promise.all([
        safeFetch("https://opensky-network.org/api/states/all", {
          headers: { "User-Agent": "GodsEyeUltimate/9.0" },
          cf: { cacheTtl: 8, cacheEverything: true }
        }),
        safeFetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson", {
          cf: { cacheTtl: 60, cacheEverything: true }
        })
      ]);

      const states = [];
      const sources = { opensky: "ok", usgs: "ok", cameras: "ok" };
      let flightsTime = null;
      let retryAfter = null;

      // ---------------- 1. VUELOS ----------------
      if (!openSkyRes) {
        sources.opensky = "error";
      } else if (openSkyRes.status === 429) {
        sources.opensky = "rate_limited";
        const h = openSkyRes.headers.get("x-rate-limit-retry-after-seconds") ||
                  openSkyRes.headers.get("retry-after");
        const n = parseInt(h, 10);
        retryAfter = Number.isFinite(n) ? n : null;
      } else if (!openSkyRes.ok) {
        sources.opensky = "error";
      } else {
        try {
          const data = await openSkyRes.json();
          flightsTime = typeof data.time === "number" ? data.time : nowSec;

          for (const s of data.states || []) {
            const lon = s[5];
            const lat = s[6];
            if (typeof lon !== "number" || typeof lat !== "number") continue;
            if (!inBounds(lat, lon)) continue;

            states.push({
              type: "flight",
              icao24: s[0] || "",
              callsign: s[1] ? s[1].trim() : "",
              country: s[2] || "—",
              lon,
              lat,
              altitude: s[7] ?? 0,
              onGround: !!s[8],
              velocity: s[9] ?? 0,
              heading: s[10] ?? 0,
              vrate: s[11] ?? null,
              fix: s[3] ?? s[4] ?? flightsTime,
              url: null
            });
          }
        } catch {
          sources.opensky = "error";
          flightsTime = null;
        }
      }

      // ---------------- 2. SISMOS (hazard) ----------------
      if (!usgsRes || !usgsRes.ok) {
        sources.usgs = "error";
      } else {
        try {
          const usgs = await usgsRes.json();
          for (const feat of usgs.features || []) {
            const c = feat.geometry && feat.geometry.coordinates;
            if (!Array.isArray(c)) continue;
            const [lon, lat, depthKm] = c;
            if (typeof lon !== "number" || typeof lat !== "number") continue;
            if (!inBounds(lat, lon)) continue;

            const p = feat.properties || {};
            const mag = typeof p.mag === "number" ? p.mag : null;

            states.push({
              type: "hazard",
              icao24: "eq_" + feat.id,
              callsign: "SISMO M" + (mag !== null ? mag.toFixed(1) : "?"),
              country: "SEISMIC",
              lon,
              lat,
              altitude: (depthKm ?? 0) * 1000,   // profundidad en metros
              onGround: true,
              velocity: 0,
              heading: 0,
              vrate: 0,
              fix: p.time ? Math.floor(p.time / 1000) : nowSec,
              magnitude: mag,
              depthKm: depthKm ?? null,
              url: null
            });
          }
        } catch {
          sources.usgs = "error";
        }
      }

      // ---------------- 3. CÁMARAS ----------------
      for (const c of CAMERAS) {
        if (!isValidHttpsUrl(c.url)) continue;     // url válida obligatoria
        if (!inBounds(c.lat, c.lon)) continue;

        states.push({
          type: "camera",
          icao24: c.id,
          callsign: c.title,
          country: "CCTV",
          lon: c.lon,
          lat: c.lat,
          altitude: 0,
          onGround: true,
          velocity: 0,
          heading: 0,
          vrate: 0,
          fix: nowSec,
          url: c.url
        });
      }

      const degraded = sources.opensky !== "ok";
      return json({
        timestamp: nowSec,
        flightsTime,
        retryAfter,
        sources,
        count: states.length,
        states
      }, 200, {
        "Cache-Control": degraded ? "no-store" : "public, max-age=5",
        ...(retryAfter ? { "Retry-After": String(retryAfter) } : {})
      });

    } catch (error) {
      return json({ states: [], error: error.message }, 500, { "Cache-Control": "no-store" });
    }
  }
};
