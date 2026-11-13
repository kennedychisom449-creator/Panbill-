import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const workerAuthSecret = Deno.env.get("PANBILL_EMAIL_WORKER_SECRET") || "";
const resendKey = Deno.env.get("RESEND_API_KEY") || "";
const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "";

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );

const naira = (v: unknown) =>
  `₦${Number(v || 0).toLocaleString("en-NG")}`;

function emailLayout(title: string, body: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17233d">
    <div style="background:#07152f;padding:22px;color:#ffe4a0;font-size:25px;font-weight:bold">PanBill</div>
    <div style="padding:24px"><h2>${title}</h2>${body}
    <p style="margin-top:28px;color:#68758a">PanBill Marketplace · panbill.com.ng</p></div>
  </div>`;
}

function renderOriginalOrderEmail(event: any) {
  const p = event.payload || {};
  const orderNo = esc(p.order_number || "PanBill order");
  const isEstimate = event.event_type === "delivery_estimate_updated";

  const title = isEstimate
    ? "Your delivery estimate has been updated"
    : event.recipient_role === "admin"
    ? "New PanBill marketplace order"
    : event.recipient_role === "seller"
    ? "New marketplace order for your store"
    : "Your PanBill order is confirmed";

  const items = Array.isArray(p.items)
    ? p.items.map((x: any) =>
      `<li style="margin-bottom:14px">
        <strong>${esc(x.product_name)}</strong> × ${esc(x.quantity)}
        — ${naira(x.line_total)}
        <br><strong>Complete Product ID:</strong>
        <span style="overflow-wrap:anywhere;word-break:break-word">${esc(x.product_id || "Not available")}</span>
      </li>`
    ).join("")
    : "";

  const estimate = isEstimate
    ? `<p>Your seller estimates delivery in <strong>${esc(p.delivery_estimate_days)} day(s)</strong>${
      p.estimated_delivery_at
        ? ` (estimated date: ${esc(new Date(p.estimated_delivery_at).toLocaleDateString("en-NG"))})`
        : ""
    }.</p>${p.status_note ? `<p>Seller note: ${esc(p.status_note)}</p>` : ""}`
    : "";

  const orderInfo = !isEstimate
    ? `<p><strong>Payment:</strong> ${esc(p.payment_method)} — ${esc(p.payment_status)}</p>
      <p><strong>Delivery:</strong> ${esc(p.delivery_method)} · ${esc(p.delivery_name)} · ${esc(p.delivery_phone)}</p>
      <p><strong>Address:</strong> ${esc(p.delivery_address)}</p>
      ${items ? `<ul style="padding-left:20px">${items}</ul>` : ""}
      <p><strong>Order total:</strong> ${naira(p.total_amount)}</p>`
    : "";

  // Seller-only follow-up: show the assigned fulfillment agent when available.
  const assignedAgentInfo = !isEstimate && event.recipient_role === "seller" && (p.agent_name || p.agent_phone)
    ? `<div style="background:#f5f7fb;padding:16px;border-radius:8px;margin:18px 0">
        <p><strong>Assigned PanBill agent</strong></p>
        ${p.agent_name ? `<p><strong>Agent name:</strong> ${esc(p.agent_name)}</p>` : ""}
        ${p.agent_phone ? `<p><strong>Agent phone:</strong> ${esc(p.agent_phone)}</p>` : ""}
      </div>`
    : "";

  const intro = isEstimate
    ? `The seller has provided an update for order ${orderNo}.`
    : event.recipient_role === "admin"
    ? `A new marketplace order (${orderNo}) has been placed on PanBill.`
    : event.recipient_role === "seller"
    ? `A buyer has placed order ${orderNo} containing products from your store.`
    : `Thank you for shopping on PanBill. Your order ${orderNo} has been placed successfully.`;

  return {
    subject: `${title} — ${orderNo}`,
    html: emailLayout(title, `<p>${intro}</p>${estimate}${assignedAgentInfo}${orderInfo}`),
  };
}

function safeHttpsUrl(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const trustedHost = host === "panbill.com.ng" ||
      host === "www.panbill.com.ng" ||
      host === "rbvmtrsftnmnlxjmewpp.supabase.co";

    return parsed.protocol === "https:" && trustedHost ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function renderAgentWelcome(event: any) {
  const p = event.payload || {};
  const agentName = esc(p.agent_name || "PanBill Agent");
  const agentType = p.agent_type === "pickup" ? "Pickup Station Agent" : "Doorstep Delivery Agent";
  const dashboardUrl = safeHttpsUrl(p.dashboard_url, "https://panbill.com.ng/agent.html");
  const activationUrl = safeHttpsUrl(p.activation_url || p.invite_url, "");
  const title = "Welcome to the PanBill Marketplace Agent Team";

  const accessLink = activationUrl
    ? `<p>Your appointment has been approved. Use the secure invitation link below to activate your PanBill account and set your password. After activation, open your Agent Dashboard.</p>
       <p style="margin:24px 0"><a href="${esc(activationUrl)}" style="display:inline-block;background:#07152f;color:#ffe4a0;text-decoration:none;padding:13px 22px;border-radius:6px;font-weight:bold">Activate Agent Account</a></p>
       <p>Once your account is activated, sign in at the Agent Dashboard using the email address this message was sent to.</p>`
    : `<p>Your PanBill marketplace agent account has been set up successfully. You can access your personal agent dashboard using your existing PanBill account login.</p>
       <p><strong>Important:</strong> Sign in with the same email address and password you already use for PanBill. No new account or password is required.</p>`;

  const body = `<p>Hello ${agentName},</p>
    <p>Your PanBill marketplace agent appointment is approved. Your assigned role is <strong>${agentType}</strong>.</p>
    ${accessLink}
    <p style="margin:24px 0"><a href="${esc(dashboardUrl)}" style="display:inline-block;background:#07152f;color:#ffe4a0;text-decoration:none;padding:13px 22px;border-radius:6px;font-weight:bold">Open Agent Dashboard</a></p>
    <p>Use your dashboard to view orders assigned to you and update their fulfillment status. Please keep your login details and invitation link private.</p>`;

  return { subject: `${title} — PanBill`, html: emailLayout(title, body) };
}

function renderAgentOrderAssigned(event: any) {
  const p = event.payload || {};
  const orderNo = esc(p.order_number || "PanBill order");
  const agentName = esc(p.agent_name || "PanBill Agent");
  const assignmentId = esc(p.assignment_id || "Not available");
  const assignmentType = p.assignment_type === "pickup" || p.agent_type === "pickup"
    ? "Pickup Station"
    : "Doorstep Delivery";

  const items = Array.isArray(p.items)
    ? p.items.map((item: any) =>
      `<li style="margin-bottom:14px">
        <strong>${esc(item.product_name)}</strong> × ${esc(item.quantity)}
        — ${naira(item.line_total)}
        <br><strong>Complete Product ID:</strong>
        <span style="overflow-wrap:anywhere;word-break:break-word">${esc(item.product_id || "Not available")}</span>
      </li>`
    ).join("")
    : "";

  const title = "A Marketplace Order Has Been Assigned to You";

  const body = `
    <p>Hello ${agentName},</p>
    <p>A PanBill marketplace order has been assigned to you. Please review the order details below.</p>

    <div style="background:#f5f7fb;padding:16px;border-radius:8px;margin:18px 0">
      <p><strong>Order number:</strong> ${orderNo}</p>
      <p><strong>Assignment ID:</strong>
        <span style="overflow-wrap:anywhere;word-break:break-word">${assignmentId}</span>
      </p>
      <p><strong>Assignment type:</strong> ${esc(assignmentType)}</p>
    </div>

    <h3>Assigned products</h3>
    ${items ? `<ul style="padding-left:20px">${items}</ul>` : "<p>No product details were attached to this notification. Please check your dashboard.</p>"}

    <div style="background:#f5f7fb;padding:16px;border-radius:8px;margin:18px 0">
      <h3>Delivery information</h3>
      <p><strong>Recipient:</strong> ${esc(p.delivery_name || "Not provided")}</p>
      <p><strong>Phone:</strong> ${esc(p.delivery_phone || "Not provided")}</p>
      <p><strong>Address:</strong> ${esc(p.delivery_address || "Not provided")}</p>
      ${p.delivery_notes ? `<p><strong>Delivery notes:</strong> ${esc(p.delivery_notes)}</p>` : ""}
    </div>

    <div style="background:#f5f7fb;padding:16px;border-radius:8px;margin:18px 0">
      <h3>Payment information</h3>
      <p><strong>Payment method:</strong> ${esc(p.payment_method || "Not provided")}</p>
      <p><strong>Payment status:</strong> ${esc(p.payment_status || "Not provided")}</p>
      <p><strong>Order total:</strong> ${naira(p.total_amount)}</p>
    </div>

    <p>Please sign in to your agent dashboard to review the assignment and carry out the required fulfillment steps.</p>
    <p style="margin:24px 0">
      <a href="https://panbill.com.ng/agent.html"
        style="display:inline-block;background:#07152f;color:#ffe4a0;text-decoration:none;padding:13px 22px;border-radius:6px;font-weight:bold">
        Open Agent Dashboard
      </a>
    </p>
    <p>Keep the complete product IDs available when verifying the products for this order.</p>
  `;

  return {
    subject: `Order Assigned to You — ${orderNo}`,
    html: emailLayout(title, body),
  };
}

function renderBuyerFulfillmentEmail(event: any) {
  const p = event.payload || {};
  const orderNo = esc(p.order_number || "your order");
  const station = p.pickup_station || {};
  const stationName = esc(station.name || p.pickup_station_name || "");
  const stationAddress = esc(station.address || p.pickup_station_address || "");
  const collectionDate = esc(p.collection_date || p.collection_day || p.ready_for_collection_date || "");
  const collectionInstructions = esc(p.collection_instructions || p.instructions || "");

  let title = "Your PanBill order update";
  let message = "";

  switch (event.event_type) {
    case "pickup_confirmed":
      title = "Pickup station confirmed";
      message = `<p>Your order <strong>${orderNo}</strong> is set for collection at the selected pickup station.</p>`;
      break;

    case "ready_for_collection":
    case "pickup_ready_for_collection":
      title = "Your order is ready for collection";
      message = `<p>Good news! Your order <strong>${orderNo}</strong> is ready for collection.</p>`;
      break;

    case "collection_day_reminder":
      title = "Reminder: collect your PanBill order today";
      message = `<p>This is a reminder that your order <strong>${orderNo}</strong> is scheduled for collection today.</p>`;
      break;

    case "out_for_delivery":
    case "doorstep_out_for_delivery":
      title = "Your order is out for delivery";
      message = `<p>Your order <strong>${orderNo}</strong> has been dispatched and is on its way to your delivery address.</p>`;
      break;

    case "delivered":
    case "doorstep_delivered":
      title = "Your order has been delivered";
      message = `<p>Your order <strong>${orderNo}</strong> has been marked as successfully delivered.</p>`;
      break;

    case "pickup_collected":
      title = "Your order has been collected";
      message = `<p>Your order <strong>${orderNo}</strong> has been marked as collected from the pickup station.</p>`;
      break;

    case "delivery_failed":
      title = "Delivery attempt unsuccessful";
      message = `<p>We could not complete delivery of your order <strong>${orderNo}</strong>. Our team will follow up with the next steps.</p>`;
      if (p.failure_reason) message += `<p><strong>Reason:</strong> ${esc(p.failure_reason)}</p>`;
      break;

    default:
      message = `<p>There is an update regarding your PanBill order <strong>${orderNo}</strong>.</p>`;
  }

  const pickupInfo = stationName || stationAddress || collectionDate || collectionInstructions
    ? `<div style="background:#f5f7fb;padding:16px;border-radius:8px;margin:18px 0">
        ${stationName ? `<p><strong>Pickup station:</strong> ${stationName}</p>` : ""}
        ${stationAddress ? `<p><strong>Station address:</strong> ${stationAddress}</p>` : ""}
        ${collectionDate ? `<p><strong>Collection day:</strong> ${collectionDate}</p>` : ""}
        ${collectionInstructions ? `<p><strong>Collection instructions:</strong> ${collectionInstructions}</p>` : ""}
      </div>`
    : "";

  const deliveryInfo = p.delivery_address
    ? `<p><strong>Delivery address:</strong> ${esc(p.delivery_address)}</p>`
    : "";

  return {
    subject: `${title} — ${orderNo}`,
    html: emailLayout(title, `${message}${pickupInfo}${deliveryInfo}<p>Thank you for shopping with PanBill.</p>`),
  };
}

function renderEmail(event: any) {
  if (event.event_type === "agent_welcome" && event.recipient_role === "agent") {
    return renderAgentWelcome(event);
  }

  if (
    event.event_type === "order_placed" &&
    event.recipient_role === "agent" &&
    event.payload?.assignment_id
  ) {
    return renderAgentOrderAssigned(event);
  }

  const buyerFulfillmentEvents = new Set([
    "pickup_confirmed",
    "ready_for_collection",
    "pickup_ready_for_collection",
    "collection_day_reminder",
    "out_for_delivery",
    "doorstep_out_for_delivery",
    "delivered",
    "doorstep_delivered",
    "pickup_collected",
    "delivery_failed",
  ]);

  if (event.recipient_role === "buyer" && buyerFulfillmentEvents.has(event.event_type)) {
    return renderBuyerFulfillmentEmail(event);
  }

  // Keep the existing buyer, seller, admin and delivery-estimate email templates.
  return renderOriginalOrderEmail(event);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "Method not allowed." }, 405);

  const auth = req.headers.get("Authorization") || "";
  if (!workerAuthSecret || auth !== `Bearer ${workerAuthSecret}`) {
    return respond({ success: false, error: "Service authorization required." }, 401);
  }

  if (!resendKey || !fromEmail) {
    return respond({ success: false, error: "Resend sender configuration is missing." }, 500);
  }

  try {
    const { data: events, error } = await supabase
      .from("marketplace_email_events")
      .select("id, recipient_email, recipient_role, event_type, payload")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;

    let sent = 0;
    let failed = 0;

    for (const event of events || []) {
      try {
        const mail = renderEmail(event);

        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [event.recipient_email],
            subject: mail.subject,
            html: mail.html,
          }),
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            String(result.message || result.name || `Resend returned ${response.status}`).slice(0, 500),
          );
        }

        const { error: updateError } = await supabase
          .from("marketplace_email_events")
          .update({
            status: "sent",
            provider_message_id: result.id || null,
            sent_at: new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", event.id)
          .eq("status", "queued");

        if (updateError) throw updateError;
        sent++;
      } catch (sendError) {
        await supabase
          .from("marketplace_email_events")
          .update({
            last_error: String(sendError instanceof Error ? sendError.message : sendError).slice(0, 1000),
            updated_at: new Date().toISOString(),
          })
          .eq("id", event.id);

        failed++;
      }
    }

    return respond({ success: true, processed: (events || []).length, sent, failed });
  } catch (error) {
    console.error("marketplace-email-worker error:", error);
    return respond({
      success: false,
      error: error instanceof Error ? error.message : "Email processing failed.",
    }, 500);
  }
});
