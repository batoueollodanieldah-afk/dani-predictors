const crypto = require("crypto");

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(body)
});

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function dbHeaders(secret, extra = {}) {
  return { apikey: secret, "Content-Type": "application/json", ...extra };
}

async function db(url, secret, path, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: dbHeaders(secret, options.headers || {})
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || "Erreur Supabase.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function rpc(url, secret, name, body) {
  return db(url, secret, `rpc/${name}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body)
  });
}

exports.handler = async function (event) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY || "";
  const adminSecret = process.env.ADMIN_REVIEW_TOKEN || "";
  const supplied = event.headers?.["x-admin-token"] || event.headers?.["X-Admin-Token"] || "";

  if (!url || !secret || !adminSecret) {
    return json(500, { success: false, error: "Configuration administrateur incomplète." });
  }

  if (!secureEqual(supplied, adminSecret)) {
    return json(401, { success: false, error: "Code administrateur incorrect." });
  }

  if (!["GET", "POST"].includes(event.httpMethod)) {
    return json(405, { success: false, error: "Méthode non autorisée." });
  }

  try {
    if (event.httpMethod === "GET") {
      const expiryNow = new Date().toISOString();

      await db(url, secret, `vip_subscriptions?status=eq.active&expires_at=lte.${encodeURIComponent(expiryNow)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "expired" })
      });

      const [profiles, subscriptions, payments, affiliates, settings] = await Promise.all([
        db(url, secret, "profiles?select=id,email,full_name,created_at&order=created_at.desc&limit=200"),
        db(url, secret, "vip_subscriptions?select=id,user_id,plan_code,amount_xof,status,source,starts_at,expires_at,created_at,admin_note&order=created_at.desc&limit=200"),
        db(url, secret, "payment_requests?select=id,user_id,plan_code,amount_xof,payment_method,payer_name,transaction_reference,status,created_at,admin_note&order=created_at.desc&limit=100"),
        db(url, secret, "affiliate_applications?select=id,user_id,partner_code,partner_username,deposit_amount,proof_reference,status,created_at,admin_note&order=created_at.desc&limit=100"),
        db(url, secret, "app_settings?select=value&key=eq.payment_details&limit=1")
      ]);

      return json(200, {
        success: true,
        profiles: profiles || [],
        subscriptions: subscriptions || [],
        paymentRequests: payments || [],
        affiliateApplications: affiliates || [],
        paymentDetails: settings?.[0]?.value || {}
      });
    }

    let body = {};

    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      return json(400, { success: false, error: "Corps de requête invalide." });
    }

    let result;

    if (body.action === "review_payment") {
      if (!body.id || !["approve", "reject"].includes(body.decision)) {
        return json(400, { success: false, error: "Demande ou décision invalide." });
      }

      result = await rpc(url, secret, "admin_review_payment", {
        p_request_id: body.id,
        p_decision: body.decision,
        p_admin_note: String(body.note || "").slice(0, 500)
      });

    } else if (body.action === "review_affiliate") {
      if (!body.id || !["approve", "reject"].includes(body.decision)) {
        return json(400, { success: false, error: "Demande ou décision invalide." });
      }

      result = await rpc(url, secret, "admin_review_affiliate", {
        p_application_id: body.id,
        p_decision: body.decision,
        p_admin_note: String(body.note || "").slice(0, 500)
      });

    } else if (body.action === "save_payment_details") {
      const details = {
        wave_number: String(body.wave_number || "").trim().slice(0, 40),
        orange_money_number: String(body.orange_money_number || "").trim().slice(0, 40),
        account_name: String(body.account_name || "").trim().slice(0, 100),
        instructions: String(body.instructions || "").trim().slice(0, 500)
      };

      result = await db(url, secret, "app_settings?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([{ key: "payment_details", value: details }])
      });

    } else if (body.action === "grant_vip") {
      const days = Number(body.days);

      if (!body.user_id || !Number.isInteger(days) || days < 1 || days > 365) {
        return json(400, { success: false, error: "Compte ou durée invalide." });
      }

      result = await rpc(url, secret, "admin_grant_vip", {
        p_user_id: body.user_id,
        p_days: days,
        p_admin_note: String(body.note || "").slice(0, 500)
      });

    } else if (body.action === "revoke_vip") {
      if (!body.id) {
        return json(400, { success: false, error: "Abonnement manquant." });
      }

      result = await rpc(url, secret, "admin_revoke_vip", {
        p_subscription_id: body.id
      });

    } else {
      return json(400, { success: false, error: "Action inconnue." });
    }

    return json(200, { success: true, result });

  } catch (error) {
    console.error("admin-api:", error.message);

    return json(error.status || 500, {
      success: false,
      error: error.status && error.status < 500
        ? error.message
        : "L'opération administrative n'a pas abouti. Vérifie la migration SQL et réessaie."
    });
  }
};
