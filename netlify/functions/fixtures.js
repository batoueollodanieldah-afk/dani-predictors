exports.handler = async function (event) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

  if (!API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Configuration incomplète" })
    };
  }

  try {
    const requestedDate = event.queryStringParameters?.date;
    const today = new Date().toISOString().slice(0, 10);

    const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || "")
      ? requestedDate
      : today;

    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${date}`,
      {
        headers: { "x-apisports-key": API_KEY }
      }
    );

    const data = await response.json();

    if (!response.ok || (data.errors &&
        Object.keys(data.errors).length > 0)) {
      return {
        statusCode: response.status || 400,
        body: JSON.stringify(data)
      };
    }

    const leagues = [
      "premier league",
      "championship",
      "league one",
      "la liga",
      "segunda division",
      "bundesliga",
      "2. bundesliga",
      "serie a",
      "serie b",
      "ligue 1",
      "ligue 2",
      "primeira liga",
      "liga portugal",
      "eredivisie",
      "belgian pro league",
      "jupiler pro league",
      "super lig",
      "süper lig",
      "mls",
      "major league soccer",
      "brasileirao",
      "serie a brazil",
      "primera division",
      "argentine primera division",
      "champions league",
      "europa league",
      "conference league",
      "africa cup of nations",
      "caf champions league"
    ];

    const now = Date.now();

    const matches = (data.response || [])
      .filter(match => {
        const leagueName =
          (match.league.name || "").toLowerCase();

        const home =
          (match.teams.home.name || "").toLowerCase();

        const away =
          (match.teams.away.name || "").toLowerCase();

        const excluded = [
          "u19", "u20", "u21", "u23",
          "youth", "junior", "reserve",
          "women", "feminine", "feminin"
        ];

        const text = `${leagueName} ${home} ${away}`;

        const isExcluded = excluded.some(word =>
          text.includes(word)
        );

        const selectedLeague = leagues.some(name =>
          leagueName.includes(name)
        );

        const status = match.fixture.status.short;
        const matchTime = match.fixture.timestamp * 1000;

        const upcoming =
          ["NS", "TBD"].includes(status) &&
          matchTime > now;

        return selectedLeague && upcoming && !isExcluded;
      })
      .map(match => ({
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

    // Enregistrement dans Supabase
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
        throw new Error(
          "Erreur Supabase : " + await dbResponse.text()
        );
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      },
      body: JSON.stringify({
        get: data.get,
        parameters: data.parameters,
        total_matches_received: (data.response || []).length,
        results: matches.length,
        response: matches,
        database_sync: {
          success: true,
          saved_matches: matches.length
        }
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
