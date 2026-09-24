-- US6 — consent to send merchant names to a model.
--
-- A timestamp rather than a boolean: the question a reviewer, or the user, asks
-- later is "when did I agree to this", and NULL answers "never, or not any
-- more". Revoking sets it back to NULL, which is why there is no separate
-- revoked_at — a consent that has been withdrawn is not a consent with a date.
--
-- TIMESTAMPTZ, as every audit column here is. It is an instant, not a calendar
-- date, and it is never compared against occurred_on.
ALTER TABLE "users"
  ADD COLUMN "semantic_grouping_consented_at" TIMESTAMPTZ(6);
