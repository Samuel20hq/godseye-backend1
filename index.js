export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Extracción y saneamiento de coordenadas del Bounding Box
    const lamin = parseFloat(url.searchParams.get('lamin'));
    const lamax = parseFloat(url.searchParams.get('lamax'));
    const lomin = parseFloat(url.searchParams.get('lomin'));
    const lomax = parseFloat(url.searchParams.get('lomax'));
    
    const hasBounds = !isNaN(lamin) && !isNaN(lamax) && !isNaN(lomin) && !isNaN(lomax);

    try {
      // Petición optimizada a OpenSky con caché perimetral perjudicial para errores 429
      const openSkyResponse = await fetch('https://opensky-network.org/api/states/all', {
        headers: { 
          'User-Agent': 'GodsEyeIndustrial/5.0 (GlobalTelemetry)' 
        },
        cf: {
          cacheTtl: 8, // Caché en borde durante 8 segundos para ultra-velocidad
          cacheEverything: true
        }
      });

      if (openSkyResponse.status === 429) {
        return new Response(JSON.stringify({ states: [] }), {
          status: 429,
          headers: { 
            'Content-Type': 'application/json',
            'X-Rate-Limit-Retry-After-Seconds': '15',
            'Access-Control-Allow-Origin': '*' 
          }
        });
      }

      if (!openSkyResponse.ok) {
        throw new Error(`OpenSky upstream error: ${openSkyResponse.status}`);
      }

      const data = await openSkyResponse.json();
      const rawStates = data.states || [];
      const totalCount = rawStates.length;

      // Pre-asignación de capacidad para optimizar memoria del motor V8
      const states = [];
      
      for (let i = 0; i < totalCount; i++) {
        const s = rawStates[i];
        const lon = s[5];
        const lat = s[6];

        // Validación estricta de coordenadas nulas o corruptas
        if (lon === null || lat === null || typeof lon !== 'number' || typeof lat !== 'number') {
          continue;
        }

        // Filtrado espacial en el servidor si la app envía límites de pantalla
        if (hasBounds) {
          if (lat < lamin || lat > lamax || lon < lomin || lon > lomax) {
            continue;
          }
        }

        // Construcción limpia adaptada exactamente a tu ProxyState en Swift
        states.push({
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

      return new Response(JSON.stringify({ states }), {
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
