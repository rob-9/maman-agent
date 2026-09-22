-- 0014 down.
ALTER TABLE threads DROP COLUMN IF EXISTS chase_count;
ALTER TABLE obligations DROP COLUMN IF EXISTS applied_intent_id;
DELETE FROM obligations WHERE outcome = 'skipped';
ALTER TABLE obligations DROP CONSTRAINT IF EXISTS obligations_outcome_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_outcome_check
  CHECK (outcome IN ('pending', 'drafted', 'snoozed', 'dismissed', 'resolved'));
DROP TABLE IF EXISTS intents;
