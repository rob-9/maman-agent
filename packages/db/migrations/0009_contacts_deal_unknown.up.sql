-- 0009: deal state is tri-state. NULL means "no CRM has said".
--
-- 0008 declared has_open_deal NOT NULL DEFAULT false, which makes a contact
-- synced from Gmail alone look CLOSED — and the detector suppresses closed
-- relationships, so a user who has not connected a CRM yet would see nothing.
-- That is every user on day one. Unknown must pass through and rank below a
-- known-open deal: the CRM's answer promotes, it does not unlock.

ALTER TABLE contacts ALTER COLUMN has_open_deal DROP DEFAULT;
ALTER TABLE contacts ALTER COLUMN has_open_deal DROP NOT NULL;
