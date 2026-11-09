import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY") || "";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

async function paystackVerify(reference: string) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== true || !result.data) {
    throw new Error(clean(result.message, 250) || "Could not verify payment with Paystack.");
  }
  return result.data;
}

const ADMIN_ORDER_EMAIL = "kennedychisom449@gmail.com";

async function enqueueOrderPlacedEmails(orderId: string) {
  try {
    const { data: order, error: orderError } = await admin.from("marketplace_orders")
      .select("id, order_number, buyer_id, payment_method, payment_status, fulfillment_type, delivery_method, delivery_name, delivery_phone, delivery_address, delivery_city, delivery_lga, delivery_state, total_amount, created_at")
      .eq("id", orderId).maybeSingle();
    if (orderError || !order) throw orderError || new Error("Order not found for email notification.");
    const { data: items, error: itemsError } = await admin.from("marketplace_order_items")
      .select("seller_id, product_name, quantity, line_total").eq("order_id", orderId);
    if (itemsError) throw itemsError;
    const { data: buyerResult, error: buyerError } = await admin.auth.admin.getUserById(order.buyer_id);
    if (buyerError) throw buyerError;
    const buyerEmail = clean(buyerResult?.user?.email, 254).toLowerCase();
    const base = { order_number: order.order_number, total_amount: order.total_amount,
      payment_method: order.payment_method, payment_status: order.payment_status,
      delivery_method: order.delivery_method, delivery_name: order.delivery_name,
      delivery_phone: order.delivery_phone, delivery_address: [order.delivery_address, order.delivery_city, order.delivery_lga, order.delivery_state].filter(Boolean).join(", "),
      items: items || [], placed_at: order.created_at };
    const events: any[] = [];
    if (buyerEmail) events.push({ event_key: `order_placed:${order.id}:buyer`, order_id: order.id, recipient_user_id: order.buyer_id, recipient_email: buyerEmail, recipient_role: "buyer", event_type: "order_placed", payload: base });
    events.push({ event_key: `order_placed:${order.id}:admin`, order_id: order.id, recipient_email: ADMIN_ORDER_EMAIL, recipient_role: "admin", event_type: "order_placed", payload: base });
    const sellerIds = [...new Set((items || []).map((x: any) => x.seller_id).filter(Boolean))];
    if (sellerIds.length) {
      const { data: sellers, error: sellerError } = await admin.from("marketplace_sellers")
        .select("user_id, business_name, contact_email").in("user_id", sellerIds);
      if (sellerError) throw sellerError;
      for (const seller of sellers || []) {
        const email = clean(seller.contact_email, 254).toLowerCase();
        if (!email) continue;
        events.push({ event_key: `order_placed:${order.id}:seller:${seller.user_id}`, order_id: order.id, recipient_user_id: seller.user_id, recipient_email: email, recipient_role: "seller", event_type: "order_placed", payload: { ...base, seller_name: seller.business_name, items: (items || []).filter((x: any) => x.seller_id === seller.user_id) } });
      }
    }
    if (events.length) {
      const { error } = await admin.from("marketplace_email_events").upsert(events, { onConflict: "event_key", ignoreDuplicates: true });
      if (error) throw error;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      await fetch(`${SUPABASE_URL}/functions/v1/marketplace-email-worker`, { method: "POST", headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, body: "{}" }).catch((e) => console.error("Email worker invoke failed:", e));
    }
  } catch (error) {
    // Email queue failure must never undo a successfully placed or paid order.
    console.error("PanBill order email enqueue failed:", error);
  }
}

async function finalizeVerifiedPayment(reference: string, data: any) {
  const { data: order, error: orderError } = await admin
    .from("marketplace_orders")
    .select("id, order_number, total_amount, payment_status, payment_method")
    .eq("payment_reference", reference)
    .maybeSingle();
  if (orderError) throw orderError;
  if (!order) throw new Error("Marketplace order was not found.");
  if (order.payment_method === "cash_on_delivery") {
    throw new Error("This order uses cash on delivery and cannot be verified through Paystack.");
  }

  const expectedKobo = Math.round(Number(order.total_amount) * 100);
  const paidKobo = Number(data.amount);
  if (data.status !== "success" || data.reference !== reference ||
      data.currency !== "NGN" || !Number.isFinite(paidKobo) || paidKobo !== expectedKobo) {
    throw new Error("Paystack payment details do not match this PanBill order. The order has not been marked paid.");
  }

  const { data: finalized, error } = await admin.rpc("marketplace_finalize_checkout_payment", {
    p_reference: reference,
    p_success: true,
    p_provider_reference: clean(data.id, 100),
    p_provider_response: data,
  });
  if (error) throw error;
  if (finalized?.success) await enqueueOrderPlacedEmails(order.id);
  return finalized;
}

async function verifyPaystackWebhookSignature(rawBody: string, signature: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(PAYSTACK_SECRET_KEY),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "Method not allowed." }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return respond({ success: false, error: "Server configuration is incomplete. Check the Supabase secrets." }, 500);
  }

  try {
    // Paystack server-to-server webhook. Signature is verified before trusting its payload.
    const signature = req.headers.get("x-paystack-signature");
    if (signature) {
      if (!PAYSTACK_SECRET_KEY) return respond({ success: false, error: "Paystack webhook verification is not configured." }, 500);
      const rawBody = await req.text();
      if (!(await verifyPaystackWebhookSignature(rawBody, signature))) {
        return respond({ success: false, error: "Invalid Paystack webhook signature." }, 401);
      }
      const event = JSON.parse(rawBody);
      if (event.event === "charge.success" && event.data?.reference) {
        const verified = await paystackVerify(String(event.data.reference));
        const result = await finalizeVerifiedPayment(String(event.data.reference), verified);
        return respond({ received: true, result });
      }
      return respond({ received: true, ignored: true });
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return respond({ success: false, error: "Please sign in first." }, 401);
    }
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await authClient.auth.getUser();
    const user = userData?.user;
    if (authError || !user) return respond({ success: false, error: "Invalid or expired session." }, 401);

    const body = await req.json();
    const action = clean(body.action, 40);

    if (action === "create_checkout") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 30) return respond({ success: false, error: "Your cart is empty or too large." }, 400);
      const normalizedItems = items.map((item: any) => ({
        product_id: clean(item.product_id, 50),
        quantity: Number(item.quantity),
      }));
      if (normalizedItems.some((item: any) => !/^[0-9a-f-]{36}$/i.test(item.product_id) || !Number.isInteger(item.quantity))) {
        return respond({ success: false, error: "Your cart contains an invalid product or quantity." }, 400);
      }

      const delivery = body.delivery && typeof body.delivery === "object" ? body.delivery : {};
      // Default existing clients to doorstep delivery. Pickup is accepted only
      // when a valid active PanBill pickup-point UUID is supplied; the database
      // function independently verifies that the centre is active.
      const deliveryMethod = clean(body.delivery_method || delivery.method || "doorstep", 30);
      const pickupPointId = clean(body.pickup_point_id || delivery.pickup_point_id || "", 50);
      if (!["doorstep", "pickup_point"].includes(deliveryMethod)) {
        return respond({ success: false, error: "Choose doorstep delivery or a PanBill collection centre." }, 400);
      }
      if (deliveryMethod === "pickup_point" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pickupPointId)) {
        return respond({ success: false, error: "Select an available PanBill collection centre." }, 400);
      }
      if (deliveryMethod === "doorstep" && pickupPointId) {
        return respond({ success: false, error: "Please clear the collection-centre selection for doorstep delivery." }, 400);
      }
      const paymentMethod = clean(body.payment_method || body.paymentMethod || "online", 40);
      if (!["online", "cash_on_delivery"].includes(paymentMethod)) {
        return respond({ success: false, error: "Choose Pay Online or Cash on Delivery." }, 400);
      }
      const reference = paymentMethod === "cash_on_delivery"
        ? `PBMCOD_${Date.now()}_${crypto.randomUUID().replace(/-/g, "")}`
        : `PBMKT_${Date.now()}_${crypto.randomUUID().replace(/-/g, "")}`;

      if (paymentMethod === "cash_on_delivery") {
        const { data: created, error: createError } = await admin.rpc("marketplace_create_cod_checkout_order", {
          p_buyer_id: user.id,
          p_items: normalizedItems,
          p_delivery_name: clean(delivery.name, 120),
          p_delivery_phone: clean(delivery.phone, 40),
          p_delivery_address: clean(delivery.address, 500),
          p_delivery_city: clean(delivery.city, 120),
          p_delivery_lga: clean(delivery.lga, 120),
          p_delivery_state: clean(delivery.state, 120),
          p_delivery_notes: clean(delivery.notes, 500),
          p_payment_reference: reference,
          p_delivery_method: deliveryMethod,
          p_pickup_point_id: deliveryMethod === "pickup_point" ? pickupPointId : null,
        });
        if (createError) return respond({ success: false, error: createError.message }, 400);
        await enqueueOrderPlacedEmails(created.order_id);
        return respond({
          success: true,
          payment_method: "cash_on_delivery",
          order_id: created.order_id,
          order_number: created.order_number,
          subtotal: created.subtotal,
          delivery_fee: created.delivery_fee,
          total_amount: created.total_amount,
          reference,
          delivery_method: created.delivery_method,
          pickup_point_id: created.pickup_point_id ?? null,
          message: "Your order has been placed. Pay in cash when your order arrives.",
        }, 201);
      }

      if (!PAYSTACK_SECRET_KEY) return respond({ success: false, error: "Paystack payments are temporarily unavailable." }, 500);
      const { data: created, error: createError } = await admin.rpc("marketplace_create_checkout_order", {
        p_buyer_id: user.id,
        p_items: normalizedItems,
        p_delivery_name: clean(delivery.name, 120),
        p_delivery_phone: clean(delivery.phone, 40),
        p_delivery_address: clean(delivery.address, 500),
        p_delivery_city: clean(delivery.city, 120),
        p_delivery_lga: clean(delivery.lga, 120),
        p_delivery_state: clean(delivery.state, 120),
        p_delivery_notes: clean(delivery.notes, 500),
        p_payment_reference: reference,
        p_delivery_method: deliveryMethod,
        p_pickup_point_id: deliveryMethod === "pickup_point" ? pickupPointId : null,
      });
      if (createError) return respond({ success: false, error: createError.message }, 400);

      try {
        const initResponse = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: user.email,
            amount: Math.round(Number(created.total_amount) * 100),
            currency: "NGN",
            reference,
            callback_url: "https://panbill.com.ng/?marketplace_payment=1",
            metadata: {
              order_id: created.order_id,
              order_number: created.order_number,
              user_id: user.id,
              payment_type: "marketplace_purchase",
            },
          }),
        });
        const initialized = await initResponse.json().catch(() => ({}));
        if (!initResponse.ok || initialized.status !== true || !initialized.data?.authorization_url) {
          throw new Error(clean(initialized.message, 250) || "Paystack could not initialize this payment.");
        }
        return respond({
          success: true,
          order_id: created.order_id,
          order_number: created.order_number,
          subtotal: created.subtotal,
          delivery_fee: created.delivery_fee,
          total_amount: created.total_amount,
          reference,
          authorization_url: initialized.data.authorization_url,
          expires_at: created.expires_at,
          message: "Order created and stock reserved for 30 minutes. Complete payment to confirm your order.",
        }, 201);
      } catch (initError) {
        await admin.rpc("marketplace_finalize_checkout_payment", {
          p_reference: reference,
          p_success: false,
          p_provider_reference: null,
          p_provider_response: { initialization_error: initError instanceof Error ? initError.message : "Paystack initialization failed" },
        });
        throw initError;
      }
    }

    if (action === "verify_payment") {
      const reference = clean(body.reference, 120);
      if (reference.length < 10) return respond({ success: false, error: "A valid payment reference is required." }, 400);
      const { data: order, error: orderError } = await admin
        .from("marketplace_orders")
        .select("id, order_number, buyer_id, payment_status, payment_method")
        .eq("payment_reference", reference)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order || order.buyer_id !== user.id) return respond({ success: false, error: "Order not found for this account." }, 404);
      if (order.payment_method === "cash_on_delivery") {
        return respond({ success: false, error: "This order uses Cash on Delivery. Pay the delivery agent when your order arrives.", payment_method: "cash_on_delivery", order_id: order.id, order_number: order.order_number }, 400);
      }
      if (order.payment_status === "paid") return respond({ success: true, already_paid: true, order_id: order.id, order_number: order.order_number, payment_status: "paid" });

      if (!PAYSTACK_SECRET_KEY) return respond({ success: false, error: "Paystack payments are temporarily unavailable." }, 500);
      const verified = await paystackVerify(reference);
      if (verified.status === "success") {
        const result = await finalizeVerifiedPayment(reference, verified);
        if (!result?.success) return respond({ success: false, error: result?.message || "The stock reservation expired. Please contact PanBill support with your order number.", order_number: order.order_number, payment_review_required: true }, 409);
        return respond({ success: true, order_id: order.id, order_number: order.order_number, payment_status: "paid" });
      }
      if (verified.status === "failed" || verified.status === "abandoned") {
        const { data: failed, error: failError } = await admin.rpc("marketplace_finalize_checkout_payment", {
          p_reference: reference,
          p_success: false,
          p_provider_reference: clean(verified.id, 100),
          p_provider_response: verified,
        });
        if (failError) throw failError;
        return respond({ success: false, payment_status: "failed", order_number: order.order_number, message: "Payment was not successful." }, 402);
      }
      return respond({ success: false, payment_status: "pending", order_number: order.order_number, message: "Paystack has not confirmed this payment yet. Please check again shortly." }, 202);
    }

    return respond({ success: false, error: "Unknown action. Use create_checkout or verify_payment." }, 400);
  } catch (error) {
    console.error("marketplace-checkout error:", error);
    return respond({ success: false, error: error instanceof Error ? error.message : "Unexpected checkout error." }, 500);
  }
});
