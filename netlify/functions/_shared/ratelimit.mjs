import { getStore } from "@netlify/blobs";

// Limitador de peticiones sencillo basado en IP. No es infalible (alguien
// con muchas IPs distintas podría saltárselo), pero detiene el abuso más
// habitual: bots o gente enviando el mismo formulario en bucle.
export async function checkRateLimit(bucket, ip, maxRequests, windowMs) {
  const store = getStore("ratelimits");
  const key = `${bucket}:${ip || "unknown"}`;
  const now = Date.now();
  let entry;
  try {
    entry = await store.get(key, { type: "json" });
  } catch {
    entry = null;
  }
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, count: 0 };
  }
  entry.count += 1;
  await store.setJSON(key, entry);
  return entry.count <= maxRequests;
}

export function clientIp(req) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for") ||
    "unknown"
  );
}
