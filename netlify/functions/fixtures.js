exports.handler = async function (event) {
const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const jsonResponse = (statusCode, body, cache = false) => ({
statusCode,
headers: {
"Content-Type": "application/json; charset=utf-8",
"Cache-Control": cache
? "public, max-age=60, s-maxage=300"
: "no-store",
"Netlify-CDN-Cache-Control": cache
? "public, s-maxage=300"
: "no-store"
},
body: JSON.stringify(body)
});

if (event.httpMethod && event.httpMethod !== "GET") {
return jsonResponse(405, {
success: false,
error: "Méthode non autorisée"
});
}

if (!API_KEY) {
return jsonResponse(500, {
success: false,
error: "Clé API-Football non configurée"
});
}

try {
// Date locale de Côte d'Ivoire
function getLocalDate() {
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

  const date = new Date(`${value}T00:00:00Z`);  

  return !Number.isNaN(date.getTime()) &&  
    date.toISOString().slice(0, 10) === value;  
}  

const requestedDate = event.queryStringParameters?.date;  
const date = isValidDate(requestedDate)  
  ? requestedDate  
  : getLocalDate();  

// Normalisation des noms  
function normalize(value) {  
  return String(value || "")  
    .normalize("NFD")  
    .replace(/[\u0300-\u036f]/g, "")  
    .toLowerCase()  
    .replace(/[^a-z0-9 ]/g, " ")  
    .replace(/\s+/g, " ")  
    .trim();  
}  

// Championnats autorisés  
// Format : pays|nom du championnat  
const allowedLeagues = new Set([  

  // EUROPE  
  "england|premier league",  
  "spain|la liga",  
  "italy|serie a",  
  "germany|bundesliga",  
  "france|ligue 1",  
  "netherlands|eredivisie",  
  "portugal|liga portugal",  
  "portugal|primeira liga",  
  "belgium|jupiler pro league",  
  "belgium|pro league",  
  "turkey|super lig",  
  "scotland|premiership",  
  "greece|super league 1",  
  "austria|bundesliga",  
  "switzerland|super league",  
  "denmark|superliga",  
  "norway|eliteserien",  
  "sweden|allsvenskan",  
  "poland|ekstraklasa",  
  "czech republic|czech liga",  
  "croatia|hnl",  
  "serbia|super liga",  

  // AMERIQUE  
  "usa|major league soccer",  
  "united states|major league soccer",  
  "brazil|serie a",  
  "argentina|liga profesional argentina",  
  "argentina|primera division",  
  "mexico|liga mx",  
  "colombia|primera a",  
  "chile|primera division",  
  "uruguay|primera division",  
  "ecuador|liga pro",  
  "peru|liga 1",  
  "paraguay|primera division",  

  // ASIE ET OCEANIE  
  "japan|j1 league",  
  "south korea|k league 1",  
  "australia|a league",  
  "saudi arabia|pro league",  
  "united arab emirates|uae pro league",  
  "qatar|stars league",  
  "india|indian super league",  

  // AFRIQUE  
  "cote d ivoire|ligue 1",  
  "ivory coast|ligue 1",  
  "burkina faso|ligue 1",  
  "senegal|ligue 1",  
  "cameroon|elite one",  
  "algeria|ligue 1",  
  "tunisia|ligue 1",  
  "dr congo|ligue 1",  
  "democratic republic of the congo|ligue 1",  
  "morocco|botola pro",  
  "egypt|premier league",  
  "south africa|premier soccer league",  
  "ghana|premier league",  
  "nigeria|npfl",  
  "nigeria|nigeria premier football league",  
  "kenya|fkf premier league",  
  "uganda|premier league",  
  "mali|premiere division",  
  "tanzania|ligi kuu bara",  
  "zambia|super league",  
  "angola|girabola",  
  "rwanda|premier league",  
  "ethiopia|premier league",  
  "zimbabwe|premier soccer league"  
]);  

// Grandes compétitions internationales  
const internationalLeagues = new Set([  
  "uefa champions league",  
  "uefa europa league",  
  "uefa conference league",  
  "caf champions league",  
  "caf confederation cup",  
  "africa cup of nations",  
  "fifa world cup",  
  "world cup",  
  "fifa club world cup"  
]);  

// Exclusions  
const excludedPattern =  
  /\b(women|woman|frauen|feminine|feminin|ladies|girls|youth|junior|academy|reserve|reserves|u\s?17|u\s?18|u\s?19|u\s?20|u\s?21|u\s?23)\b/;  

function isExcludedTeam(name) {  
  return /(?:^|\s)(?:ii|iii|iv|b|w|u\s?(?:17|18|19|20|21|23))$/.test(name);  
}  

// Récupération API-Football  
const apiResponse = await fetch(  
  `https://v3.football.api-sports.io/fixtures?date=${date}`,  
  {  
    headers: {  
      "x-apisports-key": API_KEY  
    }  
  }  
);  

const data = await apiResponse.json();  

const hasErrors = data.errors &&  
  Object.keys(data.errors).length > 0;  

if (!apiResponse.ok || hasErrors) {  
  return jsonResponse(200, {  
    success: false,  
    requested_date: date,  
    errors: data.errors || {},  
    message: "L'API-Football n'a pas fourni les données demandées.",  
    total_matches_received: 0,  
    results: 0,  
    response: []  
  });  
}  

const rawMatches = Array.isArray(data.response)  
  ? data.response  
  : [];  
// DIAGNOSTIC : liste de toutes les compétitions reçues

const competitionMap = new Map();

rawMatches.forEach(match => {
const league = match?.league;

if (!league?.name) return;

const country = league.country || "International";

const key = ${league.id || ""}|${normalize(country)}|${normalize(league.name)};

const competition = competitionMap.get(key) || {
league_id: league.id || null,
league: league.name,
country: country,
fixtures: 0
};

competition.fixtures += 1;
competitionMap.set(key, competition);
});

const availableCompetitions = Array.from(competitionMap.values())
.sort((a, b) =>
a.country.localeCompare(b.country) ||
a.league.localeCompare(b.league)
);

// Filtrage des compétitions  
const filteredMatches = rawMatches.filter(match => {  
  if (!match.fixture || !match.league || !match.teams) {  
    return false;  
  }  

  const leagueName = normalize(match.league.name);  
  const country = normalize(match.league.country);  

  const home = normalize(match.teams.home?.name);  
  const away = normalize(match.teams.away?.name);  

  const fullText = `${leagueName} ${home} ${away}`;  

  if (excludedPattern.test(fullText)) {  
    return false;  
  }  

  if (isExcludedTeam(home) || isExcludedTeam(away)) {  
    return false;  
  }  

  const leagueKey = `${country}|${leagueName}`;  

  const allowed =  
    allowedLeagues.has(leagueKey) ||  
    internationalLeagues.has(leagueName);  

  if (!allowed) {  
    return false;  
  }  

  // On exclut les rencontres annulées ou définitivement abandonnées.  
  // Les matchs en cours et terminés restent visibles.  
  const status = match.fixture.status?.short || "";  

  if (["PST", "CANC", "ABD", "AWD", "WO"].includes(status)) {  
    return false;  
  }  

  return true;  
});  

// Format commun pour le site  
const matches = filteredMatches.map(match => ({  
  id: match.fixture.id,  

  home_team: match.teams.home?.name || "Équipe inconnue",  
  away_team: match.teams.away?.name || "Équipe inconnue",  

  home_logo: match.teams.home?.logo || "",  
  away_logo: match.teams.away?.logo || "",  

  league: match.league.name || "Championnat",  
  league_id: match.league.id || null,  
  league_logo: match.league.logo || "",  

  country: match.league.country || "Autres pays",  

  match_date: match.fixture.date,  
  status: match.fixture.status?.short || "NS",  
  status_long: match.fixture.status?.long || "Non commencé",  
  elapsed: match.fixture.status?.elapsed ?? null,  

  home_score: match.goals?.home ?? null,  
  away_score: match.goals?.away ?? null  
}));  

// Synchronisation Supabase  
let databaseSync = {  
  success: false,  
  saved_matches: 0,  
  message: "Synchronisation non effectuée"  
};  

if (SUPABASE_URL && SUPABASE_KEY && matches.length > 0) {  
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

    for (let i = 0; i < databaseRows.length; i += 100) {  
      const batch = databaseRows.slice(i, i + 100);  

      const dbResponse = await fetch(  
        `${cleanUrl}/rest/v1/matches?on_conflict=id`,  
        {  
          method: "POST",  
          headers: {  
            "apikey": SUPABASE_KEY,  
            "Authorization": `Bearer ${SUPABASE_KEY}`,  
            "Content-Type": "application/json",  
            "Prefer": "resolution=merge-duplicates,return=minimal"  
          },  
          body: JSON.stringify(batch)  
        }  
      );  

      if (!dbResponse.ok) {  
        throw new Error(await dbResponse.text());  
      }  
    }  

    databaseSync = {  
      success: true,  
      saved_matches: databaseRows.length,  
      message: "Synchronisation réussie"  
    };  

  } catch (dbError) {  
    console.error("Erreur Supabase :", dbError.message);  

    databaseSync = {  
      success: false,  
      saved_matches: 0,  
      message: "Les matchs sont récupérés, mais Supabase n'a pas pu être actualisé."  
    };  
  }  
} else if (matches.length === 0) {  
  databaseSync = {  
    success: true,  
    saved_matches: 0,  
    message: "Aucun match sélectionné à enregistrer"  
  };  
}  

return jsonResponse(200, {

success: true,
requested_date: date,
get: data.get,
parameters: data.parameters,

total_matches_received: rawMatches.length,
results: matches.length,

available_competitions: availableCompetitions,

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
