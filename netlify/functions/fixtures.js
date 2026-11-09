exports.handler = async function (event) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

  const jsonResponse = (statusCode, body, cache = false) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? "public, max-age=60, s-maxage=300" : "no-store",
      "Netlify-CDN-Cache-Control": cache ? "public, s-maxage=300" : "no-store"
    },
    body: JSON.stringify(body)
  });

  if (event.httpMethod && event.httpMethod !== "GET") {
    return jsonResponse(405, {
      success: false,
      error: "Méthode non autorisée. Utilise GET."
    });
  }

  if (!API_KEY) {
    return jsonResponse(500, {
      success: false,
      error: "La variable API_FOOTBALL_KEY n'est pas configurée dans Netlify."
    });
  }

  try {
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

    function normalize(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    const requestedDate = event.queryStringParameters?.date;

    const date = isValidDate(requestedDate)
      ? requestedDate
      : getAbidjanDate();

    /*
      IMPORTANT :
      Aucune liste blanche de pays ou de championnats.

      Le système conserve les compétitions reçues par API-Football
      dans le monde entier, puis écarte uniquement les rencontres
      féminines, jeunes et équipes réserves.
    */

    const excludedCompetitionPattern =
      /\b(women|woman|frauen|feminine|feminin|ladies|girls|youth|junior|academy|reserve|reserves|u\s?(17|18|19|20|21|23)|under\s?(17|18|19|20|21|23))\b/;

    function isExcludedTeam(name) {
      const team = normalize(name);

      return /(?:^|\s)(ii|iii|iv|b|u\s?(17|18|19|20|21|23)|under\s?(17|18|19|20|21|23))$/.test(team);
    }

    function getMatchCategory(status) {
      const code = String(status || "").toUpperCase();

      if ([
        "1H",
        "HT",
        "2H",
        "ET",
        "BT",
        "P",
        "LIVE",
        "SUSP",
        "INT"
      ].includes(code)) {
        return "live";
      }

      if (["FT", "AET", "PEN"].includes(code)) {
        return "finished";
      }

      return "upcoming";
    }

    // Récupération des matchs du jour auprès d'API-Football.

    const apiResponse = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(date)}`,
      {
        method: "GET",
        headers: {
          "x-apisports-key": API_KEY,
          "Accept": "application/json"
        }
      }
    );

    let data;

    try {
      data = await apiResponse.json();
    } catch (parseError) {
      return jsonResponse(502, {
        success: false,
        requested_date: date,
        error: "Réponse illisible reçue depuis API-Football."
      });
    }

    const hasErrors =
      data?.errors && Object.keys(data.errors).length > 0;

    if (!apiResponse.ok || hasErrors) {
      return jsonResponse(502, {
        success: false,
        requested_date: date,
        api_status: apiResponse.status,
        errors: data?.errors || {},
        message: "API-Football n'a pas fourni les rencontres pour cette date. Vérifie aussi la période autorisée par ton forfait."
      });
    }

    const rawMatches = Array.isArray(data?.response)
      ? data.response
      : [];

    // Liste des compétitions réellement reçues par l'API.

    const competitionMap = new Map();

    rawMatches.forEach(match => {
      const league = match?.league;

      if (!league?.name) return;

      const country = league.country || "International";

      const key =
        `${league.id || ""}|${normalize(country)}|${normalize(league.name)}`;

      const item = competitionMap.get(key) || {
        league_id: league.id || null,
        league: league.name,
        country,
        fixtures: 0
      };

      item.fixtures += 1;

      competitionMap.set(key, item);
    });

    const availableCompetitions =
      Array.from(competitionMap.values()).sort((a, b) =>
        a.country.localeCompare(b.country) ||
        a.league.localeCompare(b.league)
      );

    // Filtrage des matchs non souhaités.

    const filteredMatches = rawMatches.filter(match => {
      if (
        !match?.fixture ||
        !match?.league ||
        !match?.teams?.home ||
        !match?.teams?.away
      ) {
        return false;
      }

      const leagueName = normalize(match.league.name);
      const homeName = normalize(match.teams.home.name);
      const awayName = normalize(match.teams.away.name);

      const searchableText =
        `${leagueName} ${homeName} ${awayName}`;

      if (excludedCompetitionPattern.test(searchableText)) {
        return false;
      }

      if (
        isExcludedTeam(homeName) ||
        isExcludedTeam(awayName)
      ) {
        return false;
      }

      const status =
        String(match.fixture.status?.short || "").toUpperCase();

      if ([
        "PST",
        "CANC",
        "ABD",
        "AWD",
        "WO",
        "CANC."
      ].includes(status)) {
        return false;
      }

      return true;
    });

    // Préparation des rencontres pour le site.

    const matches = filteredMatches.map(match => {
      const status = match.fixture.status?.short || "NS";

      return {
        id: match.fixture.id,

        home_team:
          match.teams.home?.name || "Équipe inconnue",

        away_team:
          match.teams.away?.name || "Équipe inconnue",

        home_logo:
          match.teams.home?.logo || "",

        away_logo:
          match.teams.away?.logo || "",

        league:
          match.league.name || "Championnat",

        league_id:
          match.league.id || null,

        league_logo:
          match.league.logo || "",

        country:
          match.league.country || "International",

        match_date:
          match.fixture.date,

        status,

        status_long:
          match.fixture.status?.long || "Non commencé",

        elapsed:
          match.fixture.status?.elapsed ?? null,

        home_score:
          match.goals?.home ?? null,

        away_score:
          match.goals?.away ?? null,

        match_category:
          getMatchCategory(status)
      };
    });

    // Comptage des matchs.

    const counts = {
      upcoming: matches.filter(
        match => match.match_category === "upcoming"
      ).length,

      live: matches.filter(
        match => match.match_category === "live"
      ).length,

      finished: matches.filter(
        match => match.match_category === "finished"
      ).length
    };

    // Synchronisation avec Supabase.

    let databaseSync = {
      success: false,
      saved_matches: 0,
      message: "Synchronisation Supabase non configurée."
    };

    if (
      SUPABASE_URL &&
      SUPABASE_KEY &&
      matches.length > 0
    ) {
      try {
        const databaseRows = matches.map(match => ({
          id: match.id,
          home_team: match.home_team,
          away_team: match.away_team,
          league: match.league,
          country: match.country,
          match_date: match.match_date,
          status: match.status,
          home_score: match.home_score,
          away_score: match.away_score
        }));

        const cleanUrl = SUPABASE_URL.replace(/\/+$/, "");

        // Enregistrement par lots pour limiter les requêtes.

        for (let i = 0; i < databaseRows.length; i += 500) {
          const batch = databaseRows.slice(i, i + 500);

          const dbResponse = await fetch(
            `${cleanUrl}/rest/v1/matches?on_conflict=id`,
            {
              method: "POST",

              headers: {
                apikey: SUPABASE_KEY,

                Authorization: `Bearer ${SUPABASE_KEY}`,

                "Content-Type": "application/json",

                Prefer: "resolution=merge-duplicates,return=minimal"
              },

              body: JSON.stringify(batch)
            }
          );

          if (!dbResponse.ok) {
            const errorText = await dbResponse.text();

            throw new Error(
              `Supabase ${dbResponse.status}: ${errorText}`
            );
          }
        }

        databaseSync = {
          success: true,
          saved_matches: databaseRows.length,
          message: "Synchronisation Supabase réussie."
        };

      } catch (dbError) {
        console.error("Erreur Supabase :", dbError.message);

        databaseSync = {
          success: false,
          saved_matches: 0,
          message: "Matchs récupérés, mais enregistrement Supabase impossible.",
          details: dbError.message
        };
      }

    } else if (matches.length === 0) {
      databaseSync = {
        success: true,
        saved_matches: 0,
        message: "Aucun match retenu pour cette date."
      };
    }

    // Réponse envoyée au site DANI PREDICTORS.

    return jsonResponse(200, {
      success: true,

      requested_date: date,

      generated_at: new Date().toISOString(),

      total_matches_received: rawMatches.length,

      results: matches.length,

      excluded_matches:
        rawMatches.length - matches.length,

      counts,

      available_competitions: availableCompetitions,

      available_competitions_count:
        availableCompetitions.length,

      response: matches,

      database_sync: databaseSync

    }, true);

  } catch (error) {
    console.error("Erreur fixtures :", error.message);

    return jsonResponse(500, {
      success: false,

      error: "Erreur pendant la récupération des matchs.",

      details: error.message
    });
  }
};
