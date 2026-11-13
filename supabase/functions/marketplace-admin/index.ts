import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const adminDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SUPER_ADMIN_USER_ID = "1433a058-8a3c-42dd-ad14-fa9bb7d35084";
const AGENT_DASHBOARD_URL = "https://panbill.com.ng/agent.html";

const ORDER_FIELDS =
  "id,order_number,buyer_id,payment_reference,delivery_method,pickup_point_id,fulfillment_type,order_status,payment_status,payment_provider,payment_method,delivery_payment_status,delivery_name,delivery_phone,delivery_address,delivery_city,delivery_lga,delivery_state,delivery_notes,total_amount";

function cleanText(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isEligibleOrderForAssignment(order: any): boolean {
  if (
    order.fulfillment_type !== "physical" ||
    order.order_status === "cancelled" ||
    order.order_status === "delivered"
  ) {
    return false;
  }

  // Online Paystack orders must have verified payment.
  if (order.payment_method === "online") {
    return (
      order.payment_provider === "paystack" &&
      order.payment_status === "paid" &&
      order.delivery_payment_status === "not_applicable"
    );
  }

  // COD orders can be assigned while payment is pending.
  if (order.payment_method === "cash_on_delivery" || order.payment_method === "pay_on_delivery") {
    return (
      (order.payment_status === "pending" &&
        order.delivery_payment_status === "pending") ||
      (order.payment_status === "paid" &&
        order.delivery_payment_status === "collected")
    );
  }

  return false;
}

async function requireSuperAdmin(userId: string) {
  if (userId !== SUPER_ADMIN_USER_ID) throw new Error("Super Admin access required.");
  const { data, error } = await adminDb
    .from("panbill_admins")
    .select("user_id,role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Super Admin access required.");
}

async function getAgent(userId: string) {
  const { data, error } = await adminDb
    .from("marketplace_fulfillment_agents")
    .select("id,user_id,full_name,phone,agent_type,pickup_point_id,is_active")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active) throw new Error("Active fulfillment agent account not found.");
  return data;
}

async function queueBuyerEmail(order: any, eventType: string, eventKey: string, extra: Record<string, unknown> = {}) {
  const { data: authData, error: authError } = await adminDb.auth.admin.getUserById(order.buyer_id);
  if (authError) throw authError;
  const email = authData.user?.email;
  if (!email) return;

  const payload = {
    order_number: order.order_number,
    delivery_method: order.delivery_method,
    delivery_name: order.delivery_name,
    delivery_phone: order.delivery_phone,
    delivery_address: order.delivery_address,
    delivery_city: order.delivery_city,
    delivery_lga: order.delivery_lga,
    delivery_state: order.delivery_state,
    total_amount: order.total_amount,
    ...extra,
  };

  const { error } = await adminDb.from("marketplace_email_events").upsert(
    {
      event_key: eventKey,
      order_id: order.id,
      recipient_user_id: order.buyer_id,
      recipient_email: email,
      recipient_role: "buyer",
      event_type: eventType,
      payload,
      status: "queued",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "event_key", ignoreDuplicates: true },
  );
  if (error) throw error;
}

async function adminCreateAgent(body: any, actorId: string) {
  await requireSuperAdmin(actorId);
  const email = cleanText(body.email, 254).toLowerCase();
  const fullName = cleanText(body.full_name, 120);
  const phone = cleanText(body.phone, 40);
  const agentType = cleanText(body.agent_type, 20);
  const pickupPointId = body.pickup_point_id ? cleanText(body.pickup_point_id, 80) : null;

  if (!email || !email.includes("@") || !fullName || !phone) {
    throw new Error("Valid email, full name and phone number are required.");
  }
  if (agentType !== "pickup" && agentType !== "delivery") {
    throw new Error("agent_type must be pickup or delivery.");
  }
  if ((agentType === "pickup" && !pickupPointId) || (agentType === "delivery" && pickupPointId)) {
    throw new Error("Pickup agents require a pickup station; delivery agents must not have one.");
  }

  if (agentType === "pickup") {
    const { data: station, error: stationError } = await adminDb
      .from("marketplace_pickup_points")
      .select("id,is_active,name")
      .eq("id", pickupPointId)
      .eq("is_active", true)
      .maybeSingle();
    if (stationError) throw stationError;
    if (!station) throw new Error("The selected pickup station does not exist or is inactive.");
  }

  const { data: existingApplication, error: duplicateError } = await adminDb
    .from("marketplace_fulfillment_agent_applications")
    .select("id,status")
    .ilike("email", email)
    .in("status", ["pending", "approved"])
    .maybeSingle();
  if (duplicateError) throw duplicateError;
  if (existingApplication) throw new Error("An application for this email is already pending or approved.");

  const { data: usersPage, error: usersError } = await adminDb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) throw usersError;
  const existingUser = (usersPage?.users ?? []).find((user: any) =>
    typeof user.email === "string" && user.email.toLowerCase() === email
  ) ?? null;
  if (existingUser) {
    const { data: existingAgent, error: existingAgentError } = await adminDb
      .from("marketplace_fulfillment_agents")
      .select("id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    if (existingAgentError) throw existingAgentError;
    if (existingAgent) throw new Error("This PanBill user is already registered as a fulfillment agent.");
  }

  const { data: application, error: insertError } = await adminDb
    .from("marketplace_fulfillment_agent_applications")
    .insert({
      email,
      full_name: fullName,
      phone,
      agent_type: agentType,
      pickup_point_id: pickupPointId,
      status: "pending",
      created_by: actorId,
    })
    .select("id,email,full_name,phone,agent_type,pickup_point_id,status,created_at")
    .single();
  if (insertError) throw insertError;

  await adminDb.from("marketplace_fulfillment_agent_audit").insert({
    actor_user_id: actorId,
    action: "agent_application_created",
    details: { application_id: application.id, email, agent_type: agentType, pickup_point_id: pickupPointId },
  });

  return { application, invitation_sent: false, pending_approval: true };
}

async function adminListApplications(actorId: string) {
  await requireSuperAdmin(actorId);
  const { data, error } = await adminDb
    .from("marketplace_fulfillment_agent_applications")
    .select("id,email,full_name,phone,agent_type,pickup_point_id,status,created_at,approved_at,rejected_at,marketplace_pickup_points(name,address,city,state)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { applications: data ?? [] };
}

async function adminReviewApplication(body: any, actorId: string) {
  await requireSuperAdmin(actorId);
  const applicationId = cleanText(body.application_id, 80);
  const decision = cleanText(body.decision, 20).toLowerCase();
  if (!applicationId || !["approve", "reject"].includes(decision)) {
    throw new Error("application_id and decision (approve or reject) are required.");
  }

  const { data: application, error: appError } = await adminDb
    .from("marketplace_fulfillment_agent_applications")
    .select("*")
    .eq("id", applicationId)
    .eq("status", "pending")
    .maybeSingle();
  if (appError) throw appError;
  if (!application) throw new Error("Pending application not found. It may already have been reviewed.");

  if (decision === "reject") {
    const { error } = await adminDb.from("marketplace_fulfillment_agent_applications")
      .update({ status: "rejected", rejected_by: actorId, rejected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", applicationId).eq("status", "pending");
    if (error) throw error;
    await adminDb.from("marketplace_fulfillment_agent_audit").insert({
      actor_user_id: actorId, action: "agent_application_rejected",
      details: { application_id: applicationId, email: application.email },
    });
    return { reviewed: true, status: "rejected", invitation_sent: false };
  }

  // Function and station are confirmed by the Super Admin at approval time.
  const agentType = cleanText(body.agent_type || application.agent_type, 20);
  const pickupPointId = body.pickup_point_id === undefined
    ? application.pickup_point_id
    : (body.pickup_point_id ? cleanText(body.pickup_point_id, 80) : null);
  if (agentType !== "pickup" && agentType !== "delivery") throw new Error("Choose pickup or delivery agent function.");
  if ((agentType === "pickup" && !pickupPointId) || (agentType === "delivery" && pickupPointId)) {
    throw new Error("Pickup agents require an active station; delivery agents must not have a station.");
  }
  if (agentType === "pickup") {
    const { data: station, error } = await adminDb.from("marketplace_pickup_points")
      .select("id,is_active").eq("id", pickupPointId).eq("is_active", true).maybeSingle();
    if (error) throw error;
    if (!station) throw new Error("Selected pickup station is missing or inactive.");
  }

  const { data: usersPage, error: usersError } = await adminDb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) throw usersError;
  let user = (usersPage?.users ?? []).find((u: any) =>
    typeof u.email === "string" && u.email.toLowerCase() === String(application.email).toLowerCase()
  ) ?? null;

  let invitationSent = false;
  if (!user) {
    const { data: invited, error: inviteError } = await adminDb.auth.admin.inviteUserByEmail(application.email, {
      data: { full_name: application.full_name, phone: application.phone, panbill_role: "marketplace_fulfillment_agent" },
      redirectTo: AGENT_DASHBOARD_URL,
    });
    if (inviteError) throw inviteError;
    user = invited.user;
    invitationSent = true;
  }
  if (!user?.id) throw new Error("Could not create or locate the invited user account.");

  const { data: existingAgent, error: agentLookupError } = await adminDb.from("marketplace_fulfillment_agents")
    .select("id").eq("user_id", user.id).maybeSingle();
  if (agentLookupError) throw agentLookupError;
  if (existingAgent) throw new Error("This account is already registered as a fulfillment agent.");

  const { data: agent, error: createAgentError } = await adminDb.from("marketplace_fulfillment_agents")
    .insert({ user_id: user.id, full_name: application.full_name, phone: application.phone,
      agent_type: agentType, pickup_point_id: pickupPointId, is_active: true, created_by: actorId })
    .select("id,user_id,full_name,phone,agent_type,pickup_point_id,is_active,created_at").single();
  if (createAgentError) throw createAgentError;

  const { error: appUpdateError } = await adminDb.from("marketplace_fulfillment_agent_applications")
    .update({ status: "approved", approved_by: actorId, approved_at: new Date().toISOString(),
      approved_agent_id: agent.id, agent_type: agentType, pickup_point_id: pickupPointId, updated_at: new Date().toISOString() })
    .eq("id", applicationId).eq("status", "pending");
  if (appUpdateError) {
    await adminDb.from("marketplace_fulfillment_agents").delete().eq("id", agent.id);
    throw appUpdateError;
  }

  await adminDb.from("marketplace_fulfillment_agent_audit").insert({
    agent_id: agent.id, actor_user_id: actorId, action: "agent_application_approved",
    details: { application_id: applicationId, email: application.email, agent_type: agentType,
      pickup_point_id: pickupPointId, invitation_sent: invitationSent },
  });

  const { error: welcomeEmailError } = await adminDb.from("marketplace_email_events").upsert({
    event_key: `agent-welcome:${agent.id}`, recipient_user_id: user.id,
    recipient_email: application.email, recipient_role: "agent", event_type: "agent_welcome",
    payload: { agent_name: agent.full_name, agent_type: agent.agent_type, dashboard_url: AGENT_DASHBOARD_URL,
      account_invitation_sent: invitationSent }, status: "queued", updated_at: new Date().toISOString(),
  }, { onConflict: "event_key", ignoreDuplicates: true });
  if (welcomeEmailError) console.error("Agent welcome email queue failed:", welcomeEmailError.message);

  return { reviewed: true, status: "approved", agent, invitation_sent: invitationSent,
    welcome_email_queued: !welcomeEmailError, welcome_email_error: welcomeEmailError?.message ?? null };

}

async function adminSetAgentActive(body: any, actorId: string) {
  await requireSuperAdmin(actorId);
  const agentId = cleanText(body.agent_id, 80);
  if (!agentId || typeof body.is_active !== "boolean") {
    throw new Error("agent_id and boolean is_active are required.");
  }
  const { data: agent, error } = await adminDb
    .from("marketplace_fulfillment_agents")
    .update({ is_active: body.is_active, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .select("id,user_id,full_name,phone,agent_type,pickup_point_id,is_active")
    .single();
  if (error) throw error;
  await adminDb.from("marketplace_fulfillment_agent_audit").insert({
    agent_id: agent.id,
    actor_user_id: actorId,
    action: body.is_active ? "agent_activated" : "agent_suspended",
    details: {},
  });
  return { agent };
}

async function adminListAgents(actorId: string) {
  await requireSuperAdmin(actorId);
  const { data, error } = await adminDb
    .from("marketplace_fulfillment_agents")
    .select("id,user_id,full_name,phone,agent_type,pickup_point_id,is_active,created_at,marketplace_pickup_points(name,address,city,state)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { agents: data ?? [] };
}

async function adminListUnassignedOrders(actorId: string) {
  await requireSuperAdmin(actorId);

  const { data: orders, error: ordersError } = await adminDb
    .from("marketplace_orders")
    .select(ORDER_FIELDS)
    .eq("fulfillment_type", "physical")
    .not("order_status", "in", '("cancelled","delivered")')
    .or(
      "and(payment_method.eq.online,payment_provider.eq.paystack,payment_status.eq.paid,delivery_payment_status.eq.not_applicable),and(payment_method.eq.cash_on_delivery,payment_status.eq.pending,delivery_payment_status.eq.pending),and(payment_method.eq.cash_on_delivery,payment_status.eq.paid,delivery_payment_status.eq.collected)",
    )
    .order("created_at", { ascending: false });

  if (ordersError) throw ordersError;

  const { data: assignments, error: assignmentsError } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .select("order_id")
    .eq("status", "assigned");

  if (assignmentsError) throw assignmentsError;

  const assignedOrderIds = new Set(
    (assignments ?? []).map((item: any) => item.order_id),
  );

  const unassignedOrders = (orders ?? []).filter(
    (order: any) =>
      isEligibleOrderForAssignment(order) && !assignedOrderIds.has(order.id),
  );

  return { orders: unassignedOrders };
}

async function queueSellerAgentAssignedEmails(orderId: string, assignmentId: string, agent: any) {
  try {
    const { data: order, error: orderError } = await adminDb.from("marketplace_orders")
      .select(ORDER_FIELDS).eq("id", orderId).maybeSingle();
    if (orderError) throw orderError;
    if (!order) throw new Error("Order not found for seller agent notification.");
    const { data: items, error: itemsError } = await adminDb.from("marketplace_order_items")
      .select("seller_id,product_name,quantity,line_total").eq("order_id", orderId);
    if (itemsError) throw itemsError;
    const sellerIds = [...new Set((items || []).map((item: any) => item.seller_id).filter(Boolean))];
    if (!sellerIds.length) return false;
    const { data: sellers, error: sellersError } = await adminDb.from("marketplace_sellers")
      .select("user_id,business_name,contact_email").in("user_id", sellerIds);
    if (sellersError) throw sellersError;
    const events = (sellers || []).filter((seller: any) => cleanText(seller.contact_email, 254).includes("@"))
      .map((seller: any) => ({
        event_key: `agent_assigned:${orderId}:${assignmentId}:seller:${seller.user_id}`,
        order_id: orderId,
        recipient_user_id: seller.user_id,
        recipient_email: cleanText(seller.contact_email, 254).toLowerCase(),
        recipient_role: "seller",
        event_type: "order_placed",
        status: "queued",
        updated_at: new Date().toISOString(),
        payload: {
          order_number: order.order_number,
          total_amount: order.total_amount,
          payment_method: order.payment_method,
          payment_status: order.payment_status,
          delivery_method: order.delivery_method,
          delivery_name: order.delivery_name,
          delivery_phone: order.delivery_phone,
          delivery_address: [order.delivery_address, order.delivery_city, order.delivery_lga, order.delivery_state].filter(Boolean).join(", "),
          seller_name: seller.business_name,
          items: (items || []).filter((item: any) => item.seller_id === seller.user_id),
          agent_name: agent.full_name,
          agent_phone: agent.phone,
          agent_type: agent.agent_type,
          agent_assignment_id: assignmentId,
          agent_contact_notice: "Your order has been assigned. Contact the assigned PanBill fulfillment agent using the number below for order coordination.",
        },
      }));
    if (events.length) {
      const { error } = await adminDb.from("marketplace_email_events").upsert(events, { onConflict: "event_key", ignoreDuplicates: true });
      if (error) throw error;
      await fetch(`${SUPABASE_URL}/functions/v1/marketplace-email-worker`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch((error) => console.error("Seller agent-assignment email worker invoke failed:", error));
      return true;
    }
    return false;
  } catch (error) {
    console.error("PanBill seller agent-assignment email queue failed:", error);
    return false;
  }
}

async function adminAssignOrder(body: any, actorId: string) {
  await requireSuperAdmin(actorId);

  const orderId = cleanText(body.order_id, 80);
  const agentId = cleanText(body.agent_id, 80);

  if (!orderId || !agentId) {
    throw new Error("order_id and agent_id are required.");
  }

  const [
    { data: order, error: orderError },
    { data: agent, error: agentError },
  ] = await Promise.all([
    adminDb
      .from("marketplace_orders")
      .select(ORDER_FIELDS)
      .eq("id", orderId)
      .maybeSingle(),

    adminDb
      .from("marketplace_fulfillment_agents")
      .select("id,user_id,full_name,phone,agent_type,pickup_point_id,is_active")
      .eq("id", agentId)
      .maybeSingle(),
  ]);

  if (orderError) throw orderError;
  if (agentError) throw agentError;

  if (!order) throw new Error("Order not found.");

  if (!agent || !agent.is_active) {
    throw new Error("Active agent not found.");
  }

  if (!isEligibleOrderForAssignment(order)) {
    throw new Error(
      "This order is not eligible for assignment. Check its payment method, payment status and fulfillment status.",
    );
  }

  const expectedType =
    order.delivery_method === "pickup_point"
      ? "pickup"
      : order.delivery_method === "doorstep"
        ? "delivery"
        : "";

  if (!expectedType || agent.agent_type !== expectedType) {
    throw new Error(
      "Agent type does not match this order's delivery method.",
    );
  }

  if (
    expectedType === "pickup" &&
    agent.pickup_point_id !== order.pickup_point_id
  ) {
    throw new Error(
      "This pickup agent does not belong to the order's selected pickup station.",
    );
  }

  if (expectedType === "delivery" && agent.pickup_point_id) {
    throw new Error(
      "A delivery agent must not be assigned to a pickup station.",
    );
  }

  const { data: existing, error: existingError } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .select("id,agent_id")
    .eq("order_id", orderId)
    .eq("assignment_type", expectedType)
    .eq("status", "assigned");

  if (existingError) throw existingError;

  if (existing?.length) {
    if (existing.some((item: any) => item.agent_id === agentId)) {
      const sameAssignment = existing.find((item: any) => item.agent_id === agentId);
      const notificationsQueued = await queueSellerAgentAssignedEmails(orderId, sameAssignment.id, agent);
      return { assigned: true, already_assigned: true, seller_agent_notifications_queued: notificationsQueued };
    }

    throw new Error(
      "This order is already assigned to another agent. Cancel the existing assignment before assigning it again.",
    );
  }

  const { data: assignment, error: assignError } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .insert({
      order_id: orderId,
      agent_id: agentId,
      assignment_type: expectedType,
      status: "assigned",
      fulfillment_status: "assigned",
      assigned_by: actorId,
      notes: cleanText(body.notes, 500) || null,
    })
    .select(
      "id,order_id,agent_id,assignment_type,status,fulfillment_status,assigned_at",
    )
    .single();

  if (assignError) {
    if (assignError.code === "23505") {
      throw new Error(
        "This order has already been assigned. Refresh the order list.",
      );
    }
    throw assignError;
  }

  await adminDb.from("marketplace_fulfillment_agent_audit").insert({
    agent_id: agentId,
    assignment_id: assignment.id,
    order_id: orderId,
    actor_user_id: actorId,
    action: "order_assigned",
    details: { assignment_type: expectedType },
  });
  const notificationsQueued = await queueSellerAgentAssignedEmails(orderId, assignment.id, agent);

  return { assigned: true, assignment, seller_agent_notifications_queued: notificationsQueued };
}

async function agentOrdersList(actorId: string) {
  const agent = await getAgent(actorId);
  const { data, error } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .select(`id,assignment_type,status,fulfillment_status,assigned_at,notes,marketplace_orders(${ORDER_FIELDS})`)
    .eq("agent_id", agent.id)
    .eq("status", "assigned")
    .order("assigned_at", { ascending: false });
  if (error) throw error;
  const assignments = await Promise.all((data ?? []).map(async (assignment: any) => {
    const order = Array.isArray(assignment.marketplace_orders) ? assignment.marketplace_orders[0] : assignment.marketplace_orders;
    if (order?.id) {
      const { data: orderItems, error: itemsError } = await adminDb
        .from("marketplace_order_items")
        .select("product_id,product_name,quantity,line_total")
        .eq("order_id", order.id);
      if (itemsError) throw itemsError;
      assignment.order_items = orderItems ?? [];
    }
    if (!order || order.payment_method !== "pay_on_delivery" || !order.payment_reference) return assignment;
    const { data: tx, error: txError } = await adminDb.from("transactions")
      .select("provider_response").eq("reference", order.payment_reference).eq("user_id", order.buyer_id).maybeSingle();
    if (txError) throw txError;
    const transfer = tx?.provider_response?.pod_transfer;
    if (transfer?.account_number) assignment.pod_transfer = {
      account_name: transfer.account_name,
      account_number: transfer.account_number,
      bank_name: transfer.bank_name,
      expires_at: transfer.expires_at,
      amount: transfer.amount,
      status: transfer.status,
    };
    return assignment;
  }));
  return { agent, assignments };
}

async function agentCreatePodTransfer(body: any, actorId: string) {
  const agent = await getAgent(actorId);
  if (!PAYSTACK_SECRET_KEY || !PAYSTACK_SECRET_KEY.startsWith("sk_live_")) {
    throw new Error("Live Paystack is not configured. Set the live PAYSTACK_SECRET_KEY before generating transfer accounts.");
  }
  const assignmentId = cleanText(body.assignment_id, 80);
  if (!assignmentId) throw new Error("assignment_id is required.");
  const { data: assignment, error: assignmentError } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .select(`id,order_id,agent_id,assignment_type,status,fulfillment_status,marketplace_orders(${ORDER_FIELDS})`)
    .eq("id", assignmentId).eq("agent_id", agent.id).eq("status", "assigned").maybeSingle();
  if (assignmentError) throw assignmentError;
  if (!assignment) throw new Error("This order is not assigned to your agent account.");
  const order = Array.isArray(assignment.marketplace_orders) ? assignment.marketplace_orders[0] : assignment.marketplace_orders;
  if (!order || order.payment_method !== "pay_on_delivery" || order.payment_provider !== "paystack") {
    throw new Error("This is not a Paystack Pay on Delivery order.");
  }
  if (assignment.assignment_type !== agent.agent_type) throw new Error("Assignment type does not match your agent account.");
  const readyStatus = assignment.assignment_type === "pickup" ? "ready_for_collection" : "out_for_delivery";
  if (assignment.fulfillment_status !== readyStatus) throw new Error(`Move this order to ${readyStatus.replaceAll("_", " ")} before generating its transfer account.`);
  if (order.payment_status !== "pending" || order.delivery_payment_status !== "pending" || order.order_status === "cancelled" || order.order_status === "delivered") {
    throw new Error("This order is no longer awaiting Pay on Delivery payment.");
  }
  const { data: tx, error: txError } = await adminDb.from("transactions")
    .select("reference,user_id,provider,status,provider_response")
    .eq("reference", order.payment_reference).eq("user_id", order.buyer_id).maybeSingle();
  if (txError) throw txError;
  if (!tx || tx.provider !== "paystack" || tx.status !== "pending") throw new Error("The pending Paystack transaction for this order could not be verified.");
  const existing = tx.provider_response?.pod_transfer;
  if (existing?.account_number) {
    if (existing.expires_at && Date.parse(existing.expires_at) > Date.now()) return { pod_transfer: existing, already_created: true };
    throw new Error("This order's transfer account has expired. Do not reuse it; contact PanBill support for payment reconciliation.");
  }
  const { data: buyerData, error: buyerError } = await adminDb.auth.admin.getUserById(order.buyer_id);
  if (buyerError) throw buyerError;
  const buyerEmail = cleanText(buyerData?.user?.email, 254).toLowerCase();
  if (!buyerEmail || !buyerEmail.includes("@")) throw new Error("The buyer's email address is missing from the account.");
  const expiresAt = new Date(Date.now() + 7 * 60 * 60 * 1000 + 45 * 60 * 1000).toISOString();
  const reference = order.payment_reference;
  const chargeResponse = await fetch("https://api.paystack.co/charge", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: buyerEmail,
      amount: Math.round(Number(order.total_amount) * 100),
      currency: "NGN",
      reference,
      bank_transfer: { account_expires_at: expiresAt },
      metadata: { payment_type: "marketplace_pay_on_delivery", order_id: order.id, order_number: order.order_number, buyer_id: order.buyer_id, assignment_id: assignment.id, agent_id: agent.id },
    }),
  });
  const charge = await chargeResponse.json().catch(() => ({}));
  const chargeData = charge?.data;
  if (!chargeResponse.ok || charge.status !== true || !chargeData?.account_number) {
    throw new Error(cleanText(charge.message || chargeData?.display_text, 300) || "Paystack could not generate a transfer account. Confirm Pay with Transfer is enabled on the live account.");
  }
  const transfer = {
    account_name: cleanText(chargeData.account_name, 120),
    account_number: cleanText(chargeData.account_number, 30),
    bank_name: cleanText(chargeData.bank?.name || chargeData.bank_name, 120),
    expires_at: chargeData.account_expires_at || expiresAt,
    amount: Number(order.total_amount),
    status: cleanText(chargeData.status || "pending_bank_transfer", 50),
    reference,
  };
  if (!transfer.account_number || !transfer.bank_name) throw new Error("Paystack returned incomplete transfer account details. No payment instructions were issued.");
  const responsePayload = {
    ...(tx.provider_response || {}),
    payment_type: "marketplace_pay_on_delivery",
    pod_transfer: transfer,
  };
  const { error: saveError } = await adminDb.from("transactions")
    .update({ provider_response: responsePayload, provider_status: "pending_bank_transfer" })
    .eq("reference", reference).eq("user_id", order.buyer_id).eq("provider", "paystack").eq("status", "pending");
  if (saveError) throw saveError;
  await adminDb.from("marketplace_fulfillment_agent_audit").insert({
    agent_id: agent.id, assignment_id: assignment.id, order_id: order.id, actor_user_id: actorId,
    action: "pod_transfer_account_created",
    details: { reference, amount: transfer.amount, bank_name: transfer.bank_name, account_last4: transfer.account_number.slice(-4), expires_at: transfer.expires_at },
  });
  return { pod_transfer: transfer, already_created: false };
}

async function agentUpdateStatus(body: any, actorId: string) {
  const agent = await getAgent(actorId);
  const assignmentId = cleanText(body.assignment_id, 80);
  const nextStatus = cleanText(body.fulfillment_status, 40);
  if (!assignmentId || !nextStatus) throw new Error("assignment_id and fulfillment_status are required.");

  const transitions: Record<string, Record<string, string[]>> = {
    pickup: {
      assigned: ["parcel_received"],
      parcel_received: ["ready_for_collection"],
      ready_for_collection: ["collected"],
    },
    delivery: {
      assigned: ["out_for_delivery"],
      out_for_delivery: ["delivered", "delivery_failed"],
      delivery_failed: ["out_for_delivery", "returned"],
    },
  };
  const { data: assignment, error: assignmentError } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .select(`id,order_id,agent_id,assignment_type,status,fulfillment_status,marketplace_orders(${ORDER_FIELDS})`)
    .eq("id", assignmentId)
    .eq("agent_id", agent.id)
    .eq("status", "assigned")
    .maybeSingle();
  if (assignmentError) throw assignmentError;
  if (!assignment) throw new Error("This order is not assigned to your account.");
  if (assignment.assignment_type !== agent.agent_type) throw new Error("Assignment type does not match your agent account.");

  const order = Array.isArray(assignment.marketplace_orders)
    ? assignment.marketplace_orders[0]
    : assignment.marketplace_orders;
  if (!order) throw new Error("Assigned order could not be loaded.");
  if (order.fulfillment_type !== "physical" || order.order_status === "cancelled") {
    throw new Error("This order is not eligible for fulfillment updates.");
  }
  if (agent.agent_type === "pickup" && order.pickup_point_id !== agent.pickup_point_id) {
    throw new Error("This order belongs to a different pickup station.");
  }

  const currentStatus = assignment.fulfillment_status || "assigned";
  const allowedNext = transitions[agent.agent_type]?.[currentStatus] ?? [];
  const completed = nextStatus === "collected" || nextStatus === "delivered";
  if (order.payment_method === "pay_on_delivery" && completed) {
    if (order.payment_status !== "paid" || order.delivery_payment_status !== "collected") {
      throw new Error("Paystack has not verified this order's exact bank transfer. The order cannot be handed over yet.");
    }
    const { data: verifiedPodTransaction, error: podTransactionError } = await adminDb
      .from("transactions")
      .select("provider,status,provider_status,provider_response")
      .eq("reference", order.payment_reference)
      .eq("user_id", order.buyer_id)
      .maybeSingle();
    if (podTransactionError) throw podTransactionError;
    const podResponse = verifiedPodTransaction?.provider_response || {};
    if (!verifiedPodTransaction || verifiedPodTransaction.provider !== "paystack" ||
        verifiedPodTransaction.status !== "successful" ||
        verifiedPodTransaction.provider_status !== "success" ||
        podResponse.pod_outcome !== "verified" ||
        podResponse.payment_type !== "marketplace_pay_on_delivery") {
      throw new Error("PanBill cannot confirm handover because the Paystack bank transfer has not been verified.");
    }
  }
  if (!allowedNext.includes(nextStatus)) {
    throw new Error(`Invalid fulfillment step. Current status is ${currentStatus}; next allowed status: ${allowedNext.join(", ") || "none"}.`);
  }
  if (order.order_status === "delivered" && !completed) {
    throw new Error("This order is already marked delivered and cannot move to another fulfillment status.");
  }

  const { data: orderItems, error: itemsError } = await adminDb
    .from("marketplace_order_items")
    .select("id,product_id")
    .eq("order_id", order.id);
  if (itemsError) throw itemsError;
  const submittedProductId = cleanText(body.product_id, 80);
  if (!submittedProductId) throw new Error("Enter or scan the product ID to verify this order item.");
  if (!(orderItems ?? []).some((item: any) => item.product_id === submittedProductId)) {
    throw new Error("Product ID does not belong to this order. No fulfillment update was made.");
  }

  // COD collection is confirmed only by the assigned, active pickup agent.
  // The database RPC performs payment, stock, order, assignment and audit
  // changes in one transaction. The seller COD RPC is not used here.
  if (nextStatus === "collected" && order.payment_method === "cash_on_delivery") {
    if (agent.agent_type !== "pickup" || assignment.assignment_type !== "pickup") {
      throw new Error("Only the assigned pickup agent can confirm COD collection.");
    }

    const { data: codResult, error: codError } = await adminDb.rpc(
      "marketplace_agent_confirm_cod_collection",
      {
        p_order_id: order.id,
        p_assignment_id: assignment.id,
        p_agent_user_id: actorId,
        p_product_id: submittedProductId,
        p_reason: "Assigned pickup agent confirmed that the customer received the parcel and the full cash payment was received at the pickup station.",
      },
    );
    if (codError) throw codError;
    if (!codResult?.success) {
      throw new Error(codResult?.error || "COD collection could not be confirmed.");
    }

    let emailQueued: boolean | null = null;
    let emailError: string | null = null;
    try {
      let station: any = null;
      if (agent.pickup_point_id) {
        const { data, error } = await adminDb.from("marketplace_pickup_points")
          .select("name,address,city,state,phone,contact_name,instructions")
          .eq("id", agent.pickup_point_id).maybeSingle();
        if (error) throw error;
        station = data;
      }
      await queueBuyerEmail(
        order,
        "pickup_collected",
        `fulfillment:${assignment.id}:collected`,
        {
          fulfillment_status: "collected",
          payment_status: "paid",
          delivery_payment_status: "collected",
          agent_name: agent.full_name,
          agent_phone: agent.phone,
          pickup_station: station,
          collection_instructions: station?.instructions ?? null,
          payment_confirmation: "Cash received by the assigned pickup agent.",
        },
      );
      emailQueued = true;
    } catch (error) {
      emailQueued = false;
      emailError = error instanceof Error ? error.message : "Buyer notification could not be queued.";
      console.error("COD collection buyer email queue failed:", emailError);
    }

    return {
      updated: true,
      fulfillment_status: "collected",
      assignment_completed: true,
      payment_status: "paid",
      delivery_payment_status: "collected",
      order_status: "delivered",
      cod_payment_confirmed_by: "assigned_pickup_agent",
      ...(emailQueued === null ? {} : { buyer_email_queued: emailQueued, buyer_email_error: emailError }),
    };
  }

  if (completed) {
    if (order.payment_status !== "paid") {
      throw new Error("Payment has not been verified. This order cannot be completed.");
    }
    if (order.payment_method === "online" && order.payment_provider === "paystack" && order.delivery_payment_status !== "not_applicable") {
      throw new Error("The required Paystack delivery payment is not confirmed.");
    }
    if (order.payment_method === "cash_on_delivery" && order.delivery_payment_status !== "collected") {
      throw new Error("COD payment must be confirmed by the authorized payment workflow before completion. Agents cannot collect or confirm cash.");
    }
  }

  // Update the order first. If the assignment update then fails, the agent can
  // retry the final step: an already-delivered order is accepted for that retry.
  if (completed && order.order_status !== "delivered") {
    const { data: updatedOrder, error: orderUpdateError } = await adminDb
      .from("marketplace_orders")
      .update({ order_status: "delivered", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("order_status", order.order_status)
      .neq("order_status", "cancelled")
      .select("id")
      .maybeSingle();
    if (orderUpdateError) throw orderUpdateError;
    if (!updatedOrder) {
      throw new Error("The order changed while this update was being processed. Refresh the assignment and try again.");
    }
  }

  const update: Record<string, unknown> = {
    fulfillment_status: nextStatus,
    ...(completed ? { status: "completed", completed_at: new Date().toISOString() } : {}),
    ...(body.notes ? { notes: cleanText(body.notes, 500) } : {}),
  };
  const { data: updatedAssignment, error: updateError } = await adminDb
    .from("marketplace_order_fulfillment_assignments")
    .update(update)
    .eq("id", assignment.id)
    .eq("agent_id", agent.id)
    .eq("status", "assigned")
    .eq("fulfillment_status", currentStatus)
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updatedAssignment) {
    throw new Error("The assignment changed while this update was being processed. Refresh the assignment. If the order is already delivered, retry the final fulfillment step.");
  }

  await adminDb.from("marketplace_fulfillment_agent_audit").insert({
    agent_id: agent.id,
    assignment_id: assignment.id,
    order_id: order.id,
    actor_user_id: actorId,
    action: "fulfillment_status_updated",
    details: { from: currentStatus, to: nextStatus, notes: cleanText(body.notes, 500) || null },
  });

  const eventTypes: Record<string, string> = {
    ready_for_collection: "pickup_ready_for_collection",
    out_for_delivery: "doorstep_out_for_delivery",
    delivered: "doorstep_delivered",
    delivery_failed: "delivery_failed",
    collected: "pickup_collected",
  };
  const eventType = eventTypes[nextStatus];
  let emailQueued: boolean | null = null;
  let emailError: string | null = null;
  if (eventType) {
    try {
      let station: any = null;
      if (agent.agent_type === "pickup" && agent.pickup_point_id) {
        const { data } = await adminDb.from("marketplace_pickup_points")
          .select("name,address,city,state,phone,contact_name,instructions")
          .eq("id", agent.pickup_point_id).maybeSingle();
        station = data;
      }
      await queueBuyerEmail(
        order,
        eventType,
        `fulfillment:${assignment.id}:${nextStatus}`,
        {
          fulfillment_status: nextStatus,
          agent_name: agent.full_name,
          agent_phone: agent.phone,
          pickup_station: station,
          collection_instructions: station?.instructions ?? null,
          agent_notes: cleanText(body.notes, 500) || null,
        },
      );
      emailQueued = true;
    } catch (error) {
      emailQueued = false;
      emailError = error instanceof Error ? error.message : "Buyer notification could not be queued.";
      console.error("Fulfillment buyer email queue failed:", emailError);
    }
  }

  return {
    updated: true,
    fulfillment_status: nextStatus,
    assignment_completed: completed,
    ...(emailQueued === null ? {} : { buyer_email_queued: emailQueued, buyer_email_error: emailError }),
  };
}

async function recordSellerAdminAudit(
  actorId: string,
  sellerUserId: string,
  action: string,
  details: Record<string, unknown> = {},
) {
  const { error } = await adminDb
    .from("marketplace_seller_admin_access_audit")
    .insert({
      actor_user_id: actorId,
      seller_user_id: sellerUserId,
      action,
      details,
    });
  if (error) throw error;
}

const SELLER_PROFILE_FIELDS =
  "user_id,business_name,slug,business_description,contact_email,contact_phone,business_address,status,commission_rate,approved_at,created_at,updated_at,dispatch_state,dispatch_city,dispatch_lga,dispatch_location_status,dispatch_location_reviewed_at,dispatch_location_reviewed_by,dispatch_location_review_note";

async function adminPendingSellers(actorId: string) {
  await requireSuperAdmin(actorId);
  const { data, error } = await adminDb
    .from("marketplace_sellers")
    .select(SELLER_PROFILE_FIELDS)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { sellers: data ?? [] };
}

async function adminApprovedSellers(actorId: string) {
  await requireSuperAdmin(actorId);
  const { data, error } = await adminDb
    .from("marketplace_sellers")
    .select(SELLER_PROFILE_FIELDS)
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { sellers: data ?? [] };
}

async function adminReviewSeller(body: any, actorId: string) {
  await requireSuperAdmin(actorId);
  const sellerUserId = cleanText(body.seller_user_id, 80);
  const decision = cleanText(body.decision, 20).toLowerCase();
  const reason = cleanText(body.reason, 500);
  if (!sellerUserId || !["approved", "rejected"].includes(decision)) {
    throw new Error("seller_user_id and decision (approved or rejected) are required.");
  }

  const { data: current, error: lookupError } = await adminDb
    .from("marketplace_sellers")
    .select("user_id,status")
    .eq("user_id", sellerUserId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!current) throw new Error("Seller account not found.");
  if (current.status !== "pending") {
    throw new Error("This seller application is no longer pending.");
  }

  const update: Record<string, unknown> = {
    status: decision,
    updated_at: new Date().toISOString(),
  };
  if (decision === "approved") {
    const rate = Number(body.commission_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw new Error("Enter a commission rate from 0 to 100.");
    }
    update.commission_rate = rate;
    update.approved_at = new Date().toISOString();
  }

  const { data, error } = await adminDb
    .from("marketplace_sellers")
    .update(update)
    .eq("user_id", sellerUserId)
    .eq("status", "pending")
    .select(SELLER_PROFILE_FIELDS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Seller application changed before the review could be saved.");

  await recordSellerAdminAudit(actorId, sellerUserId, "seller_application_reviewed", {
    decision,
    commission_rate: decision === "approved" ? update.commission_rate : null,
    reason,
  });
  return { reviewed: true, seller: data, message: `Seller application ${decision}.` };
}

async function adminPendingDispatchLocations(actorId: string) {
  await requireSuperAdmin(actorId);
  const { data, error } = await adminDb
    .from("marketplace_sellers")
    .select(SELLER_PROFILE_FIELDS)
    .eq("dispatch_location_status", "pending")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return { sellers: data ?? [] };
}

async function adminReviewDispatchLocation(body: any, actorId: string) {
  await requireSuperAdmin(actorId);
  const sellerUserId = cleanText(body.seller_user_id, 80);
  const decision = cleanText(body.decision, 20).toLowerCase();
  const reason = cleanText(body.reason, 500);
  if (!sellerUserId || !["approved", "rejected"].includes(decision)) {
    throw new Error("seller_user_id and decision (approved or rejected) are required.");
  }
  if (decision === "rejected" && !reason) {
    throw new Error("A reason is required when rejecting a dispatch location.");
  }

  const { data, error } = await adminDb
    .from("marketplace_sellers")
    .update({
      dispatch_location_status: decision,
      dispatch_location_reviewed_at: new Date().toISOString(),
      dispatch_location_reviewed_by: actorId,
      dispatch_location_review_note: reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", sellerUserId)
    .eq("dispatch_location_status", "pending")
    .select(SELLER_PROFILE_FIELDS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Pending dispatch location not found. It may already have been reviewed.");

  await recordSellerAdminAudit(actorId, sellerUserId, "seller_dispatch_location_reviewed", {
    decision,
    reason,
    dispatch_state: data.dispatch_state,
    dispatch_lga: data.dispatch_lga,
    dispatch_city: data.dispatch_city,
  });
  return { reviewed: true, seller: data, message: `Dispatch location ${decision}.` };
}

/*
Read-only seller account overview.
It records an audit event every time the Super Admin opens the seller account.
No seller password, auth token, full bank account number, or provider_response
is returned. Orders are scoped through marketplace_order_items.seller_id.
*/
async function adminSellerAccountOverview(body: any, actorId: string) {
  await requireSuperAdmin(actorId);
  const sellerUserId = cleanText(body.seller_user_id, 80);
  if (!sellerUserId) throw new Error("seller_user_id is required.");

  const { data: seller, error: sellerError } = await adminDb
    .from("marketplace_sellers")
    .select(SELLER_PROFILE_FIELDS)
    .eq("user_id", sellerUserId)
    .maybeSingle();
  if (sellerError) throw sellerError;
  if (!seller) throw new Error("Seller account not found.");

  const [
    productsResult,
    itemsResult,
    payoutsResult,
    socialResult,
    payoutAccountResult,
  ] = await Promise.all([
    adminDb.from("marketplace_products")
      .select("id,name,slug,description,price,stock_quantity,images,product_type,status,created_at,updated_at,parcel_size,digital_delivery_mode,regular_price,discount_percent")
      .eq("seller_id", sellerUserId)
      .order("created_at", { ascending: false })
      .limit(100),
    adminDb.from("marketplace_order_items")
      .select("id,order_id,product_id,seller_id,product_name,unit_price,quantity,line_total,created_at,marketplace_orders(id,order_number,buyer_id,subtotal,delivery_fee,total_amount,payment_status,order_status,payment_provider,payment_reference,delivery_name,delivery_phone,delivery_city,delivery_state,paid_at,created_at,payment_method,delivery_payment_status,delivery_lga,fulfillment_type,delivery_method)")
      .eq("seller_id", sellerUserId)
      .order("created_at", { ascending: false })
      .limit(100),
    adminDb.from("marketplace_seller_payouts")
      .select("id,seller_id,order_id,gross_amount,platform_fee,net_amount,currency,status,transfer_reference,transfer_code,failure_reason,eligible_at,processed_at,created_at,updated_at")
      .eq("seller_id", sellerUserId)
      .order("created_at", { ascending: false })
      .limit(100),
    adminDb.from("marketplace_seller_social_links")
      .select("id,platform,url,is_primary,created_at,updated_at")
      .eq("seller_id", sellerUserId)
      .order("is_primary", { ascending: false }),
    adminDb.from("marketplace_seller_payout_accounts")
      .select("bank_name,account_name,account_number_last4,verification_status,created_at,updated_at")
      .eq("seller_id", sellerUserId)
      .limit(1)
      .maybeSingle(),
  ]);

  for (const result of [productsResult, itemsResult, payoutsResult, socialResult, payoutAccountResult]) {
    if (result.error) throw result.error;
  }

  await recordSellerAdminAudit(actorId, sellerUserId, "seller_account_viewed", {
    business_name: seller.business_name,
    product_count: (productsResult.data ?? []).length,
    order_item_count: (itemsResult.data ?? []).length,
    payout_count: (payoutsResult.data ?? []).length,
  });

  return {
    seller,
    products: productsResult.data ?? [],
    order_items: itemsResult.data ?? [],
    payouts: payoutsResult.data ?? [],
    social_links: socialResult.data ?? [],
    payout_account_summary: payoutAccountResult.data ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "Method not allowed." }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return respond({ success: false, error: "Supabase function secrets are not configured." }, 500);
  }

  try {
    const authorization = req.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return respond({ success: false, error: "Authentication required." }, 401);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser();
    if (authError || !authData.user) return respond({ success: false, error: "Invalid or expired login session." }, 401);

    const body = await req.json().catch(() => ({}));
    const action = cleanText(body.action, 60);
    let result: unknown;

    switch (action) {
      case "admin_create_agent":
        result = await adminCreateAgent(body, authData.user.id);
        break;
      case "admin_list_applications":
        result = await adminListApplications(authData.user.id);
        break;
      case "admin_review_application":
        result = await adminReviewApplication(body, authData.user.id);
        break;
      case "admin_set_agent_active":
        result = await adminSetAgentActive(body, authData.user.id);
        break;
      case "admin_list_agents":
        result = await adminListAgents(authData.user.id);
        break;
      case "admin_list_unassigned_orders":
        result = await adminListUnassignedOrders(authData.user.id);
        break;
      case "admin_assign_order":
        result = await adminAssignOrder(body, authData.user.id);
        break;
      case "agent_orders_list":
        result = await agentOrdersList(authData.user.id);
        break;
      case "agent_create_pod_transfer":
        result = await agentCreatePodTransfer(body, authData.user.id);
        break;
      case "agent_update_status":
        result = await agentUpdateStatus(body, authData.user.id);
        break;
      case "pending_sellers":
        result = await adminPendingSellers(authData.user.id);
        break;
      case "review_seller":
        result = await adminReviewSeller(body, authData.user.id);
        break;
      case "approved_sellers":
        result = await adminApprovedSellers(authData.user.id);
        break;
      case "pending_dispatch_locations":
        result = await adminPendingDispatchLocations(authData.user.id);
        break;
      case "review_dispatch_location":
        result = await adminReviewDispatchLocation(body, authData.user.id);
        break;
      case "seller_account_overview":
        result = await adminSellerAccountOverview(body, authData.user.id);
        break;
      default:
        return respond({ success: false, error: "Unknown marketplace-admin action." }, 400);
    }

    return respond({ success: true, ...(result as Record<string, unknown>) });
  } catch (error) {
    console.error("marketplace-admin error:", error);
    const message = error instanceof Error ? error.message : "Request failed.";
    const status = /admin access required|super admin access required|not assigned to your account|active fulfillment agent account not found/i.test(message) ? 403 : 400;
    return respond({ success: false, error: message }, status);
  }
});
