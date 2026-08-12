import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { checkRateLimit, clientIp } from "../lib/ratelimit.mjs";

function hashPassword(pw) {
  return createHash("sha256").update(String(pw)).digest("hex");
}

function publicShape(p) {
  const { passwordHash, ...rest } = p;
  return rest;
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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0" },
  });
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  // Límite estricto: 20 intentos cada 15 minutos por IP, cuenten o no como
  // clave correcta — así nadie puede probar miles de claves en bucle.
  const ip = clientIp(req);
  const withinLimit = await checkRateLimit("admin-auth", ip, 20, 15 * 60 * 1000);
  if (!withinLimit) {
    return jsonResponse({ error: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." }, 429);
  }

  // La clave de administrador vive SOLO en Netlify (variable de entorno),
  // nunca en el código del navegador. Sin ella, ninguna acción funciona.
  if (!process.env.ADMIN_SECRET_KEY || body.adminKey !== process.env.ADMIN_SECRET_KEY) {
    return jsonResponse({ error: "Clave de administrador incorrecta" }, 401);
  }

  const proStore = getStore("professionals");
  const revStore = getStore("reviews");

  if (body.action === "list-professionals") {
    const all = await readAll(proStore);
    return jsonResponse(all.map(publicShape));
  }

  if (body.action === "delete-professional") {
    const all = await readAll(proStore);
    const next = all.filter((p) => p.id !== body.id);
    await writeAll(proStore, next);
    return jsonResponse({ deleted: next.length !== all.length });
  }

  if (body.action === "reset-password") {
    if (!body.id || !body.newPassword || String(body.newPassword).length < 6) {
      return jsonResponse({ error: "Faltan datos o la contraseña es demasiado corta (mín. 6)" }, 400);
    }
    const all = await readAll(proStore);
    const idx = all.findIndex((p) => p.id === body.id);
    if (idx === -1) return jsonResponse({ error: "No encontrado" }, 404);
    all[idx].passwordHash = hashPassword(body.newPassword);
    await writeAll(proStore, all);
    return jsonResponse({ reset: true });
  }

  // --- Activar manualmente un anuncio: solo para pagos recibidos FUERA de
  // Stripe (Bizum directo, transferencia, efectivo...). No crea ninguna
  // suscripción real en Stripe — el propio administrador es responsable de
  // llevar el seguimiento de esos cobros y renovarlos o cancelarlos a mano. ---
  if (body.action === "activate-manual") {
    const days = Number(body.days) > 0 ? Number(body.days) : 30;
    const all = await readAll(proStore);
    const idx = all.findIndex((p) => p.id === body.id);
    if (idx === -1) return jsonResponse({ error: "No encontrado" }, 404);
    all[idx].status = "active";
    all[idx].canceled = false;
    all[idx].stripeSubscriptionId = null; // no hay suscripción real de Stripe detrás
    all[idx].nextChargeAt = Date.now() + days * 86400000;
    all[idx].renewals = [
      ...(all[idx].renewals || []),
      { id: `ren_${Date.now()}`, date: Date.now(), manual: true },
    ];
    await writeAll(proStore, all);
    return jsonResponse(publicShape(all[idx]));
  }

  if (body.action === "list-reviews") {
    const raw = await revStore.get("all", { type: "json" });
    return jsonResponse(Array.isArray(raw) ? raw : []);
  }

  if (body.action === "delete-review") {
    const raw = await revStore.get("all", { type: "json" });
    const list = Array.isArray(raw) ? raw : [];
    const next = list.filter((r) => r.id !== body.id);
    await revStore.setJSON("all", next);
    return jsonResponse({ deleted: next.length !== list.length });
  }

  return jsonResponse({ error: "Acción no reconocida" }, 400);
};
