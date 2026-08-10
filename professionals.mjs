import { getStore } from "@netlify/blobs";

// Normaliza un teléfono español para comparar (quita espacios, +34, etc.)
function waNumber(v) {
  return String(v || "").replace(/\D/g, "").replace(/^34/, "");
}

async function readAll(store) {
  const raw = await store.get("all", { type: "json" });
  return Array.isArray(raw) ? raw : [];
}

async function writeAll(store, list) {
  await store.setJSON("all", list);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req) => {
  const store = getStore("professionals");
  const url = new URL(req.url);

  // --- GET: listado completo (usado tanto para el buscador público como
  // para que un profesional encuentre su propio anuncio por teléfono) ---
  if (req.method === "GET") {
    const all = await readAll(store);
    const id = url.searchParams.get("id");
    if (id) {
      const one = all.find((p) => p.id === id);
      return one ? jsonResponse(one) : jsonResponse({ error: "No encontrado" }, 404);
    }
    return jsonResponse(all);
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const all = await readAll(store);

  // --- Crear un anuncio nuevo (queda "pending" hasta que Stripe confirme el pago) ---
  if (body.action === "create") {
    const required = ["name", "phone", "email", "category", "description", "price", "zone"];
    for (const field of required) {
      if (!body[field]) return jsonResponse({ error: `Falta el campo ${field}` }, 400);
    }
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "El email no tiene un formato válido" }, 400);
    }

    // Memoria propia: si este email ya llegó a activar una prueba gratuita
    // antes (o ya se le denegó una reutilización), no se le deja ni siquiera
    // llegar a Stripe con un anuncio nuevo.
    const alreadyUsedTrial = all.some(
      (p) => p.email && p.email.toLowerCase() === email && (p.status === "active" || p.status === "trial_denied")
    );
    if (alreadyUsedTrial) {
      return jsonResponse(
        { error: "Este email ya ha usado la prueba gratuita antes. Contacta con nosotros para activarlo con pago inmediato." },
        409
      );
    }

    const id = `pro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id,
      name: String(body.name).slice(0, 120),
      phone: String(body.phone).slice(0, 20),
      email,
      category: String(body.category).slice(0, 60),
      description: String(body.description).slice(0, 800),
      price: String(body.price).slice(0, 60),
      zone: String(body.zone).slice(0, 120),
      logo: typeof body.logo === "string" ? body.logo : null,
      photos: Array.isArray(body.photos) ? body.photos.slice(0, 4) : [],
      status: "pending", // "pending" | "active" | "trial_denied" — solo el webhook de Stripe pasa esto a "active"
      canceled: false,
      stripeSubscriptionId: null,
      nextChargeAt: null,
      renewals: [],
      createdAt: Date.now(),
    };
    all.push(entry);
    await writeAll(store, all);
    return jsonResponse(entry);
  }

  // --- Cancelar / reactivar (requiere el teléfono con el que se publicó, como ya
  // pedía el panel antes de este cambio; no es una autenticación fuerte, pero es
  // el mismo nivel de protección que ya tenía la web) ---
  if (body.action === "cancel") {
    const idx = all.findIndex((p) => p.id === body.id && waNumber(p.phone) === waNumber(body.phone));
    if (idx === -1) return jsonResponse({ error: "No encontrado o teléfono incorrecto" }, 404);
    all[idx].canceled = body.canceled !== false;
    await writeAll(store, all);
    return jsonResponse(all[idx]);
  }

  return jsonResponse({ error: "Acción no reconocida" }, 400);
};
