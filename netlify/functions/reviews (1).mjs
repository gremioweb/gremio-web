import { getStore } from "@netlify/blobs";
import { checkRateLimit, clientIp } from "./_shared/ratelimit.mjs";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}

export default async (req) => {
  const store = getStore("reviews");

  if (req.method === "GET") {
    const list = (await store.get("all", { type: "json" })) || [];
    return jsonResponse(list);
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

  const ip = clientIp(req);
  const withinLimit = await checkRateLimit("review-create", ip, 10, 60 * 60 * 1000);
  if (!withinLimit) {
    return jsonResponse({ error: "Demasiadas reseñas desde esta conexión. Inténtalo más tarde." }, 429);
  }

  if (!body.professionalId || !body.name || !body.rating) {
    return jsonResponse({ error: "Faltan datos de la reseña" }, 400);
  }

  const list = (await store.get("all", { type: "json" })) || [];
  const entry = {
    id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    professionalId: String(body.professionalId),
    name: String(body.name).slice(0, 60),
    rating: Math.max(1, Math.min(5, Number(body.rating) || 5)),
    comment: String(body.comment || "").slice(0, 600),
    createdAt: Date.now(),
  };
  list.push(entry);
  await store.setJSON("all", list);
  return jsonResponse(entry);
};
