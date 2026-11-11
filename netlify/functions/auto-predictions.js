const HIGHLIGHTLY_BASE = "https://soccer.highlightly.net";
const MAX_CANDIDATES_PER_RUN = 8;
const RETRY_DELAY_HOURS = 6;
const MIN_KICKOFF_MINUTES = 90;
const MIN_RECENT_GAMES = 4;
const MIN_CANDIDATE_PROBABILITY = 60;
const MIN_CANDIDATE_MARGIN = 10;
const MODEL_VERSION = "DANI-FORM-POISSON-1.0";

function abidjanDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = {};
  parts.forEach(part => {
    values[part.type] = part.value;
  });

  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function supabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    "Content-Type": "application/json",
    ...extra
  };
}

async function callFixturesFunction(siteUrl, date) {
  const url = `${siteUrl.replace(/\/+$/, "")}/.netlify/functions/fixtures?date=${encodeURIComponent(date)}`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  const data = await response.json();

  if (!response.ok || data.success !== true) {
    throw new Error(
      data.message ||
      data.error ||
      `Fonction fixtures HTTP ${response.status}`
    );
  }

  return data;
}

function parseScore(value) {
  if (typeof value === "string") {
    const match = value.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
    if (match) return { home: Number(match[1]), away: Number(match[2]) };
  }

  if (value && typeof value === "object") {
    const home = Number(value.home ?? value.homeScore ?? value.home_score);
    const away = Number(value.away ?? value.awayScore ?? value.away_score);
    if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  }

  return null;
}

function isFinishedGame(game) {
  const rawStatus = String(
    game?.state?.description ||
    game?.state?.shortName ||
    game?.status?.short ||
    game?.status ||
    ""
  ).trim().toLowerCase();

  if (!rawStatus) return true;

  return [
    "ft", "aet", "pen", "finished", "finished after extra time",
    "finished after penalties", "full time"
  ].includes(rawStatus);
}

function summarizeRecentForm(games, teamId) {
  const summary = {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    form: []
  };

  if (!Array.isArray(games)) return summary;

  for (const game of games.slice(0, 10)) {
    if (!isFinishedGame(game)) continue;

    const scoreValue =
      game?.state?.score?.current ??
      game?.score?.current ??
      game?.score ??
      game?.result ??
      null;

    const score = parseScore(scoreValue);
    const homeId = Number(game?.homeTeam?.id ?? game?.home_team?.id ?? game?.homeTeamId);
    const awayId = Number(game?.awayTeam?.id ?? game?.away_team?.id ?? game?.awayTeamId);
    const id = Number(teamId);

    if (!score || (homeId !== id && awayId !== id)) continue;

    const isHome = homeId === id;
    const scored = isHome ? score.home : score.away;
    const conceded = isHome ? score.away : score.home;

    summary.played += 1;
    summary.goalsFor += scored;
    summary.goalsAgainst += conceded;

    if (scored > conceded) {
      summary.wins += 1;
      summary.form.push("V");
    } else if (scored === conceded) {
      summary.draws += 1;
      summary.form.push("N");
    } else {
      summary.losses += 1;
      summary.form.push("D");
    }

    if (summary.played >= 5) break;
  }

  if (summary.played) {
    summary.avgGoalsFor = summary.goalsFor / summary.played;
    summary.avgGoalsAgainst = summary.goalsAgainst / summary.played;
    summary.pointsPerGame =
      (summary.wins * 3 + summary.draws) / summary.played;
  }

  return summary;
}

function poisson(lambda, goals) {
  let factorial = 1;

  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function calculateProbabilities(homeForm, awayForm) {
  const priorGames = 5;
  const priorGoals = 1.30;

  const adjusted = form => ({
    scored:
      (form.goalsFor + priorGoals * priorGames) /
      (form.played + priorGames),

    conceded:
      (form.goalsAgainst + priorGoals * priorGames) /
      (form.played + priorGames)
  });

  const adjustedHome = adjusted(homeForm);
  const adjustedAway = adjusted(awayForm);

  const homeExpected = Math.max(
    0.25,
    Math.min(
      3.5,
      ((adjustedHome.scored + adjustedAway.conceded) / 2) * 1.05
    )
  );

  const awayExpected = Math.max(
    0.20,
    Math.min(
      3.2,
      ((adjustedAway.scored + adjustedHome.conceded) / 2) * 0.95
    )
  );

  let home = 0;
  let draw = 0;
  let away = 0;

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const probability =
        poisson(homeExpected, h) * poisson(awayExpected, a);

      if (h > a) home += probability;
      else if (h === a) draw += probability;
      else away += probability;
    }
  }

  const total = home + draw + away;

  return {
    home: home / total * 100,
    draw: draw / total * 100,
    away: away / total * 100,
    homeExpected,
    awayExpected
  };
}

function getPredictionText(match, key) {
  if (key === "home") {
    return `Victoire de ${match.home_team}`;
  }

  if (key === "away") {
    return `Victoire de ${match.away_team}`;
  }

  return "Match nul";
}

function buildCandidate(match, homeForm, awayForm) {
  const probabilities = calculateProbabilities(homeForm, awayForm);

  const ranked = [
    ["home", probabilities.home],
    ["draw", probabilities.draw],
    ["away", probabilities.away]
  ].sort((a, b) => b[1] - a[1]);

  const best = ranked[0];
  const margin = best[1] - ranked[1][1];

  const percentage = value => `${value.toFixed(1)} %`;
  const formText = form => form.form.join("-") || "indisponible";

  const analysis = [
    `Modèle statistique interne ${MODEL_VERSION}, fondé sur les ${homeForm.played} derniers matchs terminés de ${match.home_team} et les ${awayForm.played} derniers de ${match.away_team}.`,

    `Forme récente : ${match.home_team} ${formText(homeForm)} (${homeForm.wins}V ${homeForm.draws}N ${homeForm.losses}D) ; ${match.away_team} ${formText(awayForm)} (${awayForm.wins}V ${awayForm.draws}N ${awayForm.losses}D).`,

    `Buts moyens : ${match.home_team} ${homeForm.avgGoalsFor.toFixed(2)} marqués / ${homeForm.avgGoalsAgainst.toFixed(2)} encaissés ; ${match.away_team} ${awayForm.avgGoalsFor.toFixed(2)} marqués / ${awayForm.avgGoalsAgainst.toFixed(2)} encaissés.`,

    `Estimation interne 1X2 : domicile ${percentage(probabilities.home)}, nul ${percentage(probabilities.draw)}, extérieur ${percentage(probabilities.away)}. Buts attendus du modèle : ${probabilities.homeExpected.toFixed(2)} – ${probabilities.awayExpected.toFixed(2)}.`,

    `La sélection proposée est ${getPredictionText(match, best[0])} (${percentage(best[1])}), avec ${percentage(margin)} d'avance sur la deuxième issue. Cette estimation est indicative, issue d'un échantillon court et ne garantit aucun résultat. Elle est publiée automatiquement uniquement si les seuils de qualité du modèle sont atteints.`
  ].join(" ");

  const qualifies =
    best[1] >= MIN_CANDIDATE_PROBABILITY &&
    margin >= MIN_CANDIDATE_MARGIN;

  return {
    match_id: match.id,
    prediction: getPredictionText(match, best[0]),
    confidence: Number(best[1].toFixed(2)),
    probability_home: Number(probabilities.home.toFixed(2)),
    probability_draw: Number(probabilities.draw.toFixed(2)),
    probability_away: Number(probabilities.away.toFixed(2)),
    analysis,
    model_version: MODEL_VERSION,
    status: qualifies ? "published" : "filtered",
    published: qualifies,
    is_premium: true
  };
}

async function fetchLastFive(apiKey, teamId) {
  const url = new URL(`${HIGHLIGHTLY_BASE}/last-five-games`);

  url.searchParams.set("teamId", String(teamId));

  const response = await fetch(url.toString(), {
    headers: {
      "x-rapidapi-key": apiKey,
      Accept: "application/json"
    }
  });

  let data;

  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `Highlightly HTTP ${response.status}`;

    const retryable =
      response.status === 429 ||
      response.status >= 500;

    return {
      retryable,
      error: message,
      games: []
    };
  }

  const games =
    Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.response) ? data.response :
    Array.isArray(data?.results) ? data.results :
    Array.isArray(data?.games) ? data.games :
    Array.isArray(data?.data?.games) ? data.data.games :
    [];

  return {
    retryable: false,
    games
  };
}

async function getExistingRows(supabaseUrl, supabaseKey, matchIds) {
  if (!matchIds.length) return new Map();

  const query = new URLSearchParams({
    select: "match_id,status,published,attempt_count,last_attempt_at",
    match_id: `in.(${matchIds.join(",")})`
  });

  const response = await fetch(
    `${supabaseUrl}/rest/v1/predictions?${query}`,
    {
      headers: supabaseHeaders(supabaseKey)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Lecture des analyses existantes impossible : ${await response.text()}`
    );
  }

  const rows = await response.json();

  return new Map(
    (rows || []).map(row => [String(row.match_id), row])
  );
}

async function saveRows(supabaseUrl, supabaseKey, rows) {
  if (!rows.length) return;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/predictions?on_conflict=match_id`,
    {
      method: "POST",
      headers: supabaseHeaders(supabaseKey, {
        Prefer: "resolution=merge-duplicates,return=minimal"
      }),
      body: JSON.stringify(rows)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Enregistrement Supabase impossible : ${await response.text()}`
    );
  }
}

async function settlePreviousDay(siteUrl, supabaseUrl, supabaseKey, date) {
  try {
    await callFixturesFunction(siteUrl, date);
  } catch (error) {
    console.warn(
      `Actualisation des scores du ${date} impossible :`,
      error.message
    );
  }

  const start = `${date}T00:00:00Z`;
  const end = `${shiftDate(date, 1)}T00:00:00Z`;

  const params = new URLSearchParams({
    select: "id,match_id,prediction,result,matches!predictions_match_id_fkey!inner(home_team,away_team,home_score,away_score,status,match_date,provider)",
    published: "eq.true",
    status: "eq.published",
    result: "is.null",
    "matches.match_date": `gte.${start}`,
    "matches.provider": "eq.highlightly",
    order: "created_at.asc",
    limit: "100"
  });

  params.append("matches.match_date", `lt.${end}`);

  const response = await fetch(
    `${supabaseUrl}/rest/v1/predictions?${params}`,
    {
      headers: supabaseHeaders(supabaseKey)
    }
  );

  if (!response.ok) {
    console.warn(
      "Lecture des pronostics à régler impossible :",
      await response.text()
    );

    return { settled: 0 };
  }

  const rows = await response.json();

  const updates = {
    won: [],
    lost: [],
    void: []
  };

  for (const row of rows || []) {
    const match = Array.isArray(row.matches)
      ? row.matches[0]
      : row.matches;

    if (!match) continue;

    const status = String(match.status || "").toUpperCase();

    if (["PST", "CANC", "ABD", "AWD", "WO"].includes(status)) {
      updates.void.push(row.id);
      continue;
    }

    if (!["FT", "AET", "PEN"].includes(status)) continue;

    if (
      match.home_score === null ||
      match.home_score === undefined ||
      match.away_score === null ||
      match.away_score === undefined
    ) continue;

    const homeScore = Number(match.home_score);
    const awayScore = Number(match.away_score);

    if (
      !Number.isFinite(homeScore) ||
      !Number.isFinite(awayScore)
    ) continue;

    const pick = String(row.prediction || "");

    let won = false;

    if (pick.startsWith("Victoire de ")) {
      const expected = pick.slice("Victoire de ".length);

      won =
        (homeScore > awayScore && expected === match.home_team) ||
        (awayScore > homeScore && expected === match.away_team);

    } else if (pick === "Match nul") {
      won = homeScore === awayScore;
    }

    updates[won ? "won" : "lost"].push(row.id);
  }

  let settled = 0;

  for (const [result, ids] of Object.entries(updates)) {
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);

      const patch = await fetch(
        `${supabaseUrl}/rest/v1/predictions?id=in.(${batch.join(",")})&result=is.null`,
        {
          method: "PATCH",
          headers: supabaseHeaders(supabaseKey, {
            Prefer: "return=minimal"
          }),
          body: JSON.stringify({
            result,
            settled_at: new Date().toISOString()
          })
        }
      );

      if (patch.ok) {
        settled += batch.length;
      } else {
        console.warn(
          `Mise à jour des résultats (${result}) impossible :`,
          await patch.text()
        );
      }
    }
  }

  return { settled };
}

exports.handler = async function () {
  const apiKey = process.env.HIGHLIGHTLY_API_KEY;

  const supabaseUrl =
    (process.env.SUPABASE_URL || "").replace(/\/+$/, "");

  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  const siteUrl =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    "https://jocular-valkyrie-193e08.netlify.app";

  if (!apiKey || !supabaseUrl || !supabaseKey) {
    console.error(
      "Variables HIGHLIGHTLY_API_KEY, SUPABASE_URL ou SUPABASE_SECRET_KEY manquantes."
    );

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: "Configuration serveur incomplète."
      })
    };
  }

  try {
    const today = abidjanDate();
    const now = Date.now();

    let settlement = { settled: 0 };

    if (new Date().getUTCHours() === 5) {
      settlement = await settlePreviousDay(
        siteUrl,
        supabaseUrl,
        supabaseKey,
        shiftDate(today, -1)
      );
    }

    const fixturesData = await callFixturesFunction(
      siteUrl,
      today
    );

    const candidates = (fixturesData.response || [])
      .filter(match =>
        match &&
        Number.isSafeInteger(Number(match.id)) &&
        Number.isSafeInteger(Number(match.home_team_id)) &&
        Number(match.home_team_id) > 0 &&
        Number.isSafeInteger(Number(match.away_team_id)) &&
        Number(match.away_team_id) > 0 &&
        match.provider === "highlightly" &&
        match.status === "NS" &&
        Date.parse(match.match_date) >
          now + MIN_KICKOFF_MINUTES * 60000
      )
      .sort(
        (a, b) =>
          new Date(a.match_date) - new Date(b.match_date)
      );

    const existingRows = await getExistingRows(
      supabaseUrl,
      supabaseKey,
      candidates.map(match => Number(match.id))
    );

    const retryAfterMs = RETRY_DELAY_HOURS * 3600000;

    const eligible = candidates
      .filter(match => {
        const previous = existingRows.get(String(match.id));

        if (!previous) return true;

        if (
          previous.published === true ||
          ["published", "pending_review", "rejected"].includes(previous.status)
        ) {
          return false;
        }

        const lastAttempt = Date.parse(
          previous.last_attempt_at || ""
        );

        return (
          !Number.isFinite(lastAttempt) ||
          now - lastAttempt >= retryAfterMs
        );
      })
      .slice(0, MAX_CANDIDATES_PER_RUN);

    if (!eligible.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          requested_date: today,
          examined: 0,
          published: 0,
          reason: "Aucun nouveau match admissible pour cette exécution.",
          settlement
        })
      };
    }

    const formCache = new Map();

    function getForm(teamId) {
      const key = String(teamId);

      if (!formCache.has(key)) {
        formCache.set(
          key,
          fetchLastFive(apiKey, teamId)
        );
      }

      return formCache.get(key);
    }

    const rowsToSave = [];

    for (const match of eligible) {
      const [homeResult, awayResult] = await Promise.all([
        getForm(match.home_team_id),
        getForm(match.away_team_id)
      ]);

      const previous = existingRows.get(String(match.id));

      const attemptFields = {
        attempt_count: Number(previous?.attempt_count || 0) + 1,
        last_attempt_at: new Date().toISOString()
      };

      if (homeResult.retryable || awayResult.retryable) {
        rowsToSave.push({
          match_id: match.id,
          prediction: "Analyse reportée — données temporairement indisponibles",
          confidence: null,
          analysis:
            `Highlightly n'a pas pu fournir la forme récente des deux équipes. ${homeResult.error || awayResult.error || "Réessaie ultérieurement."}`,
          model_version: MODEL_VERSION,
          status: "insufficient_data",
          published: false,
          is_premium: true,
          ...attemptFields
        });

        continue;
      }

      const homeForm = summarizeRecentForm(
        homeResult.games,
        match.home_team_id
      );

      const awayForm = summarizeRecentForm(
        awayResult.games,
        match.away_team_id
      );

      if (
        homeForm.played < MIN_RECENT_GAMES ||
        awayForm.played < MIN_RECENT_GAMES
      ) {
        rowsToSave.push({
          match_id: match.id,
          prediction: "Analyse non publiée — historique insuffisant",
          confidence: null,
          analysis:
            `Historique insuffisant pour établir une estimation raisonnable. Matchs terminés disponibles : ${match.home_team} ${homeForm.played}/5 ; ${match.away_team} ${awayForm.played}/5. Aucun pronostic n'est proposé.`,
          model_version: MODEL_VERSION,
          status: "insufficient_data",
          published: false,
          is_premium: true,
          ...attemptFields
        });

        continue;
      }

      rowsToSave.push({
        ...buildCandidate(match, homeForm, awayForm),
        ...attemptFields
      });
    }

    await saveRows(
      supabaseUrl,
      supabaseKey,
      rowsToSave
    );

    const published = rowsToSave.filter(
      row => row.status === "published" && row.published === true
    ).length;

    const filtered = rowsToSave.filter(
      row => row.status === "filtered"
    ).length;

    const insufficient = rowsToSave.filter(
      row => row.status === "insufficient_data"
    ).length;

    console.log(
      `DANI modèle ${MODEL_VERSION} : ${rowsToSave.length} analysés, ${published} publiés automatiquement, ${filtered} filtrés, ${insufficient} sans données suffisantes.`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        requested_date: today,
        provider: "Highlightly",
        model_version: MODEL_VERSION,
        examined: rowsToSave.length,
        published,
        filtered,
        insufficient_data: insufficient,
        settlement,
        note:
          "Publication automatique activée : seules les analyses atteignant les seuils minimums sont publiées."
      })
    };

  } catch (error) {
    console.error(
      "Erreur du moteur automatique DANI :",
      error.message
    );

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
