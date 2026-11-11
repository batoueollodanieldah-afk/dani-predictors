exports.handler = async function () {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || "";

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (!url || !key) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        success: false,
        error: "Configuration publique Supabase incomplète."
      })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      supabaseUrl: url,
      supabasePublishableKey: key
    })
  };
};
