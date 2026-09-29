export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Extracción y saneamiento del Bounding Box enviado desde el iPad
    const lamin = parseFloat(url.searchParams.get('lamin'));
    const lamax = parseFloat(url.searchParams.get('lamax'));
    const lomin = parseFloat(url.searchParams.get('lomin'));
    const lomax = parseFloat(url.searchParams.get('lomax'));
    
    const hasBounds = !isNaN(lamin) && !isNaN(lamax) && !isNaN(lomin) && !isNaN(lomax);

    try {
      // Peticiones paralelas simultáneas con tolerancia a fallos (Resiliencia Total)
      const [openSkyRes, usgsRes] = await Promise.all([
        // Capa 1: Tráfico Aéreo Global (OpenSky Network)
        fetch('https://opensky-network.org/api/states/all', {
          headers: { 'User-Agent': 'GodsEyeUltimate/7.0 (GlobalTelemetryEngine)' },
          cf: { cacheTtl: 8, cacheEverything: true }
        }).catch(() => null),
        
        // Capa 2: Amenazas Sísmicas en Tiempo Real (USGS Public API)
        fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', {
          cf: { cacheTtl: 60, cacheEverything: true }
        }).catch(() => null)
      ]);

      const states = [];

      // ----------------------------------------------------
      // 1. PROCESAMIENTO DE VUELOS (Aeronaves en Ruta)
      // ----------------------------------------------------
      if (openSkyRes && openSkyRes.status === 200) {
        const data = await openSkyRes.json();
        const rawStates = data.states || [];
        const totalCount = rawStates.length;

        for (let i = 0; i < totalCount; i++) {
          const s = rawStates[i];
          const lon = s[5];
          const lat = s[6];

          if (lon === null || lat === null || typeof lon !== 'number' || typeof lat !== 'number') continue;
          if (hasBounds && (lat < lamin || lat > lamax || lon < lomin || lon > lomax)) continue;

          states.push({
            type: "flight",
            icao24: s[0] || "",
            callsign: s[1] ? s[1].trim() : "",
            country: s[2] || "—",
            lon: lon,
            lat: lat,
            altitude: s[7] !== null ? s[7] : 0,
            onGround: !!s[8],
            velocity: s[9] !== null ? s[9] : 0,
            heading: s[10] !== null ? s[10] : 0
          });
        }
      }

      // ----------------------------------------------------
      // 2. PROCESAMIENTO DE SISMOS Y ALERTAS (Geología Global)
      // ----------------------------------------------------
      if (usgsRes && usgsRes.status === 200) {
        const usgsData = await usgsRes.json();
        const features = usgsData.features || [];

        for (let i = 0; i < features.length; i++) {
          const feat = features[i];
          const coords = feat.geometry && feat.geometry.coordinates;
          if (!coords) continue;
          
          const lon = coords[0];
          const lat = coords[1];
          const depth = coords[2];

          if (hasBounds && (lat < lamin || lat > lamax || lon < lomin || lon > lomax)) continue;

          states.push({
            type: "hazard",
            icao24: "eq_" + feat.id,
            callsign: `SISMO M${feat.properties.mag}`,
            country: "SEISMIC",
            lon: lon,
            lat: lat,
            altitude: depth * 1000,
            onGround: true,
            velocity: 0,
            heading: 0
          });
        }
      }

      // ----------------------------------------------------
      // 3. CÁMARAS DE VIGILANCIA Y PUNTOS CLAVE (CCTV Global)
      // ----------------------------------------------------
      const cameras = [
        { id: "cam_ny", title: "CCTV TIMES SQUARE // NYC", lat: 40.7580, lon: -73.9855, country: "CCTV" },
        { id: "cam_tokyo", title: "CCTV TOKYO TOWER", lat: 35.6586, lon: 139.7454, country: "CCTV" },
        { id: "cam_madrid", title: "CCTV PUERTA DEL SOL", lat: 40.4169, lon: -3.7035, country: "CCTV" },
        { id: "cam_london", title: "CCTV ABBEY ROAD // LON", lat: 51.5320, lon: -0.1773, country: "CCTV" },
        { id: "cam_paris", title: "CCTV EIFFEL TOWER // PAR", lat: 48.8584, lon: 2.2945, country: "CCTV" },
        { id: "cam_sydney", title: "CCTV OPERA HOUSE // SYD", lat: -33.8568, lon: 151.2153, country: "CCTV" }
      ];

      for (let i = 0; i < cameras.length; i++) {
        const c = cameras[i];
        if (hasBounds && (c.lat < lamin || c.lat > lamax || c.lon < lomin || c.lon > lomax)) continue;

        states.push({
          type: "camera",
          icao24: c.id,
          callsign: c.title,
          country: c.country,
          lon: c.lon,
          lat: c.lat,
          altitude: 0,
          onGround: true,
          velocity: 0,
          heading: 0
        });
      }

      // Respuesta maestra optimizada con metadatos globales
      return new Response(JSON.stringify({ 
        timestamp: Math.floor(Date.now() / 1000),
        count: states.length,
        states 
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=5'
        }
      });

    } catch (error) {
      return new Response(JSON.stringify({ states: [], error: error.message }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*' 
        }
      });
    }
  }
};
