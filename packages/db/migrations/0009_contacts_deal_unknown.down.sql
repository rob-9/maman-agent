-- 0009 down. Unknown collapses to false, which is what 0008 assumed.
UPDATE contacts SET has_open_deal = false WHERE has_open_deal IS NULL;
ALTER TABLE contacts ALTER COLUMN has_open_deal SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN has_open_deal SET DEFAULT false;
