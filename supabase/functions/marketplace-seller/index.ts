
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

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 45);

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
      return respond({
        success: false,
        error: "Server configuration is incomplete.",
      }, 500);
    }

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return respond({ success: false, error: "Please sign in first." }, 401);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: authError } =
      await authClient.auth.getUser();

    const user = userData?.user;

    if (authError || !user) {
      return respond({ success: false, error: "Invalid or expired session." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json();
    const action = body.action ?? "register";

    if (action === "status") {
      const { data, error } = await adminClient
        .from("marketplace_sellers")
        .select(
          "user_id, business_name, slug, status, commission_rate, created_at, approved_at"
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw error;

      return respond({ success: true, seller: data });
    }

    if (action !== "register") {
      return respond({ success: false, error: "Invalid action." }, 400);
    }

    const businessName = String(body.business_name ?? "").trim();
    const businessDescription =
      String(body.business_description ?? "").trim();
    const contactEmail =
      String(body.contact_email ?? user.email ?? "").trim().toLowerCase();
    const contactPhone = String(body.contact_phone ?? "").trim();
    const businessAddress = String(body.business_address ?? "").trim();

    if (businessName.length < 2 || businessName.length > 100) {
      return respond({
        success: false,
        error: "Business name must be between 2 and 100 characters.",
      }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return respond({ success: false, error: "Enter a valid contact email." }, 400);
    }

    if (
      businessDescription.length > 2000 ||
      contactPhone.length > 30 ||
      businessAddress.length > 300
    ) {
      return respond({
        success: false,
        error: "One or more fields are too long.",
      }, 400);
    }

    const { data: existing, error: existingError } = await adminClient
      .from("marketplace_sellers")
      .select("user_id, business_name, slug, status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      return respond({
        success: false,
        error: "You already have a seller application.",
        seller: existing,
      }, 409);
    }

    const baseSlug = slugify(businessName) || "seller";
    let slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;

    const { data: seller, error: insertError } = await adminClient
      .from("marketplace_sellers")
      .insert({
        user_id: user.id,
        business_name: businessName,
        slug,
        business_description: businessDescription || null,
        contact_email: contactEmail,
        contact_phone: contactPhone || null,
        business_address: businessAddress || null,
        status: "pending",
      })
      .select(
        "user_id, business_name, slug, status, commission_rate, created_at"
      )
      .single();

    if (insertError) {
      console.error("Seller registration error:", insertError);
      throw insertError;
    }

    return respond({
      success: true,
      message: "Your seller application has been submitted for review.",
      seller,
    }, 201);
  } catch (error) {
    console.error("Marketplace seller function error:", error);

    return respond({
      success: false,
      error: "Unable to process your seller application. Please try again.",
    }, 500);
  }
});
