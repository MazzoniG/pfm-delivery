-- Exists so `prisma migrate deploy` has a migration to apply on cold start,
-- which is what proves the container entrypoint works before US1 adds schema.
SELECT 1;
