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

    if (!response.ok || (
      data.errors && Object.keys(data.errors).length > 0
    )) {
      return {
        statusCode: response.status || 400,
        body: JSON.stringify(data)
      };
    }

    // Normalisation des noms
    const normalize = value =>
      (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // Championnats principaux autorisés :
    // format : pays|nom exact du championnat
    const allowedLeagues = [
      // Europe
      "england|premier league",
      "spain|la liga",
      "italy|serie a",
      "germany|bundesliga",
      "france|ligue 1",
      "netherlands|eredivisie",
      "portugal|liga portugal",
      "portugal|primeira liga",
      "belgium|jupiler pro league",
      "turkey|super lig",
      "scotland|premiership",

      // Amérique
      "usa|major league soccer",
      "brazil|serie a",
      "argentina|liga profesional argentina",
      "argentina|primera division",

      // Asie et Océanie
      "japan|j1 league",
      "australia|a league",

      // Afrique
      "cote d ivoire|ligue 1",
      "burkina faso|ligue 1",
      "senegal|ligue 1",
      "cameroon|elite one",
      "algeria|ligue 1",
      "tunisia|ligue 1",
      "dr congo|ligue 1",
      "morocco|botola pro",
      "egypt|premier league",
      "south africa|premier soccer league",
      "ghana|premier league",
      "nigeria|npfl",
      "kenya|fkf premier league",
      "uganda|premier league",
      "mali|premiere division",
      "tanzania|ligi kuu bara",
      "zambia|super league"
    ];

    // Grandes compétitions internationales
    const internationalLeagues = [
      "uefa champions league",
      "uefa europa league",
      "uefa conference league",
      "caf champions league",
      "caf confederation cup",
      "africa cup of nations",
      "fifa world cup",
      "world cup"
    ];

    const excludedWords = [
      "women",
      "woman",
      "frauen",
      "feminine",
      "feminin",
      "ladies",
      "girls",
      "youth",
      "junior",
      "academy",
      "reserve",
      "reserves",
      "u17",
      "u18",
      "u19",
      "u20",
      "u21",
      "u23"
    ];

    const now = Date.now();

    const matches = (data.response || [])
      .filter(match => {
        const leagueName = normalize(match.league.name);
        const country = normalize(match.league.country);
        const home = normalize(match.teams.home.name);
        const away = normalize(match.teams.away.name);

        const fullText =
          `${leagueName} ${home} ${away}`;

        // Exclusion des catégories non souhaitées
        const excluded = excludedWords.some(word =>
          fullText.includes(normalize(word))
        );

        // Exclusion des équipes réserves et féminines
        const reserveTeam = team =>
          /(?:^|\s)(?:ii|iii|iv|b|w|women|u17|u18|u19|u20|u21|u23)$/.test(team);

        const excludedTeam =
          reserveTeam(home) || reserveTeam(away);

        // Vérification pays + championnat exact
        const leagueKey = `${country}|${leagueName}`;

        const selectedLeague =
          allowedLeagues.includes(leagueKey) ||
          internationalLeagues.includes(leagueName);

        // Matchs à venir uniquement
        const status = match.fixture.status.short;
        const matchTime = match.fixture.timestamp * 1000;

        const upcoming =
          ["NS", "TBD"].includes(status) &&
          matchTime > now;

        return (
          selectedLeague &&
          upcoming &&
          !excluded &&
          !excludedTeam
        );
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
