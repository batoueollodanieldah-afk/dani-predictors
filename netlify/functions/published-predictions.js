function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Vary": "Authorization"
    },
    body: JSON.stringify(body)
  };
}

function dbHeaders(secret) {
  return {
    apikey: secret,
    Accept: "application/json"
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function getUser(event, url, publishableKey) {
  const authorization =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    "";

  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) return null;

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`
    }
  });

  const user = await readJson(response);

  return response.ok && user?.id ? user : null;
}

exports.handler = async function (event) {
  const supabaseUrl =
    (process.env.SUPABASE_URL || "").replace(/\/+$/, "");

  const supabaseSecret =
    process.env.SUPABASE_SECRET_KEY || "";

  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY || "";

  if (event.httpMethod && event.httpMethod !== "GET") {
    return json(405, {
      success: false,
      error: "Méthode non autorisée. Utilise GET."
    });
  }

  if (!supabaseUrl || !supabaseSecret || !publishableKey) {
    return json(500, {
      success: false,
      error: "Configuration Supabase incomplète côté serveur."
    });
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
      return false;
    }

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
    const user = await getUser(
      event,
      supabaseUrl,
      publishableKey
    );

    let isVip = false;

    if (user) {
      const now = new Date().toISOString();

      const membershipUrl = new URL(
        `${supabaseUrl}/rest/v1/vip_subscriptions`
      );

      membershipUrl.search = new URLSearchParams({
        select: "id,plan_code,starts_at,expires_at,source",
        user_id: `eq.${user.id}`,
        status: "eq.active",
        starts_at: `lte.${now}`,
        expires_at: `gt.${now}`,
        order: "expires_at.desc",
        limit: "1"
      }).toString();

      const membershipResponse = await fetch(
        membershipUrl.toString(),
        {
          headers: dbHeaders(supabaseSecret)
        }
      );

      if (!membershipResponse.ok) {
        console.error(
          "Vérification VIP impossible :",
          await membershipResponse.text()
        );

        return json(502, {
          success: false,
          error: "Impossible de vérifier le statut VIP."
        });
      }

      const memberships = await readJson(membershipResponse);

      isVip =
        Array.isArray(memberships) &&
        memberships.length > 0;
    }

    const params = new URLSearchParams({
      select: "id,match_id,prediction,confidence,probability_home,probability_draw,probability_away,analysis,model_version,status,published,is_premium,created_at,result,settled_at,matches!predictions_match_id_fkey!inner(home_team,away_team,league,country,match_date,home_score,away_score,status,provider)",
      published: "eq.true",
      status: "eq.published",
      "matches.provider": "eq.highlightly",
      order: "created_at.desc",
      limit: "100"
    });

    const history =
      event.queryStringParameters?.history === "1";

    if (!history) {
      const requestedDate =
        event.queryStringParameters?.date;

      const date = validDate(requestedDate)
        ? requestedDate
        : abidjanDate();

      const start = `${date}T00:00:00Z`;

      const end = new Date(
        new Date(start).getTime() + 86400000
      ).toISOString();

      params.append(
        "matches.match_date",
        `gte.${start}`
      );

      params.append(
        "matches.match_date",
        `lt.${end}`
      );
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/predictions?${params.toString()}`,
      {
        headers: dbHeaders(supabaseSecret)
      }
    );

    if (!response.ok) {
      console.error(
        "Lecture Supabase des pronostics :",
        await response.text()
      );

      return json(502, {
        success: false,
        error: "Impossible de lire les pronostics publiés."
      });
    }

    const rows = await readJson(response);

    const predictions = (
      Array.isArray(rows) ? rows : []
    ).map(row => {
      const match = Array.isArray(row.matches)
        ? row.matches[0]
        : row.matches;

      const clean = {
        ...row,
        match
      };

      delete clean.matches;

      const premium = row.is_premium !== false;

      if (premium && !isVip) {
        clean.prediction = null;
        clean.confidence = null;
        clean.probability_home = null;
        clean.probability_draw = null;
        clean.probability_away = null;
        clean.analysis = null;
        clean.locked = true;
      } else {
        clean.locked = false;
      }

      return clean;
    });

    return json(200, {
      success: true,
      history,
      isVip,
      authenticated: Boolean(user),
      count: predictions.length,
      predictions
    });

  } catch (error) {
    console.error(
      "Erreur published-predictions :",
      error.message
    );

    return json(500, {
      success: false,
      error: "Erreur pendant le chargement des pronostics."
    });
  }
};
