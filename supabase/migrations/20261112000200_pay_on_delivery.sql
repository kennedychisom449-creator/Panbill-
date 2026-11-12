BEGIN;

-- PanBill Marketplace: Pay on Delivery using a unique Paystack Pay with Transfer charge.
-- Existing online Paystack and agent-only COD paths remain supported.

DO $migration$
DECLARE
  v_constraint record;
BEGIN
  -- Replace only the existing payment_method allow-list check (if present).
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.marketplace_orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~* '^CHECK\s*\(*\s*payment_method\s*(=|IN)'
      AND pg_get_constraintdef(oid) ILIKE '%online%'
      AND pg_get_constraintdef(oid) ILIKE '%cash_on_delivery%'
  LOOP
    EXECUTE format('ALTER TABLE public.marketplace_orders DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$migration$;

ALTER TABLE public.marketplace_orders
  DROP CONSTRAINT IF EXISTS marketplace_orders_payment_method_pod_check;
ALTER TABLE public.marketplace_orders
  ADD CONSTRAINT marketplace_orders_payment_method_pod_check
  CHECK (payment_method IN ('online', 'cash_on_delivery', 'pay_on_delivery'));

-- Checkout first creates the normal, fully validated physical marketplace order.
-- This server-only RPC then changes its payment mode to POD and extends the stock
-- reservation window so it does not expire while the buyer waits for handover.
CREATE OR REPLACE FUNCTION public.marketplace_set_order_pay_on_delivery(
  p_order_id uuid,
  p_buyer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_transaction_count integer;
BEGIN
  IF p_order_id IS NULL OR p_buyer_id IS NULL THEN
    RAISE EXCEPTION 'Order and buyer are required.';
  END IF;

  SELECT * INTO v_order
  FROM public.marketplace_orders
  WHERE id = p_order_id AND buyer_id = p_buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Marketplace order not found for this buyer.';
  END IF;
  IF v_order.fulfillment_type IS DISTINCT FROM 'physical' THEN
    RAISE EXCEPTION 'Pay on Delivery is available only for physical products.';
  END IF;
  IF v_order.payment_method IS DISTINCT FROM 'online'
     OR v_order.payment_provider IS DISTINCT FROM 'paystack'
     OR v_order.payment_status IS DISTINCT FROM 'pending'
     OR v_order.delivery_payment_status IS DISTINCT FROM 'not_applicable'
     OR v_order.order_status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This order is not in a valid state for Pay on Delivery.';
  END IF;
  IF v_order.payment_reference IS NULL THEN
    RAISE EXCEPTION 'Order payment reference is missing.';
  END IF;

  UPDATE public.transactions
  SET provider = 'paystack',
      status = 'pending',
      provider_status = 'pending_bank_transfer',
      provider_response = COALESCE(provider_response, '{}'::jsonb)
        || jsonb_build_object('payment_type', 'marketplace_pay_on_delivery', 'pod_order_id', p_order_id)
  WHERE reference = v_order.payment_reference
    AND user_id = p_buyer_id
    AND provider = 'paystack'
    AND status = 'pending';
  GET DIAGNOSTICS v_transaction_count = ROW_COUNT;
  IF v_transaction_count <> 1 THEN
    RAISE EXCEPTION 'The pending Paystack transaction for this order could not be confirmed.';
  END IF;

  UPDATE public.marketplace_orders
  SET payment_method = 'pay_on_delivery',
      payment_provider = 'paystack',
      payment_status = 'pending',
      delivery_payment_status = 'pending',
      updated_at = now()
  WHERE id = p_order_id;

  -- Column presence is checked to keep this migration compatible with the
  -- reservation schema used by the existing marketplace checkout function.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'marketplace_stock_reservations'
      AND column_name = 'expires_at'
  ) THEN
    EXECUTE 'UPDATE public.marketplace_stock_reservations
             SET expires_at = now() + interval ''24 hours''
             WHERE order_id = $1 AND status = ''reserved''' USING p_order_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id,
    'payment_method', 'pay_on_delivery', 'payment_provider', 'paystack');
END;
$function$;

-- Called only after the Edge Function has verified the Paystack webhook HMAC,
-- fetched the transaction directly from Paystack, and checked amount/currency.
-- The database repeats the critical payment checks and completes fulfillment
-- atomically with the payout-triggering order update.
CREATE OR REPLACE FUNCTION public.marketplace_finalize_pod_payment(
  p_reference text,
  p_provider_reference text,
  p_provider_response jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_assignment public.marketplace_order_fulfillment_assignments%ROWTYPE;
  v_agent public.marketplace_fulfillment_agents%ROWTYPE;
  v_finalized jsonb;
  v_expected_kobo numeric;
  v_paid_kobo numeric;
  v_assignment_count integer;
BEGIN
  IF NULLIF(trim(p_reference), '') IS NULL OR p_provider_response IS NULL THEN
    RAISE EXCEPTION 'Verified Paystack reference and response are required.';
  END IF;

  SELECT * INTO v_order
  FROM public.marketplace_orders
  WHERE payment_reference = p_reference
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay on Delivery order was not found.';
  END IF;

  -- Idempotent webhook retry after the first successful completion.
  IF v_order.payment_method = 'pay_on_delivery'
     AND v_order.payment_status = 'paid'
     AND v_order.delivery_payment_status = 'collected'
     AND v_order.order_status = 'delivered'
     AND EXISTS (
       SELECT 1 FROM public.transactions t
       WHERE t.reference = p_reference
         AND t.user_id = v_order.buyer_id
         AND t.provider = 'paystack'
         AND t.status = 'successful'
         AND t.provider_response->>'pod_outcome' = 'verified'
     ) THEN
    RETURN jsonb_build_object('success', true, 'already_completed', true,
      'order_id', v_order.id, 'order_number', v_order.order_number,
      'payment_status', 'paid', 'delivery_payment_status', 'collected',
      'order_status', 'delivered');
  END IF;

  IF v_order.payment_method IS DISTINCT FROM 'pay_on_delivery'
     OR v_order.payment_provider IS DISTINCT FROM 'paystack'
     OR v_order.fulfillment_type IS DISTINCT FROM 'physical'
     OR v_order.payment_status IS DISTINCT FROM 'pending'
     OR v_order.delivery_payment_status IS DISTINCT FROM 'pending'
     OR v_order.order_status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This order is not awaiting Paystack Pay on Delivery payment.';
  END IF;

  IF p_provider_response->>'status' IS DISTINCT FROM 'success'
     OR p_provider_response->>'reference' IS DISTINCT FROM p_reference
     OR p_provider_response->>'currency' IS DISTINCT FROM 'NGN'
     OR p_provider_response->>'channel' IS DISTINCT FROM 'bank_transfer'
     OR p_provider_response->'metadata'->>'payment_type' IS DISTINCT FROM 'marketplace_pay_on_delivery'
     OR COALESCE(p_provider_response->'metadata'->>'order_id', '') IS DISTINCT FROM v_order.id::text THEN
    RAISE EXCEPTION 'Paystack response is not a verified bank transfer for this PanBill order.';
  END IF;

  v_expected_kobo := round(v_order.total_amount * 100);
  IF COALESCE(p_provider_response->>'amount', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Paystack amount is invalid.';
  END IF;
  v_paid_kobo := (p_provider_response->>'amount')::numeric;
  IF v_paid_kobo <> v_expected_kobo THEN
    RAISE EXCEPTION 'Paystack transfer amount does not match the order total.';
  END IF;

  SELECT * INTO v_assignment
  FROM public.marketplace_order_fulfillment_assignments
  WHERE order_id = v_order.id
    AND status = 'assigned'
    AND (
      (assignment_type = 'pickup' AND fulfillment_status = 'ready_for_collection')
      OR
      (assignment_type = 'delivery' AND fulfillment_status = 'out_for_delivery')
    )
  ORDER BY assigned_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The order must have an assigned agent who has reached the handover stage before POD payment can complete.';
  END IF;

  -- Reuse the existing checkout finalizer for exact stock-reservation consumption,
  -- payment state and transaction handling. COD remains rejected by that function.
  SELECT public.marketplace_finalize_checkout_payment(
    p_reference,
    true,
    p_provider_reference,
    p_provider_response
  ) INTO v_finalized;
  IF COALESCE(v_finalized->>'success', 'false') <> 'true' THEN
    RAISE EXCEPTION 'Marketplace payment finalization failed: %', COALESCE(v_finalized->>'message', 'unknown error');
  END IF;

  UPDATE public.transactions
  SET status = 'successful',
      provider_status = 'success',
      provider_response = COALESCE(provider_response, '{}'::jsonb)
        || p_provider_response
        || jsonb_build_object(
          'payment_type', 'marketplace_pay_on_delivery',
          'pod_outcome', 'verified',
          'pod_verified_by', 'paystack_webhook',
          'pod_assignment_id', v_assignment.id,
          'pod_agent_user_id', (SELECT user_id FROM public.marketplace_fulfillment_agents WHERE id = v_assignment.agent_id),
          'pod_verified_at', now()
        )
  WHERE reference = p_reference
    AND user_id = v_order.buyer_id
    AND provider = 'paystack';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paystack transaction record was not found after payment finalization.';
  END IF;

  UPDATE public.marketplace_orders
  SET payment_status = 'paid',
      delivery_payment_status = 'collected',
      order_status = 'delivered',
      paid_at = COALESCE(paid_at, now()),
      updated_at = now()
  WHERE id = v_order.id
    AND payment_method = 'pay_on_delivery'
    AND payment_status = 'paid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order state changed while completing verified Pay on Delivery.';
  END IF;

  UPDATE public.marketplace_order_fulfillment_assignments
  SET status = 'completed',
      fulfillment_status = CASE WHEN v_assignment.assignment_type = 'pickup' THEN 'collected' ELSE 'delivered' END,
      completed_at = now()
  WHERE id = v_assignment.id
    AND status = 'assigned'
    AND fulfillment_status = v_assignment.fulfillment_status;
  GET DIAGNOSTICS v_assignment_count = ROW_COUNT;
  IF v_assignment_count <> 1 THEN
    RAISE EXCEPTION 'Agent assignment changed while completing verified Pay on Delivery.';
  END IF;

  SELECT * INTO v_agent
  FROM public.marketplace_fulfillment_agents
  WHERE id = v_assignment.agent_id;
  INSERT INTO public.marketplace_fulfillment_agent_audit (
    agent_id, assignment_id, order_id, actor_user_id, action, details
  ) VALUES (
    v_assignment.agent_id,
    v_assignment.id,
    v_order.id,
    COALESCE(v_agent.user_id, v_order.buyer_id),
    'pod_payment_auto_confirmed',
    jsonb_build_object(
      'payment_reference', p_reference,
      'provider_reference', p_provider_reference,
      'payment_method', 'pay_on_delivery',
      'payment_channel', 'bank_transfer',
      'payment_status', 'paid',
      'delivery_payment_status', 'collected',
      'order_status', 'delivered',
      'assignment_type', v_assignment.assignment_type,
      'fulfillment_status', CASE WHEN v_assignment.assignment_type = 'pickup' THEN 'collected' ELSE 'delivered' END
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'payment_status', 'paid',
    'delivery_payment_status', 'collected',
    'order_status', 'delivered',
    'assignment_status', 'completed',
    'fulfillment_status', CASE WHEN v_assignment.assignment_type = 'pickup' THEN 'collected' ELSE 'delivered' END
  );
END;
$function$;

-- Extend the existing payout trigger without removing online Paystack or
-- agent-confirmed COD eligibility. POD requires a verified bank-transfer marker.
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
           SELECT 1 FROM public.transactions t
           WHERE t.reference = NEW.payment_reference
             AND t.user_id = NEW.buyer_id
             AND t.provider = 'cash_on_delivery'
             AND t.status = 'successful'
             AND t.provider_status = 'collected'
             AND t.provider_response->>'cod_outcome' = 'collected'
             AND t.provider_response->>'reported_role' = 'agent'
         )
       )
       OR
       (
         NEW.payment_method = 'pay_on_delivery'
         AND NEW.payment_provider = 'paystack'
         AND NEW.delivery_payment_status = 'collected'
         AND EXISTS (
           SELECT 1 FROM public.transactions t
           WHERE t.reference = NEW.payment_reference
             AND t.user_id = NEW.buyer_id
             AND t.provider = 'paystack'
             AND t.status = 'successful'
             AND t.provider_status = 'success'
             AND t.provider_response->>'pod_outcome' = 'verified'
             AND t.provider_response->>'payment_type' = 'marketplace_pay_on_delivery'
         )
       )
     ) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.marketplace_order_items WHERE order_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Cannot create seller payouts: order has no items.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (SELECT seller_id FROM public.marketplace_order_items WHERE order_id = NEW.id GROUP BY seller_id) item_sellers
    LEFT JOIN public.marketplace_sellers s ON s.user_id = item_sellers.seller_id
    WHERE s.user_id IS NULL OR s.commission_rate IS NULL OR s.commission_rate < 0 OR s.commission_rate >= 100
  ) THEN
    RAISE EXCEPTION 'Cannot create seller payouts: a seller has an invalid commission rate.';
  END IF;

  INSERT INTO public.marketplace_seller_payouts (
    seller_id, order_id, gross_amount, platform_fee, net_amount, currency,
    status, transfer_reference, provider_response, eligible_at
  )
  SELECT
    totals.seller_id,
    NEW.id,
    totals.gross_amount,
    ROUND(totals.gross_amount * s.commission_rate / 100, 2),
    ROUND(totals.gross_amount - ROUND(totals.gross_amount * s.commission_rate / 100, 2), 2),
    'NGN',
    CASE WHEN COALESCE(p.payout_enabled, false)
      AND p.verification_status = 'verified'
      AND NULLIF(TRIM(p.recipient_code), '') IS NOT NULL
      THEN 'queued' ELSE 'on_hold' END,
    'mp_' || REPLACE(gen_random_uuid()::text, '-', ''),
    jsonb_build_object(
      'source', 'marketplace_fulfillment',
      'commission_rate', s.commission_rate,
      'payment_method', NEW.payment_method,
      'payout_eligibility', CASE
        WHEN NEW.payment_method = 'cash_on_delivery' THEN 'agent_confirmed_cod'
        WHEN NEW.payment_method = 'pay_on_delivery' THEN 'verified_paystack_bank_transfer'
        ELSE 'verified_paystack'
      END
    ),
    CASE WHEN COALESCE(p.payout_enabled, false)
      AND p.verification_status = 'verified'
      AND NULLIF(TRIM(p.recipient_code), '') IS NOT NULL
      THEN NOW() ELSE NULL END
  FROM (
    SELECT seller_id, SUM(line_total) AS gross_amount
    FROM public.marketplace_order_items
    WHERE order_id = NEW.id
    GROUP BY seller_id
  ) totals
  JOIN public.marketplace_sellers s ON s.user_id = totals.seller_id
  LEFT JOIN public.marketplace_seller_payout_profiles p ON p.seller_id = totals.seller_id
  WHERE totals.gross_amount > 0
    AND totals.gross_amount - ROUND(totals.gross_amount * s.commission_rate / 100, 2) > 0
  ON CONFLICT (seller_id, order_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Extend the payout worker claim function with the same strict POD marker.
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
    JOIN public.marketplace_orders o ON o.id = p.order_id
    JOIN public.marketplace_seller_payout_profiles sp ON sp.seller_id = p.seller_id
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
        (o.payment_method = 'online' AND o.payment_provider = 'paystack' AND o.delivery_payment_status = 'not_applicable')
        OR
        (o.payment_method = 'cash_on_delivery' AND o.payment_provider = 'cash_on_delivery'
          AND o.delivery_payment_status = 'collected'
          AND EXISTS (
            SELECT 1 FROM public.transactions t
            WHERE t.reference = o.payment_reference AND t.user_id = o.buyer_id
              AND t.provider = 'cash_on_delivery' AND t.status = 'successful'
              AND t.provider_status = 'collected'
              AND t.provider_response->>'cod_outcome' = 'collected'
              AND t.provider_response->>'reported_role' = 'agent'
          ))
        OR
        (o.payment_method = 'pay_on_delivery' AND o.payment_provider = 'paystack'
          AND o.delivery_payment_status = 'collected'
          AND EXISTS (
            SELECT 1 FROM public.transactions t
            WHERE t.reference = o.payment_reference AND t.user_id = o.buyer_id
              AND t.provider = 'paystack' AND t.status = 'successful'
              AND t.provider_status = 'success'
              AND t.provider_response->>'pod_outcome' = 'verified'
              AND t.provider_response->>'payment_type' = 'marketplace_pay_on_delivery'
          ))
      )
    ORDER BY p.eligible_at, p.created_at
    LIMIT 1
    FOR UPDATE OF p SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.marketplace_seller_payouts p
    SET status = 'processing', updated_at = NOW()
    FROM candidate c
    WHERE p.id = c.id AND p.status = 'queued'
    RETURNING p.id, p.seller_id, p.order_id, p.net_amount, p.currency, p.transfer_reference
  )
  SELECT c.id, c.seller_id, c.order_id, o.order_number::text,
         c.net_amount, c.currency, c.transfer_reference, sp.recipient_code
  FROM claimed c
  JOIN public.marketplace_orders o ON o.id = c.order_id
  JOIN public.marketplace_seller_payout_profiles sp ON sp.seller_id = c.seller_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.marketplace_set_order_pay_on_delivery(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_set_order_pay_on_delivery(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.marketplace_finalize_pod_payment(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_finalize_pod_payment(text, text, jsonb) TO service_role;

COMMIT;
