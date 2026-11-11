const HIGHLIGHTLY_BASE = "https://soccer.highlightly.net";
const MATCH_ID_OFFSET = 2000000000000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

exports.handler = async function (event) {
  const API_KEY = process.env.HIGHLIGHTLY_API_KEY;
  const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
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

  function normalizeStatus(description) {
    const value = String(description || "").trim().toLowerCase();

    const statuses = {
      "to be announced": "TBD",
      "not started": "NS",
      "first half": "1H",
      "half time": "HT",
      "second half": "2H",
      "extra time": "ET",
      "break time": "BT",
      "penalties": "P",
      "suspended": "SUSP",
      "interrupted": "INT",
      "finished": "FT",
      "finished after penalties": "PEN",
      "finished after extra time": "AET",
      "postponed": "PST",
      "cancelled": "CANC",
      "canceled": "CANC",
      "abandoned": "ABD",
      "awarded": "AWD",
      "in progress": "LIVE",
      "unknown": "UNK"
    };

    return statuses[value] || "TBD";
  }

  function getMatchCategory(status) {
    if (["PST", "CANC", "ABD", "AWD", "UNK"].includes(status)) {
      return "excluded";
    }

    if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "SUSP", "INT"].includes(status)) {
      return "live";
    }

    if (["FT", "AET", "PEN"].includes(status)) {
      return "finished";
    }

    return "upcoming";
  }

  function parseScore(value) {
    if (typeof value !== "string") {
      return { home: null, away: null };
    }

    const match = value.match(/^(\d+)\s*[-–:]\s*(\d+)$/);

    if (!match) {
      return { home: null, away: null };
    }

    return {
      home: Number(match[1]),
      away: Number(match[2])
    };
  }

  const requestedDate = event.queryStringParameters?.date;

  const date = isValidDate(requestedDate)
    ? requestedDate
    : getAbidjanDate();

  try {
    const rawMatches = [];

    let totalMatchesAvailable = 0;
    let plan = null;

    let quota = {
      limit: null,
      remaining: null
    };

    let pagesFetched = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;

      const url = new URL(`${HIGHLIGHTLY_BASE}/matches`);

      url.searchParams.set("date", date);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("timezone", "Africa/Abidjan");

      const apiResponse = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-rapidapi-key": API_KEY,
          "Accept": "application/json"
        }
      });

      quota = {
        limit: apiResponse.headers.get("x-ratelimit-requests-limit"),
        remaining: apiResponse.headers.get("x-ratelimit-requests-remaining")
      };

      let payload;

      try {
        payload = await apiResponse.json();
      } catch (error) {
        return jsonResponse(502, {
          success: false,
          provider: "Highlightly",
          requested_date: date,
          error: "Réponse illisible reçue de Highlightly.",
          api_status: apiResponse.status,
          quota
        });
      }

      if (!apiResponse.ok) {
        return jsonResponse(502, {
          success: false,
          provider: "Highlightly",
          requested_date: date,
          api_status: apiResponse.status,
          api_error: payload?.message ||
            payload?.error ||
            payload?.errors ||
            "Erreur API.",
          pages_fetched: pagesFetched,
          quota
        });
      }

      const pageMatches = Array.isArray(payload?.data)
        ? payload.data
        : [];

      plan = payload?.plan || plan;

      totalMatchesAvailable = Number(
        payload?.pagination?.totalCount ?? pageMatches.length
      );

      rawMatches.push(...pageMatches);

      pagesFetched += 1;

      if (
        pageMatches.length === 0 ||
        rawMatches.length >= totalMatchesAvailable ||
        pageMatches.length < PAGE_SIZE
      ) {
        break;
      }
    }

    const seen = new Set();
    const matches = [];
    const competitionMap = new Map();

    rawMatches.forEach(raw => {
      const sourceId = Number(raw?.id);

      if (
        !Number.isSafeInteger(sourceId) ||
        sourceId <= 0 ||
        seen.has(sourceId)
      ) {
        return;
      }

      const home = raw?.homeTeam;
      const away = raw?.awayTeam;
      const league = raw?.league;

      if (
        !home?.name ||
        !away?.name ||
        !league?.name ||
        !raw?.date
      ) {
        return;
      }

      seen.add(sourceId);

      const country = raw?.country?.name || "International";

      const competitionKey =
        `${league.id || ""}|${league.name}|${country}`;

      const competition = competitionMap.get(competitionKey) || {
        league_id: league.id || null,
        league: league.name,
        country,
        fixtures: 0
      };

      competition.fixtures += 1;

      competitionMap.set(competitionKey, competition);

      const statusLong = raw?.state?.description || "Unknown";

      const status = normalizeStatus(statusLong);

      const score = getMatchCategory(status) === "upcoming"
        ? { home: null, away: null }
        : parseScore(raw?.state?.score?.current);

      matches.push({
        id: MATCH_ID_OFFSET + sourceId,
        source_match_id: sourceId,
        provider: "highlightly",

        home_team_id: Number(home.id) || null,
        away_team_id: Number(away.id) || null,
        league_id: Number(league.id) || null,

        home_team: home.name,
        away_team: away.name,

        home_logo: home.logo || "",
        away_logo: away.logo || "",

        league: league.name,
        league_logo: league.logo || "",

        country,
        match_date: raw.date,

        status,
        status_long: statusLong,

        elapsed: Number.isFinite(raw?.state?.clock)
          ? raw.state.clock
          : null,

        home_score: score.home,
        away_score: score.away,

        match_category: getMatchCategory(status)
      });
    });

    matches.sort((a, b) =>
      new Date(a.match_date) - new Date(b.match_date)
    );

    const availableCompetitions =
      Array.from(competitionMap.values()).sort((a, b) =>
        a.country.localeCompare(b.country) ||
        a.league.localeCompare(b.league)
      );

    const counts = {
      upcoming: matches.filter(
        match => match.match_category === "upcoming"
      ).length,

      live: matches.filter(
        match => match.match_category === "live"
      ).length,

      finished: matches.filter(
        match => match.match_category === "finished"
      ).length,

      excluded: matches.filter(
        match => match.match_category === "excluded"
      ).length
    };

    let databaseSync = {
      success: false,
      saved_matches: 0,
      message: "Synchronisation non effectuée"
    };

    if (SUPABASE_URL && SUPABASE_KEY && matches.length > 0) {
      try {
        const rows = matches.map(match => ({
          id: match.id,
          source_match_id: match.source_match_id,
          provider: match.provider,

          home_team_id: match.home_team_id,
          away_team_id: match.away_team_id,
          league_id: match.league_id,

          home_team: match.home_team,
          away_team: match.away_team,

          home_logo: match.home_logo,
          away_logo: match.away_logo,
          league_logo: match.league_logo,

          league: match.league,
          country: match.country,
          match_date: match.match_date,

          status: match.status,
          status_long: match.status_long,
          elapsed: match.elapsed,

          home_score: match.home_score,
          away_score: match.away_score,

          match_category: match.match_category
        }));

        for (let i = 0; i < rows.length; i += 100) {
          const response = await fetch(
            `${SUPABASE_URL}/rest/v1/matches?on_conflict=id`,
            {
              method: "POST",
              headers: {
                apikey: SUPABASE_KEY,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates,return=minimal"
              },
              body: JSON.stringify(rows.slice(i, i + 100))
            }
          );

          if (!response.ok) {
            throw new Error(await response.text());
          }
        }

        databaseSync = {
          success: true,
          saved_matches: rows.length,
          message: "Synchronisation Highlightly réussie"
        };

      } catch (error) {
        console.error(
          "Synchronisation Supabase Highlightly :",
          error.message
        );

        databaseSync = {
          success: false,
          saved_matches: 0,
          message: "Matchs récupérés, mais synchronisation Supabase impossible."
        };
      }
    }

    return jsonResponse(200, {
      success: true,
      provider: "Highlightly",
      requested_date: date,
      generated_at: new Date().toISOString(),

      plan,

      total_matches_received: rawMatches.length,
      results: matches.length,
      total_matches_available: totalMatchesAvailable,

      available_competitions_count: availableCompetitions.length,
      available_competitions: availableCompetitions,

      counts,

      pagination: {
        pages_fetched: pagesFetched,
        page_size: PAGE_SIZE,
        total_count: totalMatchesAvailable,
        truncated: rawMatches.length < totalMatchesAvailable
      },

      quota,
      database_sync: databaseSync,

      response: matches
    }, true);

  } catch (error) {
    console.error(
      "Erreur fixtures Highlightly :",
      error.message
    );

    return jsonResponse(500, {
      success: false,
      provider: "Highlightly",
      error: "Erreur pendant la récupération des matchs.",
      details: error.message
    });
  }
};
