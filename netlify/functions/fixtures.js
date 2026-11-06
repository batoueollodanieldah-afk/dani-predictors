exports.handler = async function (event) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

  if (!API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Configuration des clés API incomplète"
      })
    };
  }

  try {
    const requestedDate = event.queryStringParameters?.date;
    const today = new Date().toISOString().slice(0, 10);

    const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '')
      ? requestedDate
      : today;

    // Récupération des matchs
    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${date}`,
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    const data = await response.json();

    if (!response.ok || data.errors && Object.keys(data.errors).length) {
      return {
        statusCode: response.status || 400,
        body: JSON.stringify(data)
      };
    }

    // Préparation des matchs pour Supabase
    const matches = (data.response || []).map(match => ({
      id: match.fixture.id,
      home_team: match.teams.home.name,
      away_team: match.teams.away.name,
      league: match.league.name,
      country: match.league.country,
      match_date: match.fixture.date,
      status: match.fixture.status.short,
      home_score: match.goals.home,
      away_score: match.goals.away
    }));

    // Enregistrement par lots de 100 matchs
    for (let i = 0; i < matches.length; i += 100) {
      const batch = matches.slice(i, i + 100);

      const dbResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/matches?on_conflict=id`,
        {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates"
          },
          body: JSON.stringify(batch)
        }
      );

      if (!dbResponse.ok) {
        const errorText = await dbResponse.text();
        throw new Error("Erreur Supabase : " + errorText);
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      },
      body: JSON.stringify({
        ...data,
        database_sync: {
          success: true,
          saved_matches: matches.length
        }
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message
      })
    };
  }
};
