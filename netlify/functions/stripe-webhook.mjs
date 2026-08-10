import { getStore } from "@netlify/blobs";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

async function readAll(store) {
  const raw = await store.get("all", { type: "json" });
  return Array.isArray(raw) ? raw : [];
}
async function writeAll(store, list) {
  await store.setJSON("all", list);
}

export default async (req) => {
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
  } catch (err) {
    // Firma inválida: alguien está intentando falsear un aviso de pago.
    // Se rechaza sin tocar nada.
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const store = getStore("professionals");

  // Pago inicial completado (primera vez que alguien paga la suscripción) ---
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const proId = session.client_reference_id;
    if (proId) {
      const all = await readAll(store);
      const idx = all.findIndex((p) => p.id === proId);
      if (idx !== -1) {
        // Comprobar si este cliente (por email) ya tuvo alguna suscripción
        // antes -> si es así, está reutilizando la prueba gratuita: se
        // cancela la suscripción nueva al instante y NO se activa el anuncio.
        let isRepeatTrial = false;
        if (session.customer) {
          try {
            const subs = await stripe.subscriptions.list({ customer: session.customer, limit: 100 });
            isRepeatTrial = subs.data.length > 1;
          } catch {
            // Si la consulta falla, seguimos sin bloquear (mejor un falso
            // negativo aquí que dejar a alguien sin poder publicar por un
            // error nuestro).
          }
        }

        if (isRepeatTrial && session.subscription) {
          try {
            await stripe.subscriptions.cancel(session.subscription);
          } catch {
            // Si ya estaba cancelada o falla, no pasa nada: igualmente no
            // se activa el anuncio.
          }
          all[idx].status = "trial_denied";
          all[idx].canceled = true;
        } else {
          all[idx].status = "active";
          all[idx].canceled = false;
          all[idx].stripeSubscriptionId = session.subscription || all[idx].stripeSubscriptionId;
          all[idx].nextChargeAt = Date.now() + MONTHLY_MS;
          all[idx].renewals = [...(all[idx].renewals || []), { id: `ren_${Date.now()}`, date: Date.now() }];
        }
        await writeAll(store, all);
      }
    }
  }

  // Renovación mensual cobrada automáticamente por Stripe ---
  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    const subId = invoice.subscription || invoice.parent?.subscription_details?.subscription;
    if (subId) {
      const all = await readAll(store);
      const idx = all.findIndex((p) => p.stripeSubscriptionId === subId);
      if (idx !== -1) {
        all[idx].status = "active";
        all[idx].nextChargeAt = Date.now() + MONTHLY_MS;
        all[idx].renewals = [...(all[idx].renewals || []), { id: `ren_${Date.now()}`, date: Date.now() }];
        await writeAll(store, all);
      }
    }
  }

  // La suscripción se canceló o dejó de pagarse: se retira el anuncio ---
  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const obj = event.data.object;
    const subId = obj.subscription || obj.id;
    const all = await readAll(store);
    const idx = all.findIndex((p) => p.stripeSubscriptionId === subId);
    if (idx !== -1) {
      all[idx].canceled = true;
      await writeAll(store, all);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
