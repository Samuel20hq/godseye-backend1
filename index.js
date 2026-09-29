export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Coordenadas del mapa enviadas desde la app de iOS (Bounding Box)
    const lamin = parseFloat(url.searchParams.get('lamin')) || -90;
    const lamax = parseFloat(url.searchParams.get('lamax')) || 90;
    const lomin = parseFloat(url.searchParams.get('lomin')) || -180;
    const lomax = parseFloat(url.searchParams.get('lomax')) || 180;

    try {
      // Petición a la API abierta de OpenSky Network
      const openSkyResponse = await fetch('https://opensky-network.org/api/states/all');
      const data = await openSkyResponse.json();
      
      if (!data.states) {
        return new Response(JSON.stringify({ states: [] }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Filtra solo los aviones que están dentro de la pantalla visible del iPad
      const filteredStates = data.states.filter(state => {
        const lon = state[5];
        const lat = state[6];
        if (lon === null || lat === null) return false;
        return lat >= lamin && lat <= lamax && lon >= lomin && lon <= lomax;
      });

      // Estructura limpia y ligera para optimizar el consumo de datos en la app
      const simplified = filteredStates.map(s => ({
        icao24: s[0],
        callsign: (s[1] || "").trim(),
        country: s[2],
        lon: s[5],
        lat: s[6],
        altitude: s[7],
        onGround: s[8],
        velocity: s[9],
        heading: s[10]
      }));

      return new Response(JSON.stringify({ states: simplified }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*' 
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
};
