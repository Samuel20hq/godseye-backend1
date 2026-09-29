export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const lamin = parseFloat(url.searchParams.get('lamin'));
    const lamax = parseFloat(url.searchParams.get('lamax'));
    const lomin = parseFloat(url.searchParams.get('lomin'));
    const lomax = parseFloat(url.searchParams.get('lomax'));
    
    const hasBounds = !isNaN(lamin) && !isNaN(lamax) && !isNaN(lomin) && !isNaN(lomax);

    try {
      const [openSkyRes, usgsRes] = await Promise.all([
        fetch('https://opensky-network.org/api/states/all', {
          headers: { 'User-Agent': 'GodsEyeUltimate/8.0' },
          cf: { cacheTtl: 8, cacheEverything: true }
        }).catch(() => null),
        
        fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', {
          cf: { cacheTtl: 60, cacheEverything: true }
        }).catch(() => null)
      ]);

      const states = [];
      let openskyStatus = "ok";

      // 1. Vuelos
      if (openSkyRes) {
        if (openSkyRes.status === 429) {
          openskyStatus = "rate_limited";
        } else if (openSkyRes.ok) {
          const data = await openSkyRes.json();
          const rawStates = data.states || [];
          
          for (let i = 0; i < rawStates.length; i++) {
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
              heading: s[10] !== null ? s[10] : 0,
              vrate: s[11] !== null ? s[11] : 0,
              fix: s[3] !== null ? s[3] : Math.floor(Date.now() / 1000),
              url: null
            });
          }
        }
      } else {
        openskyStatus = "error";
      }

      // 2. Sismos (Hazards)
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
            heading: 0,
            vrate: 0,
            fix: feat.properties.time ? Math.floor(feat.properties.time / 1000) : Math.floor(Date.now() / 1000),
            url: null
          });
        }
      }

      // 3. Cámaras de Vigilancia Globales con URLs de feeds reales en directo
      const cameras = [
        { id: "cam_ny", title: "CCTV TIMES SQUARE // NYC", lat: 40.7580, lon: -73.9855, country: "CCTV", url: "https://images.earthcam.com/ec_metros/ourcams/fridays.jpg" },
        { id: "cam_tokyo", title: "CCTV TOKYO TOWER", lat: 35.6586, lon: 139.7454, country: "CCTV", url: "https://www.japan-guide.com/webcam/tokyo_tower.jpg" },
        { id: "cam_madrid", title: "CCTV PUERTA DEL SOL", lat: 40.4169, lon: -3.7035, country: "CCTV", url: "https://static.webcamgalore.com/webcams/large/Puerta-del-Sol-Madrid.jpg" },
        { id: "cam_london", title: "CCTV PICCADILLY // LON", lat: 51.5101, lon: -0.1342, country: "CCTV", url: "https://images.earthcam.com/ec_metros/ourcams/piccadilly.jpg" },
        { id: "cam_shibuya", title: "CCTV SHIBUYA CROSSING // TYO", lat: 35.6595, lon: 139.7004, country: "CCTV", url: "https://images.earthcam.com/ec_metros/ourcams/shibuya.jpg" }
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
          heading: 0,
          vrate: 0,
          fix: Math.floor(Date.now() / 1000),
          url: c.url
        });
      }

      return new Response(JSON.stringify({ 
        timestamp: Math.floor(Date.now() / 1000),
        flightsTime: Math.floor(Date.now() / 1000),
        sources: { opensky: openskyStatus },
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
