BEGIN;

-- PanBill: assigned pickup-agent-only COD collection confirmation.
-- Corrected version: adds COD payout queue/claim eligibility while preserving
-- the existing Paystack payout workflow and seller commission calculations.
-- Apply only after reviewing and confirming the matching Edge Function is deployed.

CREATE OR REPLACE FUNCTION public.marketplace_agent_confirm_cod_collection(
  p_order_id uuid,
  p_assignment_id uuid,
  p_agent_user_id uuid,
  p_product_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_agent public.marketplace_fulfillment_agents%ROWTYPE;
  v_assignment public.marketplace_order_fulfillment_assignments%ROWTYPE;
  v_order public.marketplace_orders%ROWTYPE;
  v_reservation record;
  v_item_count integer;
  v_reservation_count integer;
  v_reserved_count integer;
  v_transaction_count integer;
  v_assignment_count integer;
  v_old_values jsonb;
  v_new_values jsonb;
BEGIN
  IF p_agent_user_id IS NULL OR p_order_id IS NULL
     OR p_assignment_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Order, assignment, agent and product are required.';
  END IF;

  IF length(trim(coalesce(p_reason, ''))) < 5
     OR length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'A collection confirmation reason between 5 and 500 characters is required.';
  END IF;

  -- Lock and verify the active pickup agent.
  SELECT *
  INTO v_agent
  FROM public.marketplace_fulfillment_agents
  WHERE user_id = p_agent_user_id
    AND is_active = true
    AND agent_type = 'pickup'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'An active pickup agent account is required.';
  END IF;

  -- Lock the exact active assignment owned by this agent.
  SELECT *
  INTO v_assignment
  FROM public.marketplace_order_fulfillment_assignments
  WHERE id = p_assignment_id
    AND order_id = p_order_id
    AND agent_id = v_agent.id
    AND assignment_type = 'pickup'
    AND status = 'assigned'
    AND fulfillment_status = 'ready_for_collection'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This ready-for-collection order is not assigned to your pickup agent account.';
  END IF;

  -- Lock the order and validate the COD state.
  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF v_order.fulfillment_type <> 'physical'
     OR v_order.delivery_method <> 'pickup_point'
     OR v_order.pickup_point_id IS DISTINCT FROM v_agent.pickup_point_id THEN
    RAISE EXCEPTION 'This order does not belong to this agent pickup station.';
  END IF;

  IF v_order.payment_method <> 'cash_on_delivery'
     OR v_order.payment_provider <> 'cash_on_delivery' THEN
    RAISE EXCEPTION 'This is not a valid physical cash-on-delivery order.';
  END IF;

  IF v_order.payment_status <> 'pending'
     OR v_order.delivery_payment_status <> 'pending'
     OR v_order.order_status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This COD order is not in a payable collection state.';
  END IF;

  IF v_order.payment_reference IS NULL THEN
    RAISE EXCEPTION 'COD order payment reference is missing.';
  END IF;

  -- Require a verified product identifier from this exact order.
  IF NOT EXISTS (
    SELECT 1
    FROM public.marketplace_order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.product_id = p_product_id
  ) THEN
    RAISE EXCEPTION 'Product ID does not belong to this order.';
  END IF;

  -- Match the existing COD workflow's stock reservation safeguards.
  SELECT COUNT(*)
  INTO v_item_count
  FROM public.marketplace_order_items
  WHERE order_id = p_order_id;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'reserved')
  INTO v_reservation_count, v_reserved_count
  FROM public.marketplace_stock_reservations
  WHERE order_id = p_order_id;

  IF v_item_count = 0
     OR v_reservation_count <> v_item_count
     OR v_reserved_count <> v_reservation_count THEN
    RAISE EXCEPTION 'Order stock reservations are incomplete or already processed.';
  END IF;

  v_old_values := jsonb_build_object(
    'payment_status', v_order.payment_status,
    'delivery_payment_status', v_order.delivery_payment_status,
    'order_status', v_order.order_status,
    'assignment_fulfillment_status', v_assignment.fulfillment_status
  );

  -- Consume every reserved item exactly once. Any failure rolls back the
  -- entire function, including payment, order and audit changes.
  FOR v_reservation IN
    SELECT *
    FROM public.marketplace_stock_reservations
    WHERE order_id = p_order_id
      AND status = 'reserved'
    ORDER BY product_id
    FOR UPDATE
  LOOP
    UPDATE public.marketplace_stock_reservations
    SET status = 'consumed'
    WHERE id = v_reservation.id
      AND status = 'reserved';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock reservation changed during COD collection confirmation.';
    END IF;
  END LOOP;

  -- Update only this buyer's pending COD transaction. The agent marker below
  -- is also required by both payout eligibility functions.
  UPDATE public.transactions
  SET
    status = 'successful',
    provider_status = 'collected',
    provider_response =
      COALESCE(provider_response, '{}'::jsonb)
      || jsonb_build_object(
        'cod_outcome', 'collected',
        'cod_reason', trim(p_reason),
        'reported_by', p_agent_user_id,
        'reported_role', 'agent',
        'reported_at', now()
      )
  WHERE reference = v_order.payment_reference
    AND user_id = v_order.buyer_id
    AND provider = 'cash_on_delivery'
    AND status = 'pending';

  GET DIAGNOSTICS v_transaction_count = ROW_COUNT;

  IF v_transaction_count <> 1 THEN
    RAISE EXCEPTION 'Exactly one pending COD transaction must be found. No changes were committed.';
  END IF;

  -- Complete the order. The payout trigger will only queue COD if the
  -- successful transaction carries the agent-confirmation marker above.
  UPDATE public.marketplace_orders
  SET
    payment_status = 'paid',
    delivery_payment_status = 'collected',
    order_status = 'delivered',
    paid_at = COALESCE(paid_at, now()),
    cod_eligibility_counted_at = COALESCE(cod_eligibility_counted_at, now()),
    updated_at = now()
  WHERE id = p_order_id
    AND payment_status = 'pending'
    AND delivery_payment_status = 'pending'
    AND order_status NOT IN ('delivered', 'cancelled');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order changed during COD collection confirmation.';
  END IF;

  -- Count a successful paid COD order only once, matching the seller COD logic.
  IF v_order.cod_eligibility_counted_at IS NULL THEN
    INSERT INTO public.marketplace_customer_cod_profiles (
      user_id,
      successful_paid_cod_orders,
      cod_blocked,
      updated_at
    )
    VALUES (
      v_order.buyer_id,
      1,
      false,
      now()
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
      successful_paid_cod_orders =
        public.marketplace_customer_cod_profiles.successful_paid_cod_orders + 1,
      updated_at = now();
  END IF;

  -- Mark the exact assignment complete in the same transaction.
  UPDATE public.marketplace_order_fulfillment_assignments
  SET
    status = 'completed',
    fulfillment_status = 'collected',
    completed_at = now()
  WHERE id = v_assignment.id
    AND agent_id = v_agent.id
    AND status = 'assigned'
    AND fulfillment_status = 'ready_for_collection';

  GET DIAGNOSTICS v_assignment_count = ROW_COUNT;

  IF v_assignment_count <> 1 THEN
    RAISE EXCEPTION 'Pickup assignment changed during COD collection confirmation.';
  END IF;

  v_new_values := jsonb_build_object(
    'payment_status', 'paid',
    'delivery_payment_status', 'collected',
    'order_status', 'delivered',
    'assignment_status', 'completed',
    'assignment_fulfillment_status', 'collected',
    'stock_action', 'consumed'
  );

  INSERT INTO public.marketplace_cod_audit (
    order_id,
    buyer_id,
    actor_user_id,
    actor_role,
    action,
    reason,
    old_values,
    new_values
  )
  VALUES (
    p_order_id,
    v_order.buyer_id,
    p_agent_user_id,
    'agent',
    'collected',
    trim(p_reason),
    v_old_values,
    v_new_values
  );

  INSERT INTO public.marketplace_fulfillment_agent_audit (
    agent_id,
    assignment_id,
    order_id,
    actor_user_id,
    action,
    details
  )
  VALUES (
    v_agent.id,
    v_assignment.id,
    p_order_id,
    p_agent_user_id,
    'cod_payment_confirmed',
    jsonb_build_object(
      'from', 'ready_for_collection',
      'to', 'collected',
      'payment_status', 'paid',
      'delivery_payment_status', 'collected',
      'order_status', 'delivered',
      'product_id', p_product_id,
      'reason', trim(p_reason)
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'assignment_id', p_assignment_id,
    'outcome', 'collected',
    'payment_status', 'paid',
    'delivery_payment_status', 'collected',
    'order_status', 'delivered',
    'fulfillment_status', 'collected',
    'assignment_status', 'completed'
  );
END;
$function$;

-- Preserve the existing Paystack payout behavior and add COD only when the
-- transaction was marked successful by the agent-only COD confirmation RPC.
CREATE OR REPLACE FUNCTION public.marketplace_queue_seller_payouts_on_fulfillment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.order_status IS DISTINCT FROM 'delivered'
     OR NEW.payment_status IS DISTINCT FROM 'paid'
     OR NEW.fulfillment_type IS DISTINCT FROM 'physical'
     OR NOT (
       (
         NEW.payment_method = 'online'
         AND NEW.payment_provider = 'paystack'
         AND NEW.delivery_payment_status = 'not_applicable'
       )
       OR
       (
         NEW.payment_method = 'cash_on_delivery'
         AND NEW.payment_provider = 'cash_on_delivery'
         AND NEW.delivery_payment_status = 'collected'
         AND EXISTS (
           SELECT 1
           FROM public.transactions t
           WHERE t.reference = NEW.payment_reference
             AND t.user_id = NEW.buyer_id
             AND t.provider = 'cash_on_delivery'
             AND t.status = 'successful'
             AND t.provider_status = 'collected'
             AND t.provider_response->>'cod_outcome' = 'collected'
             AND t.provider_response->>'reported_role' = 'agent'
         )
       )
     )
  THEN
    RETURN NEW;
  END IF;

  -- Do not create payouts without order items.
  IF NOT EXISTS (
    SELECT 1
    FROM public.marketplace_order_items
    WHERE order_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Cannot create seller payouts: order has no items.';
  END IF;

  -- Every seller must have a valid commission rate.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT seller_id
      FROM public.marketplace_order_items
      WHERE order_id = NEW.id
      GROUP BY seller_id
    ) item_sellers
    LEFT JOIN public.marketplace_sellers s
      ON s.user_id = item_sellers.seller_id
    WHERE s.user_id IS NULL
       OR s.commission_rate IS NULL
       OR s.commission_rate < 0
       OR s.commission_rate >= 100
  ) THEN
    RAISE EXCEPTION 'Cannot create seller payouts: a seller has an invalid commission rate.';
  END IF;

  -- Calculate each seller's own share, excluding delivery fees.
  INSERT INTO public.marketplace_seller_payouts (
    seller_id,
    order_id,
    gross_amount,
    platform_fee,
    net_amount,
    currency,
    status,
    transfer_reference,
    provider_response,
    eligible_at
  )
  SELECT
    totals.seller_id,
    NEW.id,
    totals.gross_amount,
    ROUND(totals.gross_amount * s.commission_rate / 100, 2),
    ROUND(
      totals.gross_amount -
      ROUND(totals.gross_amount * s.commission_rate / 100, 2),
      2
    ),
    'NGN',
    CASE
      WHEN COALESCE(p.payout_enabled, false)
       AND p.verification_status = 'verified'
       AND NULLIF(TRIM(p.recipient_code), '') IS NOT NULL
      THEN 'queued'
      ELSE 'on_hold'
    END,
    'mp_' || REPLACE(gen_random_uuid()::text, '-', ''),
    jsonb_build_object(
      'source', 'marketplace_fulfillment',
      'commission_rate', s.commission_rate,
      'payment_method', NEW.payment_method,
      'payout_eligibility', CASE
        WHEN NEW.payment_method = 'cash_on_delivery' THEN 'agent_confirmed_cod'
        ELSE 'verified_paystack'
      END
    ),
    CASE
      WHEN COALESCE(p.payout_enabled, false)
       AND p.verification_status = 'verified'
       AND NULLIF(TRIM(p.recipient_code), '') IS NOT NULL
      THEN NOW()
      ELSE NULL
    END
  FROM (
    SELECT
      seller_id,
      SUM(line_total) AS gross_amount
    FROM public.marketplace_order_items
    WHERE order_id = NEW.id
    GROUP BY seller_id
  ) totals
  JOIN public.marketplace_sellers s
    ON s.user_id = totals.seller_id
  LEFT JOIN public.marketplace_seller_payout_profiles p
    ON p.seller_id = totals.seller_id
  WHERE totals.gross_amount > 0
    AND totals.gross_amount -
      ROUND(totals.gross_amount * s.commission_rate / 100, 2) > 0
  ON CONFLICT (seller_id, order_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Claim both eligible Paystack payouts and agent-confirmed COD payouts.
-- COD rows must still carry the immutable transaction marker written by the
-- agent confirmation RPC; a manually marked paid order is not sufficient.
CREATE OR REPLACE FUNCTION public.marketplace_claim_next_seller_payout()
RETURNS TABLE(
  payout_id uuid,
  seller_id uuid,
  order_id uuid,
  order_number text,
  net_amount numeric,
  currency text,
  transfer_reference text,
  recipient_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT p.id
    FROM public.marketplace_seller_payouts p
    JOIN public.marketplace_orders o
      ON o.id = p.order_id
    JOIN public.marketplace_seller_payout_profiles sp
      ON sp.seller_id = p.seller_id
    WHERE p.status = 'queued'
      AND p.eligible_at IS NOT NULL
      AND p.eligible_at <= NOW()
      AND p.net_amount > 0
      AND p.currency = 'NGN'
      AND sp.payout_enabled = true
      AND sp.verification_status = 'verified'
      AND NULLIF(TRIM(sp.recipient_code), '') IS NOT NULL
      AND o.order_status = 'delivered'
      AND o.payment_status = 'paid'
      AND o.fulfillment_type = 'physical'
      AND (
        (
          o.payment_method = 'online'
          AND o.payment_provider = 'paystack'
          AND o.delivery_payment_status = 'not_applicable'
        )
        OR
        (
          o.payment_method = 'cash_on_delivery'
          AND o.payment_provider = 'cash_on_delivery'
          AND o.delivery_payment_status = 'collected'
          AND EXISTS (
            SELECT 1
            FROM public.transactions t
            WHERE t.reference = o.payment_reference
              AND t.user_id = o.buyer_id
              AND t.provider = 'cash_on_delivery'
              AND t.status = 'successful'
              AND t.provider_status = 'collected'
              AND t.provider_response->>'cod_outcome' = 'collected'
              AND t.provider_response->>'reported_role' = 'agent'
          )
        )
      )
    ORDER BY p.eligible_at, p.created_at
    LIMIT 1
    FOR UPDATE OF p SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.marketplace_seller_payouts p
    SET status = 'processing',
        updated_at = NOW()
    FROM candidate c
    WHERE p.id = c.id
      AND p.status = 'queued'
    RETURNING
      p.id,
      p.seller_id,
      p.order_id,
      p.net_amount,
      p.currency,
      p.transfer_reference
  )
  SELECT
    c.id,
    c.seller_id,
    c.order_id,
    o.order_number::text,
    c.net_amount,
    c.currency,
    c.transfer_reference,
    sp.recipient_code
  FROM claimed c
  JOIN public.marketplace_orders o
    ON o.id = c.order_id
  JOIN public.marketplace_seller_payout_profiles sp
    ON sp.seller_id = c.seller_id;
END;
$function$;

-- The new RPC is deliberately server-only. marketplace-admin verifies the
-- caller's JWT and active assignment before invoking it with service_role.
REVOKE ALL ON FUNCTION public.marketplace_agent_confirm_cod_collection(uuid, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_agent_confirm_cod_collection(uuid, uuid, uuid, uuid, text)
  TO service_role;

-- Sellers must no longer confirm COD outcomes directly. Keep the old function
-- definition intact for server-side compatibility, but remove direct client access.
REVOKE EXECUTE ON FUNCTION public.marketplace_seller_record_cod_outcome(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_seller_record_cod_outcome(uuid, text, text)
  TO service_role;

COMMIT;
