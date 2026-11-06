
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ success: false, error: "Method not allowed." }, 405);
  }

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

    const { data: authData, error: authError } =
      await authClient.auth.getUser();

    if (authError || !authData.user) {
      return respond({ success: false, error: "Invalid or expired session." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const currentUserId = authData.user.id;

    // Only Super Admins may manage marketplace sellers.
    const { data: adminRecord, error: roleError } = await adminClient
      .from("panbill_admins")
      .select("role")
      .eq("user_id", currentUserId)
      .maybeSingle();

    if (roleError) throw roleError;

    if (!adminRecord || adminRecord.role !== "admin") {
      return respond({
        success: false,
        error: "Access denied. Super Admin permission is required.",
      }, 403);
    }

    const body = await req.json();
    const action = body.action;

    // List applications awaiting review.
    if (action === "pending_sellers") {
      const { data, error } = await adminClient
        .from("marketplace_sellers")
        .select(`
          user_id,
          business_name,
          slug,
          business_description,
          contact_email,
          contact_phone,
          business_address,
          status,
          commission_rate,
          created_at
        `)
        .eq("status", "pending")
        .order("created_at", { ascending: true });

      if (error) throw error;

      return respond({ success: true, sellers: data ?? [] });
    }

    // Approve, reject or suspend an application.
    if (action === "review_seller") {
      const sellerUserId = String(body.seller_user_id ?? "").trim();
      const decision = String(body.decision ?? "").trim().toLowerCase();
      const reason = String(body.reason ?? "").trim();

      if (!sellerUserId) {
        return respond({ success: false, error: "Seller user ID is required." }, 400);
      }

      if (!["approved", "rejected", "suspended"].includes(decision)) {
        return respond({ success: false, error: "Invalid seller decision." }, 400);
      }

      if (reason.length > 500) {
        return respond({ success: false, error: "Reason is too long." }, 400);
      }

      const { data: seller, error: sellerError } = await adminClient
        .from("marketplace_sellers")
        .select("user_id, business_name, status, commission_rate")
        .eq("user_id", sellerUserId)
        .maybeSingle();

      if (sellerError) throw sellerError;

      if (!seller) {
        return respond({ success: false, error: "Seller application not found." }, 404);
      }

      if (
        (decision === "approved" || decision === "rejected") &&
        seller.status !== "pending"
      ) {
        return respond({
          success: false,
          error: "Only pending applications can be approved or rejected.",
        }, 409);
      }

      if (decision === "suspended" && seller.status !== "approved") {
        return respond({
          success: false,
          error: "Only approved sellers can be suspended.",
        }, 409);
      }

      const updates: Record<string, unknown> = {
        status: decision,
        updated_at: new Date().toISOString(),
        approved_at: decision === "approved" ? new Date().toISOString() : null,
      };

      if (body.commission_rate !== undefined) {
        const rate = Number(body.commission_rate);

        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          return respond({
            success: false,
            error: "Commission rate must be between 0 and 100.",
          }, 400);
        }

        if (decision !== "approved") {
          return respond({
            success: false,
            error: "Commission rate can only be changed when approving a seller.",
          }, 400);
        }

        updates.commission_rate = rate;
      }

      const { data: updatedSeller, error: updateError } = await adminClient
        .from("marketplace_sellers")
        .update(updates)
        .eq("user_id", sellerUserId)
        .select("user_id, business_name, status, commission_rate, approved_at")
        .single();

      if (updateError) throw updateError;

      const { error: auditError } = await adminClient
        .from("panbill_admin_audit_logs")
        .insert({
          admin_user_id: currentUserId,
          action: `marketplace_seller_${decision}`,
          target_user_id: sellerUserId,
          reason: reason || null,
          details: {
            business_name: seller.business_name,
            previous_status: seller.status,
            new_status: decision,
            previous_commission_rate: seller.commission_rate,
            new_commission_rate: updatedSeller.commission_rate,
          },
        });

      if (auditError) {
        console.error("Marketplace audit logging failed:", auditError);
      }

      return respond({
        success: true,
        message: `Seller ${decision} successfully.`,
        seller: updatedSeller,
        audit_logged: !auditError,
      });
    }

    return respond({ success: false, error: "Unknown action." }, 400);

  } catch (error) {
    console.error("Marketplace admin error:", error);

    return respond({
      success: false,
      error: "Unable to complete marketplace administration request.",
    }, 500);
  }
});
