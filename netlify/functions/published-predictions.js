exports.handler = async function (event) {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  const jsonResponse = (statusCode, body, cache = false) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? "public, max-age=30, s-maxage=60" : "no-store",
      "Netlify-CDN-Cache-Control": cache ? "public, s-maxage=60" : "no-store"
    },
    body: JSON.stringify(body)
  });

  if (event.httpMethod && event.httpMethod !== "GET") {
    return jsonResponse(405, {
      success: false,
      error: "Méthode non autorisée. Utilise GET."
    });
  }

  if (!supabaseUrl || !supabaseKey) {
    return jsonResponse(500, {
      success: false,
      error: "Configuration Supabase manquante côté serveur."
    });
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value;
  }

  function abidjanDate() {
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

  try {
    const params = new URLSearchParams({
      select: "id,match_id,prediction,confidence,analysis,status,published,created_at,result,settled_at,matches!predictions_match_id_fkey!inner(home_team,away_team,league,country,match_date,home_score,away_score,status)",
      published: "eq.true",
      status: "eq.published",
      order: "created_at.desc",
      limit: "100"
    });

    const history = event.queryStringParameters?.history === "1";

    if (!history) {
      const requestedDate = event.queryStringParameters?.date;
      const date = validDate(requestedDate)
        ? requestedDate
        : abidjanDate();

      params.append(
        "matches.match_date",
        `gte.${date}T00:00:00Z`
      );

      params.append(
        "matches.match_date",
        `lt.${new Date(
          new Date(`${date}T00:00:00Z`).getTime() + 86400000
        ).toISOString()}`
      );
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/predictions?${params.toString()}`,
      {
        method: "GET",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Lecture Supabase des pronostics :", errorText);

      return jsonResponse(502, {
        success: false,
        error: "Impossible de lire les pronostics publiés."
      });
    }

    const rows = await response.json();

    const predictions = (rows || []).map(row => {
      const match = Array.isArray(row.matches)
        ? row.matches[0]
        : row.matches;

      const clean = { ...row, match };
      delete clean.matches;

      return clean;
    });

    return jsonResponse(200, {
      success: true,
      history,
      count: predictions.length,
      predictions
    }, true);

  } catch (error) {
    console.error("Erreur published-predictions :", error.message);

    return jsonResponse(500, {
      success: false,
      error: "Erreur pendant le chargement des pronostics."
    });
  }
};