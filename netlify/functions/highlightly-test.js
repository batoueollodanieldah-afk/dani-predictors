exports.handler = async function (event) {
  const API_KEY = process.env.HIGHLIGHTLY_API_KEY;

  const jsonResponse = (statusCode, body) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  });

  if (event.httpMethod && event.httpMethod !== "GET") {
    return jsonResponse(405, {
      success: false,
      error: "Méthode non autorisée."
    });
  }

  if (!API_KEY) {
    return jsonResponse(500, {
      success: false,
      error: "HIGHLIGHTLY_API_KEY n'est pas configurée dans Netlify."
    });
  }

  function getAbidjanDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Abidjan",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const values = {};
    parts.forEach(part => {
      values[part.type] = part.value;
    });

    return `${values.year}-${values.month}-${values.day}`;
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
      return false;
    }

    const parsed = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value;
  }

  const requestedDate = event.queryStringParameters?.date;
  const date = isValidDate(requestedDate)
    ? requestedDate
    : getAbidjanDate();

  try {
    const url = new URL("https://soccer.highlightly.net/matches");

    url.searchParams.set("date", date);
    url.searchParams.set("limit", "100");
    url.searchParams.set("timezone", "Africa/Abidjan");

    const apiResponse = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": API_KEY,
        "Accept": "application/json"
      }
    });

    let payload;

    try {
      payload = await apiResponse.json();
    } catch (error) {
      return jsonResponse(502, {
        success: false,
        error: "Réponse illisible reçue de Highlightly.",
        api_status: apiResponse.status
      });
    }

    const quota = {
      limit: apiResponse.headers.get("x-ratelimit-requests-limit"),
      remaining: apiResponse.headers.get("x-ratelimit-requests-remaining")
    };

    if (!apiResponse.ok) {
      return jsonResponse(502, {
        success: false,
        provider: "Highlightly",
        api_status: apiResponse.status,
        api_error: payload?.message || payload?.error || payload?.errors || "Erreur API.",
        quota
      });
    }

    const matches = Array.isArray(payload?.data)
      ? payload.data
      : [];

    const competitions = new Map();

    matches.forEach(match => {
      if (!match.league?.name) return;

      const country = match.country?.name || "International";
      const key = `${match.league.id}-${match.league.name}-${country}`;

      if (!competitions.has(key)) {
        competitions.set(key, {
          league_id: match.league.id,
          league: match.league.name,
          country,
          fixtures: 0
        });
      }

      competitions.get(key).fixtures++;
    });

    const availableCompetitions = Array.from(competitions.values())
      .sort((a, b) => a.country.localeCompare(b.country));

    const sampleMatches = matches.slice(0, 10).map(match => ({
      id: match.id,
      home_team: match.homeTeam?.name || "Inconnue",
      away_team: match.awayTeam?.name || "Inconnue",
      league: match.league?.name || "Inconnue",
      country: match.country?.name || "International",
      date: match.date || null,
      status: match.state?.description || "Inconnu",
      score: match.state?.score?.current || null
    }));

    return jsonResponse(200, {
      success: true,
      provider: "Highlightly",
      requested_date: date,
      generated_at: new Date().toISOString(),
      plan: payload?.plan || null,
      total_matches_received: matches.length,
      total_matches_available: payload?.pagination?.totalCount ?? matches.length,
      available_competitions_count: availableCompetitions.length,
      available_competitions: availableCompetitions.slice(0, 30),
      sample_matches: sampleMatches,
      pagination: payload?.pagination || null,
      quota
    });

  } catch (error) {
    return jsonResponse(500, {
      success: false,
      provider: "Highlightly",
      error: "Impossible de contacter Highlightly.",
      details: error.message
    });
  }
};
