exports.handler = async function (event) {
  const API_KEY = process.env.API_FOOTBALL_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Clé API non configurée" })
    };
  }

  try {
    const requestedDate = event.queryStringParameters?.date;
const today = new Date().toISOString().slice(0, 10);

const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '')
  ? requestedDate
  : today;
    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${date}`,
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erreur de connexion à API-Football" })
    };
  }
};
