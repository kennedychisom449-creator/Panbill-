
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const slugify = (value: string) => value.toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45);

const cleanText = (value: unknown, max: number) =>
  String(value ?? "").trim().slice(0, max);

const allowedDigitalMime = new Set([
  "application/pdf",
  "application/epub+zip",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
]);

async function verifyStoredDigitalFile(
  adminClient: any,
  sellerId: string,
  productId: string,
  storagePath: string,
) {
  const prefix = `${sellerId}/${productId}/`;

  if (!storagePath.startsWith(prefix)) return false;

  const objectName = storagePath.slice(prefix.length);

  if (!objectName || objectName.includes("/")) return false;

  const { data, error } = await adminClient.storage
    .from("panbill-digital-products")
    .list(`${sellerId}/${productId}`, {
      search: objectName,
      limit: 100,
    });

  if (error) throw error;

  return (data || []).some(
    (file: any) => file.name === objectName && !!file.id
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return respond({ success: false, error: "Server configuration is incomplete." }, 500);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return respond({ success: false, error: "Please sign in first." }, 401);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: authError } = await authClient.auth.getUser();
    const user = userData?.user;

    if (authError || !user) {
      return respond({ success: false, error: "Invalid or expired session." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json();
    const action = String(body.action ?? "register");
    const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY") || "";

    const adminCodActions = new Set(["admin_cod_audit_list", "admin_cod_reinstate_customer"]);
    if (adminCodActions.has(action)) {
      const { data: adminRecord, error: adminLookupError } = await adminClient.from("panbill_admins")
        .select("role").eq("user_id", user.id).maybeSingle();
      if (adminLookupError) throw adminLookupError;
      if (adminRecord?.role !== "admin") return respond({ success: false, error: "Administrator permission required." }, 403);
      if (action === "admin_cod_audit_list") {
        const limit = Math.min(200, Math.max(1, Number(body.limit) || 100));
        const { data, error } = await adminClient.from("marketplace_cod_audit")
          .select("id, order_id, buyer_id, actor_user_id, actor_role, action, reason, old_values, new_values, created_at")
          .order("created_at", { ascending: false }).limit(limit);
        if (error) throw error;
        return respond({ success: true, audit: data || [] });
      }
      const buyerId = cleanText(body.buyer_id, 50);
      const reason = cleanText(body.reason, 500);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(buyerId)) return respond({ success: false, error: "Enter a valid buyer account ID." }, 400);
      if (reason.length < 5) return respond({ success: false, error: "Enter a reinstatement reason of at least 5 characters." }, 400);
      const { data, error } = await authClient.rpc("marketplace_admin_reinstate_customer_cod", { p_buyer_id: buyerId, p_reason: reason });
      if (error) return respond({ success: false, error: error.message }, error.code === "42501" ? 403 : 400);
      return respond({ success: true, result: data, message: "COD access reinstated and audit recorded." });
    }

    const adminDeliveryActions = new Set([
      "admin_delivery_routes_list",
      "admin_delivery_route_save",
    ]);

    if (adminDeliveryActions.has(action)) {
      const { data: adminRecord, error: adminLookupError } = await adminClient
        .from("panbill_admins")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();

      if (adminLookupError) throw adminLookupError;

      if (adminRecord?.role !== "admin") {
        return respond({ success: false, error: "Administrator permission required." }, 403);
      }

      if (action === "admin_delivery_routes_list") {
        const { data, error } = await adminClient
          .from("marketplace_delivery_routes")
          .select("id, origin_state, origin_city, origin_lga, destination_state, destination_city, destination_lga, parcel_size, delivery_fee, is_active, created_at, updated_at")
          .order("origin_state", { ascending: true })
          .order("destination_state", { ascending: true })
          .order("parcel_size", { ascending: true });

        if (error) throw error;
        return respond({ success: true, routes: data ?? [] });
      }

      if (action === "admin_delivery_route_save") {
        const routeId = body.route_id == null || body.route_id === ""
          ? null
          : cleanText(body.route_id, 80);

        if (routeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routeId)) {
          return respond({ success: false, error: "Invalid delivery route ID." }, 400);
        }

        const originState = cleanText(body.origin_state, 100);
        const originLga = cleanText(body.origin_lga, 100);
        const originCity = cleanText(body.origin_city, 100);
        const destinationState = cleanText(body.destination_state, 100);
        const destinationLga = cleanText(body.destination_lga, 100);
        const destinationCity = cleanText(body.destination_city, 100);
        const parcelSize = String(body.parcel_size ?? "");
        const deliveryFee = Number(body.delivery_fee);
        const isActive = body.is_active;
        const reason = cleanText(body.reason, 500);

        if (originState.length < 2 || destinationState.length < 2) {
          return respond({ success: false, error: "Select valid origin and destination states." }, 400);
        }

        if (originLga.length < 2 || destinationLga.length < 2) {
          return respond({ success: false, error: "Select valid origin and destination LGAs." }, 400);
        }

        if (!["small", "medium", "large"].includes(parcelSize)) {
          return respond({ success: false, error: "Select a valid parcel size." }, 400);
        }

        if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 100000000) {
          return respond({ success: false, error: "Enter a valid delivery fee." }, 400);
        }

        if (typeof isActive !== "boolean") {
          return respond({ success: false, error: "Choose whether this route is active." }, 400);
        }

        if (reason.length < 5) {
          return respond({ success: false, error: "Enter a reason of at least 5 characters for the audit log." }, 400);
        }

        const { data, error } = await adminClient.rpc("admin_save_marketplace_delivery_route", {
          p_admin_user_id: user.id,
          p_route_id: routeId,
          p_origin_state: originState,
          p_origin_lga: originLga,
          p_origin_city: originCity || null,
          p_destination_state: destinationState,
          p_destination_lga: destinationLga,
          p_destination_city: destinationCity || null,
          p_parcel_size: parcelSize,
          p_delivery_fee: deliveryFee,
          p_is_active: isActive,
          p_reason: reason,
        });

        if (error) {
          if (error.code === "23505") {
            return respond({ success: false, error: "A route with this origin, destination and parcel size already exists. Edit the existing route instead." }, 409);
          }
          if (error.code === "42501") {
            return respond({ success: false, error: "Administrator permission required." }, 403);
          }
          throw error;
        }

        return respond({
          success: true,
          message: routeId ? "Delivery route updated and audited." : "Delivery route created and audited.",
          route: data,
        }, routeId ? 200 : 201);
      }
    }

    if (["seller_cod_orders_list", "seller_cod_record_outcome", "seller_orders_list", "seller_set_delivery_estimate"].includes(action)) {
      const { data: codSeller, error: codSellerError } = await adminClient.from("marketplace_sellers")
        .select("status").eq("user_id", user.id).maybeSingle();
      if (codSellerError) throw codSellerError;
      if (codSeller?.status !== "approved") return respond({ success: false, error: "An approved seller account is required to manage marketplace orders." }, 403);
    }

    if (action === "seller_orders_list") {
      const orderSelect = "id, order_id, product_id, product_name, quantity, line_total, marketplace_orders!inner(id, order_number, buyer_id, payment_method, payment_provider, payment_status, delivery_payment_status, order_status, fulfillment_type, delivery_method, delivery_name, delivery_phone, delivery_address, delivery_city, delivery_lga, delivery_state, delivery_notes, total_amount, created_at)";
      const [paidResult, codResult] = await Promise.all([
        adminClient.from("marketplace_order_items").select(orderSelect)
          .eq("seller_id", user.id).eq("marketplace_orders.fulfillment_type", "physical")
          .eq("marketplace_orders.payment_status", "paid")
          .order("created_at", { ascending: false }).limit(200),
        adminClient.from("marketplace_order_items").select(orderSelect)
          .eq("seller_id", user.id).eq("marketplace_orders.fulfillment_type", "physical")
          .eq("marketplace_orders.payment_method", "cash_on_delivery")
          .order("created_at", { ascending: false }).limit(200),
      ]);
      if (paidResult.error) throw paidResult.error;
      if (codResult.error) throw codResult.error;
      const byItemId = new Map<string, any>();
      for (const item of [...(paidResult.data || []), ...(codResult.data || [])]) byItemId.set(item.id, item);
      const data = [...byItemId.values()].sort((a: any, b: any) =>
        new Date(b.marketplace_orders?.created_at || 0).getTime() - new Date(a.marketplace_orders?.created_at || 0).getTime()
      ).slice(0, 200);
      const orderIds = [...new Set(data.map((x: any) => x.order_id))];
      let estimates: any[] = [];
      if (orderIds.length) {
        const { data: estimateRows, error: estimateError } = await adminClient.from("marketplace_seller_order_updates")
          .select("order_id, seller_id, delivery_estimate_days, estimated_delivery_at, delivery_status, status_note, updated_at")
          .eq("seller_id", user.id).in("order_id", orderIds);
        if (estimateError) throw estimateError;
        estimates = estimateRows || [];
      }
      const estimateByOrder = new Map(estimates.map((x: any) => [x.order_id, x]));
      return respond({ success: true, items: (data || []).map((x: any) => ({ ...x, seller_update: estimateByOrder.get(x.order_id) || null })) });
    }

    if (action === "seller_set_delivery_estimate") {
      const orderId = cleanText(body.order_id, 50);
      const days = Number(body.delivery_estimate_days);
      const note = cleanText(body.status_note, 500);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) return respond({ success: false, error: "Invalid order ID." }, 400);
      if (!Number.isInteger(days) || days < 1 || days > 90) return respond({ success: false, error: "Delivery estimate must be between 1 and 90 days." }, 400);
      const { data: ownedItems, error: ownedError } = await adminClient.from("marketplace_order_items")
        .select("id, order_id, seller_id, marketplace_orders!inner(id, buyer_id, fulfillment_type, payment_method, payment_status, order_number)")
        .eq("order_id", orderId).eq("seller_id", user.id).eq("marketplace_orders.fulfillment_type", "physical");
      if (ownedError) throw ownedError;
      if (!ownedItems?.length) return respond({ success: false, error: "This physical order does not belong to your seller account." }, 403);
      const order = ownedItems[0].marketplace_orders;
      if (order.payment_status !== "paid" && order.payment_method !== "cash_on_delivery") return respond({ success: false, error: "Only paid online orders and Cash on Delivery orders can receive a delivery estimate." }, 409);
      const estimatedAt = new Date(Date.now() + days * 86400000).toISOString();
      const { error: saveError } = await adminClient.from("marketplace_seller_order_updates").upsert({
        order_id: orderId, seller_id: user.id, delivery_estimate_days: days,
        estimated_delivery_at: estimatedAt, delivery_status: "processing", status_note: note || null, updated_at: new Date().toISOString(),
      }, { onConflict: "order_id,seller_id" });
      if (saveError) throw saveError;
      const { data: buyerResult, error: buyerError } = await adminClient.auth.admin.getUserById(order.buyer_id);
      if (buyerError) throw buyerError;
      const buyerEmail = cleanText(buyerResult?.user?.email, 254).toLowerCase();
      const { data: sellerProfile, error: sellerProfileError } = await adminClient.from("marketplace_sellers")
        .select("business_name").eq("user_id", user.id).maybeSingle();
      if (sellerProfileError) throw sellerProfileError;
      if (buyerEmail) {
        const eventKey = `delivery_estimate:${orderId}:${user.id}:${days}:${Date.now()}`;
        const { error: queueError } = await adminClient.from("marketplace_email_events").insert({
          event_key: eventKey, order_id: orderId, recipient_user_id: order.buyer_id,
          recipient_email: buyerEmail, recipient_role: "buyer", event_type: "delivery_estimate_updated",
          payload: { order_number: order.order_number, delivery_estimate_days: days, estimated_delivery_at: estimatedAt, seller_name: sellerProfile?.business_name || "Your PanBill seller", status_note: note || "" },
        });
        if (queueError) throw queueError;
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        await fetch(`${supabaseUrl}/functions/v1/marketplace-email-worker`, { method: "POST", headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, body: "{}" }).catch((e) => console.error("Email worker invoke failed:", e));
      }
      return respond({ success: true, delivery_estimate_days: days, estimated_delivery_at: estimatedAt, message: "Delivery estimate saved. The buyer notification has been queued." });
    }

    if (action === "seller_cod_orders_list") {
      const { data, error } = await adminClient.from("marketplace_order_items")
        .select("id, order_id, product_id, product_name, quantity, line_total, marketplace_orders!inner(id, order_number, buyer_id, payment_method, payment_provider, payment_status, delivery_payment_status, order_status, fulfillment_type, delivery_method, delivery_name, delivery_phone, delivery_address, delivery_city, delivery_lga, delivery_state, delivery_notes, total_amount, created_at)")
        .eq("seller_id", user.id).eq("marketplace_orders.payment_method", "cash_on_delivery")
        .eq("marketplace_orders.fulfillment_type", "physical").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return respond({ success: true, items: data || [] });
    }

    if (action === "seller_cod_record_outcome") {
      const orderId = cleanText(body.order_id, 50), outcome = cleanText(body.outcome, 40), reason = cleanText(body.reason, 500);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) return respond({ success: false, error: "Invalid order ID." }, 400);
      if (!["collected", "refused", "delivery_failed", "seller_cancelled"].includes(outcome)) return respond({ success: false, error: "Choose a valid COD outcome." }, 400);
      if (reason.length < 5) return respond({ success: false, error: "Enter a reason of at least 5 characters." }, 400);
      const { data, error } = await authClient.rpc("marketplace_seller_record_cod_outcome", { p_order_id: orderId, p_outcome: outcome, p_reason: reason });
      if (error) return respond({ success: false, error: error.message }, error.code === "42501" ? 403 : 400);
      return respond({ success: true, result: data, message: "COD outcome recorded and audited." });
    }

    if (action === "status") {
      const { data, error } = await adminClient.from("marketplace_sellers")
        .select("user_id, business_name, slug, status, commission_rate, created_at, approved_at, dispatch_state, dispatch_lga, dispatch_city, dispatch_location_status, dispatch_location_reviewed_at, dispatch_location_review_note, cash_on_delivery_enabled")
        .eq("user_id", user.id).maybeSingle();

      if (error) throw error;
      return respond({ success: true, seller: data });
    }

    if (action === "register") {
      const businessName = cleanText(body.business_name, 100);
      const businessDescription = cleanText(body.business_description, 2000);
      const contactEmail = cleanText(body.contact_email ?? user.email, 254).toLowerCase();
      const contactPhone = cleanText(body.contact_phone, 30);
      const businessAddress = cleanText(body.business_address, 300);

      if (businessName.length < 2) {
        return respond({ success: false, error: "Business name must be between 2 and 100 characters." }, 400);
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
        return respond({ success: false, error: "Enter a valid contact email." }, 400);
      }

      const { data: existing, error: existingError } = await adminClient.from("marketplace_sellers")
        .select("user_id, business_name, slug, status").eq("user_id", user.id).maybeSingle();

      if (existingError) throw existingError;
      if (existing) return respond({ success: false, error: "You already have a seller application.", seller: existing }, 409);

      const slug = `${slugify(businessName) || "seller"}-${crypto.randomUUID().slice(0, 8)}`;

      const { data: seller, error: insertError } = await adminClient.from("marketplace_sellers").insert({
        user_id: user.id,
        business_name: businessName,
        slug,
        business_description: businessDescription || null,
        contact_email: contactEmail,
        contact_phone: contactPhone || null,
        business_address: businessAddress || null,
        status: "pending",
      }).select("user_id, business_name, slug, status, commission_rate, created_at").single();

      if (insertError) throw insertError;
      return respond({ success: true, message: "Your seller application has been submitted for review.", seller }, 201);
    }

    if (action === "submit_dispatch_location") {
      const dispatchState = cleanText(body.dispatch_state, 100);
      const dispatchLga = cleanText(body.dispatch_lga, 100);
      const dispatchCity = cleanText(body.dispatch_city, 100);

      if (dispatchState.length < 2) return respond({ success: false, error: "Select your dispatch state." }, 400);
      if (dispatchLga.length < 2) return respond({ success: false, error: "Select your Local Government Area." }, 400);
      if (dispatchCity.length < 2) return respond({ success: false, error: "Enter your dispatch town or city." }, 400);

      const { data: seller, error: sellerError } = await adminClient.from("marketplace_sellers")
        .select("user_id, dispatch_state, dispatch_lga, dispatch_city, dispatch_location_status")
        .eq("user_id", user.id).maybeSingle();

      if (sellerError) throw sellerError;
      if (!seller) return respond({ success: false, error: "Submit your seller application before adding a dispatch location." }, 404);

      const { data: state, error: stateError } = await adminClient.from("marketplace_delivery_states")
        .select("state_name").ilike("state_name", dispatchState).eq("is_active", true).maybeSingle();

      if (stateError) throw stateError;
      if (!state) return respond({ success: false, error: "Choose a valid active Nigerian state or the Federal Capital Territory." }, 400);

      const sameLocation =
        (seller.dispatch_state ?? "").toLowerCase() === state.state_name.toLowerCase() &&
        (seller.dispatch_lga ?? "").toLowerCase() === dispatchLga.toLowerCase() &&
        (seller.dispatch_city ?? "").toLowerCase() === dispatchCity.toLowerCase();

      if (sameLocation && seller.dispatch_location_status === "approved") {
        return respond({ success: true, message: "This dispatch location is already approved. No changes were made.", seller });
      }

      const { data: updatedSeller, error: updateError } = await adminClient.from("marketplace_sellers")
        .update({
          dispatch_state: state.state_name,
          dispatch_lga: dispatchLga,
          dispatch_city: dispatchCity,
          dispatch_location_status: "pending",
          dispatch_location_reviewed_at: null,
          dispatch_location_reviewed_by: null,
          dispatch_location_review_note: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .select("user_id, business_name, dispatch_state, dispatch_lga, dispatch_city, dispatch_location_status, dispatch_location_reviewed_at, dispatch_location_review_note")
        .single();

      if (updateError) throw updateError;

      return respond({
        success: true,
        message: "Dispatch location submitted. It must be approved by an administrator before it can be used for delivery calculations.",
        seller: updatedSeller,
      });
    }

    if (action === "digital_orders_list") {
      const { data, error } = await adminClient.from("marketplace_order_items")
        .select("id, order_id, product_id, product_name, quantity, line_total, marketplace_orders!inner(order_number, payment_status, fulfillment_type, buyer_id, paid_at)")
        .eq("marketplace_orders.buyer_id", user.id)
        .eq("marketplace_orders.payment_status", "paid")
        .eq("marketplace_orders.fulfillment_type", "digital")
        .order("created_at", { ascending: false }).limit(100);

      if (error) throw error;
      return respond({ success: true, purchases: data || [] });
    }

    if (action === "digital_delivery_details") {
      const orderItemId = cleanText(body.order_item_id, 50);

      const { data: item, error: itemError } = await adminClient.from("marketplace_order_items")
        .select("id, order_id, product_id, seller_id, marketplace_orders!inner(buyer_id, payment_status, fulfillment_type)")
        .eq("id", orderItemId).maybeSingle();

      if (itemError) throw itemError;

      const order = (item as any)?.marketplace_orders;

      if (!item || !order || order.buyer_id !== user.id || order.payment_status !== "paid" || order.fulfillment_type !== "digital") {
        return respond({ success: false, error: "A paid digital order for this account is required." }, 403);
      }

      const [{ data: product, error: productError }, { data: links, error: linksError }] = await Promise.all([
        adminClient.from("marketplace_products").select("digital_delivery_mode, digital_delivery_url").eq("id", item.product_id).maybeSingle(),
        adminClient.from("marketplace_seller_social_links").select("platform, url, is_primary").eq("seller_id", item.seller_id).order("is_primary", { ascending: false }),
      ]);

      if (productError) throw productError;
      if (linksError) throw linksError;

      return respond({
        success: true,
        delivery_mode: product?.digital_delivery_mode || "file",
        delivery_url: product?.digital_delivery_url || null,
        social_links: links || [],
      });
    }

    if (action === "digital_download") {
      const orderItemId = cleanText(body.order_item_id, 50);

      const { data: item, error: itemError } = await adminClient.from("marketplace_order_items")
        .select("id, order_id, product_id, seller_id, marketplace_orders!inner(id, buyer_id, payment_status, fulfillment_type)")
        .eq("id", orderItemId).maybeSingle();

      if (itemError) throw itemError;

      const order = (item as any)?.marketplace_orders;

      if (!item || !order || order.buyer_id !== user.id || order.payment_status !== "paid" || order.fulfillment_type !== "digital") {
        return respond({ success: false, error: "A paid digital order for this account is required." }, 403);
      }

      const { data: assets, error: assetError } = await adminClient.from("marketplace_digital_assets")
        .select("id, storage_path, file_name")
        .eq("product_id", item.product_id)
        .eq("seller_id", item.seller_id)
        .order("is_primary", { ascending: false })
        .limit(1);

      if (assetError) throw assetError;
      if (!assets?.length) return respond({ success: false, error: "The seller has not uploaded a downloadable file for this product." }, 404);

      const asset = assets[0];

      const fileExists = await verifyStoredDigitalFile(
        adminClient,
        item.seller_id,
        item.product_id,
        asset.storage_path,
      );

      if (!fileExists) {
        return respond({ success: false, error: "The digital file is temporarily unavailable. Please contact the seller." }, 404);
      }

      const { data: signed, error: signedError } = await adminClient.storage
        .from("panbill-digital-products")
        .createSignedUrl(asset.storage_path, 180);

      if (signedError) throw signedError;

      const { error: auditError } = await adminClient.from("marketplace_digital_downloads").upsert({
        order_id: item.order_id,
        order_item_id: item.id,
        product_id: item.product_id,
        buyer_id: user.id,
        asset_id: asset.id,
        download_count: 1,
        last_downloaded_at: new Date().toISOString(),
      }, { onConflict: "order_item_id,asset_id" });

      if (auditError) throw auditError;

      return respond({
        success: true,
        download_url: signed.signedUrl,
        file_name: asset.file_name,
        expires_in_seconds: 180,
      });
    }

    const { data: seller, error: sellerError } = await adminClient.from("marketplace_sellers")
      .select("user_id, status").eq("user_id", user.id).maybeSingle();

    if (sellerError) throw sellerError;

    if (!seller || seller.status !== "approved") {
      return respond({ success: false, error: "Only approved sellers can manage products." }, 403);
    }

    if (action === "banks_list") {
      if (!PAYSTACK_SECRET_KEY) return respond({ success: false, error: "Bank verification is not configured yet." }, 503);

      const r = await fetch("https://api.paystack.co/bank?country=nigeria&currency=NGN&type=nuban&perPage=300", {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      });

      const j = await r.json().catch(() => ({}));

      if (!r.ok || j.status !== true) throw new Error(cleanText(j.message, 250) || "Could not load Nigerian banks.");

      return respond({
        success: true,
        banks: (j.data || []).map((b: any) => ({
          name: cleanText(b.name, 100),
          code: cleanText(b.code, 20),
        })),
      });
    }

    if (action === "bank_verify") {
      if (!PAYSTACK_SECRET_KEY) return respond({ success: false, error: "Bank verification is not configured yet." }, 503);

      const bankCode = cleanText(body.bank_code, 20);
      const accountNumber = cleanText(body.account_number, 10);

      if (!/^\d{10}$/.test(accountNumber) || !bankCode) {
        return respond({ success: false, error: "Enter a valid 10-digit Nigerian account number and select a bank." }, 400);
      }

      const resolveResponse = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } },
      );

      const resolved = await resolveResponse.json().catch(() => ({}));

      if (!resolveResponse.ok || resolved.status !== true || !resolved.data?.account_name) {
        return respond({ success: false, error: cleanText(resolved.message, 250) || "Paystack could not verify this bank account." }, 400);
      }

      const bankResponse = await fetch("https://api.paystack.co/bank?country=nigeria&currency=NGN&type=nuban&perPage=300", {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      });

      const bankJson = await bankResponse.json().catch(() => ({}));
      const bank = (bankJson.data || []).find((b: any) => String(b.code) === bankCode);

      if (!bank) return respond({ success: false, error: "The selected bank is not recognized by Paystack." }, 400);

      const recipientResponse = await fetch("https://api.paystack.co/transferrecipient", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "nuban",
          name: resolved.data.account_name,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: "NGN",
        }),
      });

      const recipient = await recipientResponse.json().catch(() => ({}));

      if (!recipientResponse.ok || recipient.status !== true || !recipient.data?.recipient_code) {
        throw new Error(cleanText(recipient.message, 250) || "Paystack could not create a payout recipient.");
      }

      const { error } = await adminClient.from("marketplace_seller_payout_profiles").upsert({
        seller_id: user.id,
        bank_code: bankCode,
        bank_name: cleanText(bank.name, 100),
        account_name: cleanText(resolved.data.account_name, 150),
        account_number_last4: accountNumber.slice(-4),
        recipient_code: recipient.data.recipient_code,
        currency: "NGN",
        verification_status: "verified",
        verified_at: new Date().toISOString(),
        payout_enabled: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "seller_id" });

      if (error) throw error;

      return respond({
        success: true,
        verified: true,
        payout_enabled: false,
        account_name: resolved.data.account_name,
        bank_name: bank.name,
        account_number_last4: accountNumber.slice(-4),
        message: "Bank account verified. Confirm the displayed account name before enabling payouts.",
      });
    }

    if (action === "bank_payout_enable") {
      const confirmation = cleanText(body.confirm_account_name, 150).toLowerCase();

      const { data: profile, error } = await adminClient.from("marketplace_seller_payout_profiles")
        .select("account_name, verification_status").eq("seller_id", user.id).maybeSingle();

      if (error) throw error;

      if (!profile || profile.verification_status !== "verified") {
        return respond({ success: false, error: "Verify your bank account first." }, 400);
      }

      if (!confirmation || confirmation !== String(profile.account_name).toLowerCase()) {
        return respond({ success: false, error: "Type the verified account name exactly to confirm the payout destination." }, 400);
      }

      const { error: updateError } = await adminClient.from("marketplace_seller_payout_profiles")
        .update({ payout_enabled: true, updated_at: new Date().toISOString() }).eq("seller_id", user.id);

      if (updateError) throw updateError;

      return respond({ success: true, payout_enabled: true, message: "Automatic payouts enabled for this verified bank account." });
    }

    if (action === "bank_profile") {
      const { data, error } = await adminClient.from("marketplace_seller_payout_profiles")
        .select("bank_name, account_name, account_number_last4, verification_status, payout_enabled, verified_at")
        .eq("seller_id", user.id).maybeSingle();

      if (error) throw error;
      return respond({ success: true, payout_profile: data });
    }

    if (action === "social_links_list") {
      const { data, error } = await adminClient.from("marketplace_seller_social_links")
        .select("id, platform, url, is_primary").eq("seller_id", user.id).order("is_primary", { ascending: false });

      if (error) throw error;
      return respond({ success: true, links: data || [] });
    }

    if (action === "social_link_save") {
      const platform = cleanText(body.platform, 20).toLowerCase();
      const url = cleanText(body.url, 500);
      const allowed = ["instagram", "facebook", "tiktok", "youtube", "whatsapp", "telegram", "x", "website", "other"];

      let parsed: URL;

      try {
        parsed = new URL(url);
      } catch {
        return respond({ success: false, error: "Enter a valid social-media URL." }, 400);
      }

      if (!allowed.includes(platform) || parsed.protocol !== "https:") {
        return respond({ success: false, error: "Choose a supported platform and use an HTTPS link." }, 400);
      }

      const { data, error } = await adminClient.from("marketplace_seller_social_links").upsert({
        seller_id: user.id,
        platform,
        url,
        is_primary: body.is_primary === true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "seller_id,platform" }).select("id, platform, url, is_primary").single();

      if (error) throw error;
      return respond({ success: true, link: data });
    }

    if (action === "digital_upload_prepare") {
      const productId = cleanText(body.product_id, 50);
      const fileName = cleanText(body.file_name, 180).replace(/[\\/]/g, "_");
      const mimeType = cleanText(body.mime_type, 120).toLowerCase();
      const sizeBytes = Number(body.size_bytes);

      if (!productId || !fileName || !allowedDigitalMime.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 104857600) {
        return respond({ success: false, error: "File must be an allowed document/media format and no larger than 100 MB." }, 400);
      }

      const { data: product, error: productError } = await adminClient.from("marketplace_products")
        .select("id, product_type").eq("id", productId).eq("seller_id", user.id).maybeSingle();

      if (productError) throw productError;
      if (!product || product.product_type !== "digital") return respond({ success: false, error: "Choose one of your digital products." }, 404);

      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
      const path = `${user.id}/${productId}/${crypto.randomUUID()}-${safeName}`;

      const { data, error } = await adminClient.storage.from("panbill-digital-products").createSignedUploadUrl(path);

      if (error) throw error;

      return respond({
        success: true,
        path,
        token: data.token,
        signed_url: data.signedUrl,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: sizeBytes,
      });
    }

    if (action === "digital_asset_register") {
      const productId = cleanText(body.product_id, 50);
      const path = cleanText(body.path, 500);
      const fileName = cleanText(body.file_name, 180);
      const mimeType = cleanText(body.mime_type, 120).toLowerCase();
      const sizeBytes = Number(body.size_bytes);

      const prefix = `${user.id}/${productId}/`;
      const objectName = path.startsWith(prefix) ? path.slice(prefix.length) : "";

      if (
        !productId ||
        !objectName ||
        objectName.includes("/") ||
        !fileName ||
        !allowedDigitalMime.has(mimeType) ||
        !Number.isInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > 104857600
      ) {
        return respond({ success: false, error: "Invalid digital file upload details." }, 400);
      }

      const { data: product, error: productError } = await adminClient.from("marketplace_products")
        .select("id, product_type, digital_delivery_mode")
        .eq("id", productId)
        .eq("seller_id", user.id)
        .maybeSingle();

      if (productError) throw productError;
      if (!product || product.product_type !== "digital") {
        return respond({ success: false, error: "Digital product not found in your shop." }, 404);
      }

      // Verify that the exact object exists before recording its metadata.
      const fileExists = await verifyStoredDigitalFile(adminClient, user.id, productId, path);

      if (!fileExists) {
        return respond({
          success: false,
          error: "The uploaded file was not found in secure storage. Upload it successfully before registering it.",
        }, 400);
      }

      const { error: insertError } = await adminClient.from("marketplace_digital_assets").insert({
        product_id: productId,
        seller_id: user.id,
        storage_path: path,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        is_primary: true,
      });

      if (insertError) throw insertError;

      // Activate only after verifying the uploaded file and registering it.
      const { error: activateError } = await adminClient.from("marketplace_products")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", productId)
        .eq("seller_id", user.id);

      if (activateError) {
        await adminClient.from("marketplace_digital_assets")
          .delete()
          .eq("product_id", productId)
          .eq("seller_id", user.id)
          .eq("storage_path", path);

        throw activateError;
      }

      return respond({
        success: true,
        message: "Digital file verified in secure storage and successfully attached. Your product is now active.",
      }, 201);
    }

    if (action === "digital_assets_list") {
      const productId = cleanText(body.product_id, 50);

      const { data, error } = await adminClient.from("marketplace_digital_assets")
        .select("id, file_name, mime_type, size_bytes, is_primary, created_at")
        .eq("seller_id", user.id)
        .eq("product_id", productId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return respond({ success: true, assets: data || [] });
    }

    if (action === "categories") {
      const { data, error } = await adminClient.from("marketplace_categories")
        .select("id, name, slug").eq("is_active", true).order("display_order", { ascending: true });

      if (error) throw error;
      return respond({ success: true, categories: data ?? [] });
    }

    if (action === "products_list") {
      const { data, error } = await adminClient.from("marketplace_products")
        .select("id, seller_id, category_id, name, slug, description, price, regular_price, discount_percent, stock_quantity, images, product_type, status, created_at, updated_at, parcel_size, digital_delivery_mode, digital_delivery_url")
        .eq("seller_id", user.id).order("created_at", { ascending: false });

      if (error) throw error;
      return respond({ success: true, products: data ?? [] });
    }

    if (action === "seller_discount_set") {
      const productId = cleanText(body.product_id, 80);
      const discountPercent = Number(body.discount_percent);
      if (!productId) return respond({ success: false, error: "Product ID is required." }, 400);
      if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 90) {
        return respond({ success: false, error: "Choose a whole-number discount from 0% to 90%. Use 0% to remove the discount." }, 400);
      }

      const { data: sellerProfile, error: sellerError } = await adminClient.from("marketplace_sellers")
        .select("status").eq("user_id", user.id).maybeSingle();
      if (sellerError) throw sellerError;
      if (sellerProfile?.status !== "approved") return respond({ success: false, error: "An approved seller account is required to manage promotions." }, 403);

      const { data: product, error: productError } = await adminClient.from("marketplace_products")
        .select("id, price, regular_price, discount_percent")
        .eq("id", productId).eq("seller_id", user.id).maybeSingle();
      if (productError) throw productError;
      if (!product) return respond({ success: false, error: "Product not found in your shop." }, 404);

      const regularPrice = Number(product.regular_price || product.price);
      let updates: Record<string, unknown>;
      if (discountPercent === 0) {
        updates = { price: regularPrice, regular_price: null, discount_percent: 0, updated_at: new Date().toISOString() };
      } else {
        const discountedPrice = Math.round((regularPrice * (100 - discountPercent) / 100) * 100) / 100;
        if (!Number.isFinite(regularPrice) || regularPrice <= 0 || !Number.isFinite(discountedPrice) || discountedPrice <= 0 || discountedPrice >= regularPrice) {
          return respond({ success: false, error: "This product price is too low for the selected discount. Choose a smaller percentage." }, 400);
        }
        updates = { regular_price: regularPrice, price: discountedPrice, discount_percent: discountPercent, updated_at: new Date().toISOString() };
      }

      const { data: updated, error: updateError } = await adminClient.from("marketplace_products")
        .update(updates).eq("id", productId).eq("seller_id", user.id)
        .select("id, seller_id, name, price, regular_price, discount_percent, product_type, stock_quantity, status")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return respond({ success: false, error: "Product not found in your shop." }, 404);
      return respond({ success: true, product: updated, message: discountPercent === 0 ? "Discount removed. The original price has been restored." : `${discountPercent}% discount is now active on this product.` });
    }

    if (action === "product_create") {
      const name = cleanText(body.name, 120);
      const description = cleanText(body.description, 5000);
      const price = Number(body.price);
      const stock = Number(body.stock_quantity);
      const productType = String(body.product_type ?? "physical");
      const parcelSize = String(body.parcel_size ?? "medium");
      const categoryId = body.category_id ? String(body.category_id) : null;
      const images = Array.isArray(body.images) ? body.images.slice(0, 5).map((x: unknown) => cleanText(x, 1000)) : [];

      if (name.length < 2) return respond({ success: false, error: "Product name must be between 2 and 120 characters." }, 400);
      if (!Number.isFinite(price) || price <= 0 || price > 100000000) return respond({ success: false, error: "Enter a valid product price." }, 400);
      if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) return respond({ success: false, error: "Enter a valid stock quantity." }, 400);
      if (!["physical", "digital"].includes(productType)) return respond({ success: false, error: "Invalid product type." }, 400);

      const deliveryMode = String(body.digital_delivery_mode ?? "file");
      const deliveryUrl = cleanText(body.digital_delivery_url, 500);

      if (productType === "digital" && !["file", "social", "both"].includes(deliveryMode)) {
        return respond({ success: false, error: "Choose file, social or both digital delivery." }, 400);
      }

      if (productType === "digital" && ["social", "both"].includes(deliveryMode)) {
        try {
          const parsed = new URL(deliveryUrl);
          if (parsed.protocol !== "https:") throw new Error();
        } catch {
          return respond({ success: false, error: "Enter a valid HTTPS digital delivery link." }, 400);
        }
      }

      if (!["small", "medium", "large"].includes(parcelSize)) return respond({ success: false, error: "Invalid parcel size." }, 400);

      if (images.some((url: string) => {
        try { return new URL(url).protocol !== "https:"; } catch { return true; }
      })) {
        return respond({ success: false, error: "Product image links must be valid HTTPS URLs." }, 400);
      }

      if (categoryId) {
        const { data: category, error } = await adminClient.from("marketplace_categories")
          .select("id").eq("id", categoryId).eq("is_active", true).maybeSingle();

        if (error) throw error;
        if (!category) return respond({ success: false, error: "Choose an active marketplace category." }, 400);
      }

      const slug = `${slugify(name) || "product"}-${crypto.randomUUID().slice(0, 8)}`;

      const { data, error } = await adminClient.from("marketplace_products").insert({
        seller_id: user.id,
        category_id: categoryId,
        name,
        slug,
        description: description || null,
        price,
        stock_quantity: stock,
        images,
        product_type: productType,
        parcel_size: productType === "physical" ? parcelSize : null,
        digital_delivery_mode: productType === "digital" ? deliveryMode : "file",
        digital_delivery_url: productType === "digital" ? (deliveryUrl || null) : null,
        status: productType === "digital" && ["file", "both"].includes(deliveryMode) ? "inactive" : "active",
      }).select("id, seller_id, category_id, name, slug, description, price, regular_price, discount_percent, stock_quantity, images, product_type, status, created_at, updated_at, parcel_size, digital_delivery_mode, digital_delivery_url").single();

      if (error) throw error;
      return respond({ success: true, message: "Product added to your shop.", product: data }, 201);
    }

    if (action === "product_update") {
      const productId = cleanText(body.product_id, 80);
      if (!productId) return respond({ success: false, error: "Product ID is required." }, 400);

      const { data: currentProduct, error: currentError } = await adminClient.from("marketplace_products")
        .select("id, price, regular_price, discount_percent, product_type, digital_delivery_mode, digital_delivery_url, status")
        .eq("id", productId)
        .eq("seller_id", user.id)
        .maybeSingle();

      if (currentError) throw currentError;
      if (!currentProduct) return respond({ success: false, error: "Product not found in your shop." }, 404);

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (body.name !== undefined) {
        const name = cleanText(body.name, 120);
        if (name.length < 2) return respond({ success: false, error: "Product name must be between 2 and 120 characters." }, 400);
        updates.name = name;
      }

      if (body.description !== undefined) updates.description = cleanText(body.description, 5000) || null;

      if (body.price !== undefined) {
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0 || price > 100000000) return respond({ success: false, error: "Enter a valid product price." }, 400);
        const activeDiscount = Number(currentProduct.discount_percent || 0);
        if (activeDiscount > 0) {
          const discountedPrice = Math.round((price * (100 - activeDiscount) / 100) * 100) / 100;
          if (discountedPrice <= 0 || discountedPrice >= price) return respond({ success: false, error: "The new regular price is too low for the active discount. Remove or reduce the discount first." }, 400);
          updates.regular_price = price;
          updates.price = discountedPrice;
        } else {
          updates.price = price;
          updates.regular_price = null;
        }
      }

      if (body.stock_quantity !== undefined) {
        const stock = Number(body.stock_quantity);
        if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) return respond({ success: false, error: "Enter a valid stock quantity." }, 400);
        updates.stock_quantity = stock;
      }

      if (body.product_type !== undefined) {
        if (!["physical", "digital"].includes(String(body.product_type))) return respond({ success: false, error: "Invalid product type." }, 400);
        updates.product_type = String(body.product_type);
      }

      if (body.parcel_size !== undefined) {
        if (!["small", "medium", "large"].includes(String(body.parcel_size))) return respond({ success: false, error: "Invalid parcel size." }, 400);
        updates.parcel_size = String(body.parcel_size);
      }

      if (body.digital_delivery_mode !== undefined) {
        if (!["file", "social", "both"].includes(String(body.digital_delivery_mode))) return respond({ success: false, error: "Choose file, social or both delivery." }, 400);
        updates.digital_delivery_mode = String(body.digital_delivery_mode);
      }

      if (body.digital_delivery_url !== undefined) {
        const deliveryUrl = cleanText(body.digital_delivery_url, 500);

        if (deliveryUrl) {
          try {
            if (new URL(deliveryUrl).protocol !== "https:") throw new Error();
          } catch {
            return respond({ success: false, error: "Digital delivery link must be a valid HTTPS URL." }, 400);
          }
        }

        updates.digital_delivery_url = deliveryUrl || null;
      }

      if (body.status !== undefined) {
        if (!["active", "inactive"].includes(String(body.status))) return respond({ success: false, error: "Invalid product status." }, 400);
        updates.status = String(body.status);
      }

      if (body.category_id !== undefined) {
        const categoryId = body.category_id ? String(body.category_id) : null;

        if (categoryId) {
          const { data: category, error } = await adminClient.from("marketplace_categories")
            .select("id").eq("id", categoryId).eq("is_active", true).maybeSingle();

          if (error) throw error;
          if (!category) return respond({ success: false, error: "Choose an active marketplace category." }, 400);
        }

        updates.category_id = categoryId;
      }

      if (body.images !== undefined) {
        const images = Array.isArray(body.images) ? body.images.slice(0, 5).map((x: unknown) => cleanText(x, 1000)) : [];

        if (images.some((url: string) => {
          try { return new URL(url).protocol !== "https:"; } catch { return true; }
        })) {
          return respond({ success: false, error: "Product image links must be valid HTTPS URLs." }, 400);
        }

        updates.images = images;
      }

      const nextType = String(updates.product_type ?? currentProduct.product_type);
      const nextMode = String(updates.digital_delivery_mode ?? currentProduct.digital_delivery_mode ?? "file");
      const nextUrl = String(updates.digital_delivery_url ?? currentProduct.digital_delivery_url ?? "");
      const requestedStatus = String(updates.status ?? currentProduct.status);

      if (nextType === "digital") {
        if (!["file", "social", "both"].includes(nextMode)) {
          return respond({ success: false, error: "Choose a valid digital delivery mode." }, 400);
        }

        if (["social", "both"].includes(nextMode)) {
          try {
            if (new URL(nextUrl).protocol !== "https:") throw new Error();
          } catch {
            return respond({ success: false, error: "A valid HTTPS delivery URL is required for social delivery." }, 400);
          }
        }

        if (["file", "both"].includes(nextMode)) {
          const { data: assets, error: assetError } = await adminClient.from("marketplace_digital_assets")
            .select("storage_path")
            .eq("product_id", productId)
            .eq("seller_id", user.id);

          if (assetError) throw assetError;

          let validAssetFound = false;

          for (const asset of assets || []) {
            if (await verifyStoredDigitalFile(adminClient, user.id, productId, asset.storage_path)) {
              validAssetFound = true;
              break;
            }
          }

          if (!validAssetFound) {
            if (requestedStatus === "active") {
              return respond({ success: false, error: "Upload and register a valid digital file before activating this product." }, 400);
            }
            updates.status = "inactive";
          }
        }
      }

      const { data, error } = await adminClient.from("marketplace_products").update(updates)
        .eq("id", productId)
        .eq("seller_id", user.id)
        .select("id, seller_id, category_id, name, slug, description, price, regular_price, discount_percent, stock_quantity, images, product_type, status, created_at, updated_at, parcel_size, digital_delivery_mode, digital_delivery_url")
        .maybeSingle();

      if (error) throw error;
      if (!data) return respond({ success: false, error: "Product not found in your shop." }, 404);

      return respond({ success: true, message: "Product updated successfully.", product: data });
    }

    if (action === "product_delete") {
      const productId = cleanText(body.product_id, 80);
      if (!productId) return respond({ success: false, error: "Product ID is required." }, 400);

      const { data, error } = await adminClient.from("marketplace_products")
        .update({ status: "inactive", updated_at: new Date().toISOString() })
        .eq("id", productId)
        .eq("seller_id", user.id)
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!data) return respond({ success: false, error: "Product not found in your shop." }, 404);

      return respond({ success: true, message: "Product removed from your active shop listings." });
    }

    return respond({ success: false, error: "Unknown action." }, 400);

  } catch (error) {
    console.error("Marketplace seller function error:", error);
    return respond({
      success: false,
      error: "Unable to process your marketplace request. Please try again.",
    }, 500);
  }
});
