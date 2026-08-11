import { getStore } from "@netlify/blobs";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0" },
  });
}

// Límite generoso pero real (el cliente ya valida antes de subir, esto es
// una segunda barrera por si alguien llama a la función directamente).
const MAX_BYTES = 1_500_000;

export default async (req) => {
  const store = getStore("photos");
  const url = new URL(req.url);

  // --- Servir una foto ya subida ---
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return new Response("Falta el id", { status: 400 });
    const blob = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!blob) return new Response("No encontrada", { status: 404 });
    const contentType = blob.metadata?.contentType || "image/jpeg";
    return new Response(blob.data, {
      status: 200,
      headers: {
        "content-type": contentType,
        // Una foto subida nunca cambia de contenido bajo el mismo id, así
        // que se puede cachear de forma agresiva en el navegador/CDN.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  // --- Subir una foto nueva ---
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const dataUrl = String(body.dataUrl || "");
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return jsonResponse({ error: "Formato de imagen no válido" }, 400);

  const contentType = match[1];
  if (!contentType.startsWith("image/")) {
    return jsonResponse({ error: "Solo se admiten imágenes" }, 400);
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_BYTES) {
    return jsonResponse({ error: `La imagen pesa demasiado (máx. ${Math.round(MAX_BYTES / 1000)} KB)` }, 400);
  }

  const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await store.set(id, bytes, { metadata: { contentType } });

  return jsonResponse({ id, url: `/.netlify/functions/photos?id=${id}` });
};
