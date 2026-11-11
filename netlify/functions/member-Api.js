const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(body)
});

function headers(key, extra = {}) {
  // Avec les nouvelles clés sb_secret_*, utiliser apikey uniquement.
  return { apikey: key, "Content-Type": "application/json", ...extra };
}

async function readJson(response) {
  try { return await response.json(); } catch (_) { return null; }
}

async function authenticate(event, url, publishableKey) {
  const authorization = event.headers?.authorization || event.headers?.Authorization || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) return { error: "Connecte-toi pour continuer.", status: 401 };

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`
    }
  });

  const user = await readJson(response);
  if (!response.ok || !user?.id) {
    return { error: "Session expirée. Reconnecte-toi.", status: 401 };
  }
  return { user };
}

async function db(url, secret, path, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: headers(secret, options.headers || {})
  });
  const bodyText = await response.text();
  let data = null;
  try { data = bodyText ? JSON.parse(bodyText) : null; } catch (_) {}
  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || "Erreur de base de données.");
    error.status = response.status;
    throw error;
  }
  return data;
}

exports.handler = async function (event) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY || "";
  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY || "";

  if (!url || !secret || !publishable) {
    return json(500, { success: false, error: "Configuration Supabase incomplète côté serveur." });
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { success: false, error: "Méthode non autorisée." });
  }

  const auth = await authenticate(event, url, publishable);
  if (auth.error) return json(auth.status, { success: false, error: auth.error });
  const user = auth.user;

  try {
    if (event.httpMethod === "GET") {
      const now = new Date().toISOString();
      const subscriptions = await db(
        url, secret,
        `vip_subscriptions?select=id,plan_code,amount_xof,status,source,starts_at,expires_at,created_at&user_id=eq.${encodeURIComponent(user.id)}&status=eq.active&starts_at=lte.${encodeURIComponent(now)}&expires_at=gt.${encodeURIComponent(now)}&order=expires_at.desc&limit=1`
      );

      const payments = await db(
        url, secret,
        `payment_requests?select=id,plan_code,amount_xof,payment_method,payer_name,transaction_reference,status,created_at,admin_note&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=10`
      );

      const affiliates = await db(
        url, secret,
        `affiliate_applications?select=id,partner_code,partner_username,deposit_amount,proof_reference,status,created_at,admin_note&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=10`
      );

      const settingsRows = await db(
        url, secret,
        "app_settings?select=value&key=eq.payment_details&limit=1"
      );

      return json(200, {
        success: true,
        user: { id: user.id, email: user.email || "" },
        subscription: subscriptions?.[0] || null,
        paymentRequests: payments || [],
        affiliateApplications: affiliates || [],
        paymentDetails: settingsRows?.[0]?.value || {}
      });
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (_) {
      return json(400, { success: false, error: "Le formulaire contient des données invalides." });
    }

    if (body.action === "payment_request") {
      const plans = {
        vip_7: { amount: 3000, days: 7 },
        vip_30: { amount: 11000, days: 30 }
      };
      const plan = plans[body.plan_code];
      const method = String(body.payment_method || "").toLowerCase();
      const payerName = String(body.payer_name || "").trim().slice(0, 100);
      const reference = String(body.transaction_reference || "").trim().slice(0, 120);

      if (!plan) return json(400, { success: false, error: "Choisis une formule VIP valide." });
      if (!["wave", "orange_money"].includes(method)) {
        return json(400, { success: false, error: "Choisis Wave ou Orange Money." });
      }
      if (payerName.length < 2 || reference.length < 4) {
        return json(400, { success: false, error: "Renseigne le nom du payeur et la référence de transaction." });
      }

      const inserted = await db(
        url, secret,
        "payment_requests",
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([{
            user_id: user.id,
            plan_code: body.plan_code,
            amount_xof: plan.amount,
            payment_method: method,
            payer_name: payerName,
            transaction_reference: reference,
            status: "pending"
          }])
        }
      );

      return json(201, {
        success: true,
        message: "Demande reçue. Ton accès sera activé après vérification manuelle du paiement.",
        request: inserted?.[0] || null
      });
    }

    if (body.action === "affiliate_request") {
      const partnerCode = String(body.partner_code || "").trim().toUpperCase();
      const partnerUsername = String(body.partner_username || "").trim().slice(0, 100);
      const depositAmount = Number(body.deposit_amount);
      const proofReference = String(body.proof_reference || "").trim().slice(0, 120);

      if (partnerCode !== "NILO3") {
        return json(400, { success: false, error: "Le code partenaire doit être NILO3." });
      }
      if (partnerUsername.length < 2 || !Number.isFinite(depositAmount) || depositAmount < 3000 || proofReference.length < 4) {
        return json(400, { success: false, error: "Il faut renseigner ton identifiant partenaire, un premier dépôt d'au moins 3 000 FCFA et une référence justificative." });
      }

      const prior = await db(
        url, secret,
        `affiliate_applications?select=id,status&user_id=eq.${encodeURIComponent(user.id)}&status=eq.approved&limit=1`
      );
      if (prior?.length) {
        return json(409, { success: false, error: "Une récompense d'affiliation a déjà été accordée à ce compte." });
      }

      const inserted = await db(
        url, secret,
        "affiliate_applications",
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([{
            user_id: user.id,
            partner_code: "NILO3",
            partner_username: partnerUsername,
            deposit_amount: Math.floor(depositAmount),
            proof_reference: proofReference,
            status: "pending"
          }])
        }
      );

      return json(201, {
        success: true,
        message: "Demande envoyée. L'administrateur vérifiera ton inscription et ton dépôt dans son espace partenaire.",
        application: inserted?.[0] || null
      });
    }

    return json(400, { success: false, error: "Action inconnue." });
  } catch (error) {
    console.error("member-api:", error.message);
    return json(error.status || 500, {
      success: false,
      error: error.status === 409
        ? "Une demande similaire est déjà en attente."
        : (error.status && error.status < 500 ? error.message : "Impossible de traiter la demande pour le moment.")
    });
  }
};
