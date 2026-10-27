export function commissionAmount(eligibleCents, rateBps) {
  // integer minor units; conventional half-up rounding
  return Number((BigInt(eligibleCents) * BigInt(rateBps) + 5000n) / 10000n);
}

export function withinCommissionDuration(start, at, months) {
  if (new Date(at) < new Date(start)) return false;
  if (months == null) return true;
  const d = new Date(start);
  const cutoff = new Date(d);
  // Set to first of month temporarily to avoid Jan 31 => Mar 3 rollover.
  const day = d.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() + months);
  const last = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, last));
  return new Date(at) < cutoff;
}

