-- Safe additive migration. Run in the SAME Supabase project as Partner Hub V1/V2.
-- Preserve all existing affiliate codes and click/commission history.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS direct_links_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.products.direct_links_enabled IS
  'Only enable after the product site calls /api/v2/referrals/visit and passes click_id into Partner Hub checkout.';
