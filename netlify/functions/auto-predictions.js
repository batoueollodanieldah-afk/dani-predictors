const API_BASE = "https://v3.football.api-sports.io";
const MAX_PREDICTIONS_PER_RUN = 5;
const MIN_DAILY_REMAINING = 20;
const RETRY_DELAY_HOURS = 6;
const MIN_KICKOFF_MINUTES = 90;
const MIN_PROBABILITY = 65;
const MIN_MARGIN = 10;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function abidjanDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

function parsePercent(value) {
  const number = Number.parseFloat(String(value ?? "").replace("%", "").replace(",", "."));
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function getSupabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function callFixturesFunction(siteUrl, date) {
  const url = `${siteUrl.replace(/\/+$/, "")}/.netlify/functions/fixtures?date=${encodeURIComponent(date)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  const data = await response.json();
  if (!response.ok || data.success !== true) {
    throw new Error(data.message || data.error || `Fonction fixtures HTTP ${response.status}`);
  }
  return data;
}

async function getApiUsage(apiKey) {
  try {
    const response = await fetch(`${API_BASE}/status`, {
      method: "GET",
      headers: { "x-apisports-key": apiKey }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const requests = data?.response?.requests;
    if (!requests) return null;
    const limit = Number(requests.limit_day);
    const current = Number(requests.current);
    if (!Number.isFinite(limit) || !Number.isFinite(current)) return null;
    return { limit, current, remaining: Math.max(0, limit - current) };
  } catch (error) {
    console.warn("Impossible de lire le quota API-Football :", error.message);
    return null;
  }
}

function diversifyFixtures(fixtures) {
  const groups = new Map();
  fixtures.forEach(match => {
    const key = `${match.country || "?"}|${match.league_id || match.league || "?"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  });
  for (const group of groups.values()) {
    group.sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  }
  const selected = [];
  const queues = [...groups.values()];
  while (queues.some(queue => queue.length)) {
    for (const queue of queues) {
      if (queue.length) selected.push(queue.shift());
    }
  }
  return selected;
}

async function getExistingMatchRows(supabaseUrl, supabaseKey, matchIds) {
  if (!matchIds.length) return new Map();
  const query = `select=match_id,published,status,attempt_count,last_attempt_at&match_id=in.(${matchIds.join(",")})`;
  const response = await fetch(`${supabaseUrl}/rest/v1/predictions?${query}`, {
    headers: getSupabaseHeaders(supabaseKey)
  });
  if (!response.ok) {
    throw new Error(`Lecture des pronostics existants impossible : ${await response.text()}`);
  }
  const rows = await response.json();
  return new Map((rows || []).map(row => [String(row.match_id), row]));
}

function makePredictionRow(match, apiItem) {
  const prediction = apiItem?.predictions;
  const percent = prediction?.percent || {};
  const values = {
    home: parsePercent(percent.home),
    draw: parsePercent(percent.draw),
    away: parsePercent(percent.away)
  };

  if (Object.values(values).some(value => value === null)) {
    return {
      match_id: match.id,
      prediction: "Non publié — données de probabilité insuffisantes",
      confidence: null,
      analysis: "API-Football n'a pas fourni les trois probabilités nécessaires pour contrôler cette rencontre. Aucune sélection n'est publiée.",
      status: "insufficient_data",
      published: false
    };
  }

  const total = values.home + values.draw + values.away;
  const ranked = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const [bestKey, bestValue] = ranked[0];
  const secondValue = ranked[1][1];
  const margin = bestValue - secondValue;
  const percentageText = `Domicile ${values.home.toFixed(1)} %, nul ${values.draw.toFixed(1)} %, extérieur ${values.away.toFixed(1)} %.`;

  if (total < 85 || total > 115) {
    return {
      match_id: match.id,
      prediction: "Non publié — probabilités incohérentes",
      confidence: null,
      analysis: `Les pourcentages reçus ne passent pas le contrôle de cohérence (total ${total.toFixed(1)} %). ${percentageText} Aucune sélection n'est publiée.`,
      status: "insufficient_data",
      published: false
    };
  }

  if (bestValue < MIN_PROBABILITY || margin < MIN_MARGIN) {
    return {
      match_id: match.id,
      prediction: "Non publié — seuil automatique non atteint",
      confidence: Number(bestValue.toFixed(2)),
      analysis: `${percentageText} La meilleure probabilité est ${bestValue.toFixed(1)} % et son avance est ${margin.toFixed(1)} point(s). Le seuil exigé est ${MIN_PROBABILITY} % avec ${MIN_MARGIN} points d'écart. Sélection écartée automatiquement.`,
      status: "filtered",
      published: false
    };
  }

  let pick;
  if (bestKey === "home") pick = `Victoire de ${match.home_team}`;
  else if (bestKey === "away") pick = `Victoire de ${match.away_team}`;
  else pick = "Match nul";

  return {
    match_id: match.id,
    prediction: pick,
    confidence: Number(bestValue.toFixed(2)),
    analysis: `Prévision issue de l'endpoint Predictions d'API-Football. ${percentageText} La meilleure issue atteint ${bestValue.toFixed(1)} % et dépasse la deuxième de ${margin.toFixed(1)} points. Publication automatique après contrôle. Il s'agit d'une estimation, pas d'une garantie.`,
    status: "published",
    published: true
  };
}

async function requestFixturePrediction(apiKey, fixtureId) {
  const response = await fetch(`${API_BASE}/predictions?fixture=${encodeURIComponent(fixtureId)}`, {
    method: "GET",
    headers: { "x-apisports-key": apiKey }
  });

  if (response.status === 429) {
    return { retryable: true, error: "Limite de requêtes par minute atteinte." };
  }

  let data = {};
  try { data = await response.json(); } catch (error) {}

  if (!response.ok) {
    return { retryable: true, error: `API-Football HTTP ${response.status}` };
  }

  if (data?.errors && Object.keys(data.errors).length) {
    const errorText = JSON.stringify(data.errors);
    if (/rate.?limit|quota|too many/i.test(errorText)) {
      return { retryable: true, error: errorText };
    }
    return { row: null, error: errorText };
  }

  const item = Array.isArray(data?.response) ? data.response[0] : null;
  return { row: item || null };
}

async function settlePreviousDay(siteUrl, supabaseUrl, supabaseKey, date) {
  try {
    await callFixturesFunction(siteUrl, date);
  } catch (error) {
    console.warn(`Actualisation des scores du ${date} impossible :`, error.message);
  }

  const start = `${date}T00:00:00Z`;
  const end = `${shiftDate(date, 1)}T00:00:00Z`;
  const params = new URLSearchParams({
    select: "id,match_id,prediction,result,matches!predictions_match_id_fkey!inner(home_team,away_team,home_score,away_score,status,match_date)",
    published: "eq.true",
    status: "eq.published",
    result: "is.null",
    "matches.match_date": `gte.${start}`,
    order: "created_at.asc",
    limit: "100"
  });
  params.append("matches.match_date", `lt.${end}`);

  const response = await fetch(`${supabaseUrl}/rest/v1/predictions?${params.toString()}`, {
    headers: getSupabaseHeaders(supabaseKey)
  });
  if (!response.ok) {
    console.warn("Lecture des pronostics à régler impossible :", await response.text());
    return { settled: 0 };
  }

  const rows = await response.json();
  const updates = { won: [], lost: [], void: [] };

  for (const row of rows || []) {
    const match = Array.isArray(row.matches) ? row.matches[0] : row.matches;
    if (!match) continue;
    const status = String(match.status || "").toUpperCase();

    if (["PST", "CANC", "ABD", "AWD", "WO"].includes(status)) {
      updates.void.push(row.id);
      continue;
    }
    if (!["FT", "AET", "PEN"].includes(status)) continue;

    const homeScore = Number(match.home_score);
    const awayScore = Number(match.away_score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

    const pick = String(row.prediction || "");
    let won = null;

    if (normalize(pick) === "match nul") {
      won = homeScore === awayScore;
    } else if (pick.startsWith("Victoire de ")) {
      const team = normalize(pick.slice("Victoire de ".length));
      if (team === normalize(match.home_team)) won = homeScore > awayScore;
      else if (team === normalize(match.away_team)) won = awayScore > homeScore;
    }

    if (won === true) updates.won.push(row.id);
    else if (won === false) updates.lost.push(row.id);
  }

  let settled = 0;
  for (const [result, ids] of Object.entries(updates)) {
    if (!ids.length) continue;
    const idList = ids.join(",");
    const patch = await fetch(`${supabaseUrl}/rest/v1/predictions?id=in.(${idList})&result=is.null`, {
      method: "PATCH",
      headers: getSupabaseHeaders(supabaseKey, { Prefer: "return=minimal" }),
      body: JSON.stringify({ result, settled_at: new Date().toISOString() })
    });
    if (patch.ok) settled += ids.length;
    else console.warn(`Mise à jour des résultats (${result}) impossible :`, await patch.text());
  }

  console.log(`Résultats du ${date} réglés : ${settled}`);
  return { settled };
}

exports.handler = async function () {
  const apiKey = process.env.API_FOOTBALL_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "https://jocular-valkyrie-193e08.netlify.app";

  if (!apiKey || !supabaseUrl || !supabaseKey) {
    console.error("Variables API_FOOTBALL_KEY, SUPABASE_URL ou SUPABASE_SECRET_KEY manquantes.");
    return { statusCode: 500, body: "Configuration serveur incomplète." };
  }

  try {
    const today = abidjanDate();
    const hourUtc = new Date().getUTCHours();
    let settlement = { settled: 0 };

    if (hourUtc === 5) {
      const yesterday = shiftDate(today, -1);
      settlement = await settlePreviousDay(siteUrl, supabaseUrl, supabaseKey, yesterday);
    }

    const usage = await getApiUsage(apiKey);
    if (usage && usage.remaining < MIN_DAILY_REMAINING) {
      console.log(`Génération suspendue : ${usage.remaining} requêtes API-Football restantes.`);
      return { statusCode: 200, body: JSON.stringify({ success: true, generated: 0, reason: "quota réservé", settlement }) };
    }

    const fixturesData = await callFixturesFunction(siteUrl, today);
    const now = Date.now();
    const minKickoff = now + MIN_KICKOFF_MINUTES * 60 * 1000;

    const candidates = (fixturesData.response || [])
      .filter(match =>
        match &&
        Number.isFinite(Number(match.id)) &&
        String(match.status || "").toUpperCase() === "NS" &&
        Date.parse(match.match_date) > minKickoff
      )
      .sort((a, b) => new Date(a.match_date) - new Date(b.match_date));

    const diversified = diversifyFixtures(candidates).slice(0, 200);
    const existingRows = await getExistingMatchRows(
      supabaseUrl,
      supabaseKey,
      diversified.map(match => Number(match.id))
    );
    const retryDelayMs = RETRY_DELAY_HOURS * 60 * 60 * 1000;

    const neverAttempted = diversified.filter(match =>
      !existingRows.has(String(match.id))
    );
    const eligibleRetries = diversified.filter(match => {
      const previous = existingRows.get(String(match.id));
      if (!previous || previous.published === true || previous.status === "published") return false;
      const lastAttempt = Date.parse(previous.last_attempt_at || "");
      return !Number.isFinite(lastAttempt) || (now - lastAttempt) >= retryDelayMs;
    });

    const toProcess = [...neverAttempted, ...eligibleRetries]
      .slice(0, MAX_PREDICTIONS_PER_RUN);

    if (!toProcess.length) {
      console.log("Aucun nouveau match admissible à analyser.");
      return { statusCode: 200, body: JSON.stringify({ success: true, generated: 0, settlement }) };
    }

    const rowsToSave = [];
    let apiCalls = 0;
    for (const match of toProcess) {
      if (apiCalls > 0) await wait(1100);
      const result = await requestFixturePrediction(apiKey, match.id);
      apiCalls += 1;

      if (result.retryable) {
        console.warn(`Analyse interrompue pour le match ${match.id} : ${result.error}`);
        break;
      }

      const previous = existingRows.get(String(match.id));
      const attemptFields = {
        attempt_count: Number(previous?.attempt_count || 0) + 1,
        last_attempt_at: new Date().toISOString()
      };

      if (!result.row) {
        rowsToSave.push({
          match_id: match.id,
          prediction: "Non publié — prévision indisponible",
          confidence: null,
          analysis: `Aucune prévision exploitable n'a été retournée par API-Football pour cette rencontre. ${result.error || ""}`.trim(),
          status: "insufficient_data",
          published: false,
          ...attemptFields
        });
      } else {
        rowsToSave.push({ ...makePredictionRow(match, result.row), ...attemptFields });
      }
    }

    if (rowsToSave.length) {
      const insert = await fetch(`${supabaseUrl}/rest/v1/predictions?on_conflict=match_id`, {
        method: "POST",
        headers: getSupabaseHeaders(supabaseKey, { Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(rowsToSave)
      });
      if (!insert.ok) {
        throw new Error(`Enregistrement Supabase impossible : ${await insert.text()}`);
      }
    }

    const published = rowsToSave.filter(row => row.published).length;
    console.log(`Analyse terminée : ${rowsToSave.length} matchs examinés, ${published} pronostics publiés, ${settlement.settled} résultats réglés.`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        requested_date: today,
        examined: rowsToSave.length,
        published,
        filtered_or_unavailable: rowsToSave.length - published,
        settlement
      })
    };
  } catch (error) {
    console.error("Erreur du moteur automatique :", error.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  }
};
