import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendKey = Deno.env.get("RESEND_API_KEY") || "";
const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "";
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function renderEmail(event: any) {
  const p = event.payload || {};
  const orderNo = esc(p.order_number || "PanBill order");
  const isEstimate = event.event_type === "delivery_estimate_updated";
  const title = isEstimate ? "Your delivery estimate has been updated" : event.recipient_role === "admin" ? "New PanBill marketplace order" : event.recipient_role === "seller" ? "New marketplace order for your store" : "Your PanBill order is confirmed";
  const items = Array.isArray(p.items) ? p.items.map((x: any) => `<li>${esc(x.product_name)} × ${esc(x.quantity)} — ₦${Number(x.line_total || 0).toLocaleString("en-NG")}</li>`).join("") : "";
  const estimate = isEstimate ? `<p>Your seller estimates delivery in <strong>${esc(p.delivery_estimate_days)} day(s)</strong>${p.estimated_delivery_at ? ` (estimated date: ${esc(new Date(p.estimated_delivery_at).toLocaleDateString("en-NG"))})` : ""}.</p>${p.status_note ? `<p>Seller note: ${esc(p.status_note)}</p>` : ""}` : "";
  const orderInfo = !isEstimate ? `<p><strong>Payment:</strong> ${esc(p.payment_method)} — ${esc(p.payment_status)}</p><p><strong>Delivery:</strong> ${esc(p.delivery_method)} · ${esc(p.delivery_name)} · ${esc(p.delivery_phone)}</p><p><strong>Address:</strong> ${esc(p.delivery_address)}</p>${items ? `<ul>${items}</ul>` : ""}<p><strong>Order total:</strong> ₦${Number(p.total_amount || 0).toLocaleString("en-NG")}</p>` : "";
  const intro = isEstimate ? `The seller has provided an update for order ${orderNo}.` : event.recipient_role === "admin" ? `A new marketplace order (${orderNo}) has been placed on PanBill.` : event.recipient_role === "seller" ? `A buyer has placed order ${orderNo} containing products from your store.` : `Thank you for shopping on PanBill. Your order ${orderNo} has been placed successfully.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17233d"><div style="background:#07152f;padding:22px;color:#ffe4a0;font-size:25px;font-weight:bold">PanBill</div><div style="padding:24px"><h2>${title}</h2><p>${intro}</p>${estimate}${orderInfo}<p style="margin-top:28px;color:#68758a">PanBill Marketplace · panbill.com.ng</p></div></div>`;
  return { subject: `${title} — ${orderNo}`, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "Method not allowed." }, 405);
  const auth = req.headers.get("Authorization") || "";
  if (!serviceKey || auth !== `Bearer ${serviceKey}`) return respond({ success: false, error: "Service authorization required." }, 401);
  if (!resendKey || !fromEmail) return respond({ success: false, error: "Resend sender configuration is missing." }, 500);
  try {
    const { data: events, error } = await supabase.from("marketplace_email_events")
      .select("id, recipient_email, recipient_role, event_type, payload")
      .eq("status", "queued").order("created_at", { ascending: true }).limit(50);
    if (error) throw error;
    let sent = 0, failed = 0;
    for (const event of events || []) {
      const mail = renderEmail(event);
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromEmail, to: [event.recipient_email], subject: mail.subject, html: mail.html }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(result.message || result.name || `Resend returned ${response.status}`).slice(0, 500));
        const { error: updateError } = await supabase.from("marketplace_email_events").update({ status: "sent", provider_message_id: result.id || null, sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", event.id).eq("status", "queued");
        if (updateError) throw updateError;
        sent++;
      } catch (sendError) {
        await supabase.from("marketplace_email_events").update({ last_error: String(sendError instanceof Error ? sendError.message : sendError).slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", event.id);
        failed++;
      }
    }
    return respond({ success: true, processed: (events || []).length, sent, failed });
  } catch (error) {
    console.error("marketplace-email-worker error:", error);
    return respond({ success: false, error: error instanceof Error ? error.message : "Email processing failed." }, 500);
  }
});
