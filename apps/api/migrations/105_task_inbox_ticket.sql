-- Tickets que llegan por una integración sin responsable: entran a «Nuevas» de las personas del grupo.
ALTER TABLE issue_inbox DROP CONSTRAINT IF EXISTS issue_inbox_reason_check;
ALTER TABLE issue_inbox ADD CONSTRAINT issue_inbox_reason_check CHECK (reason IN ('assigned', 'review', 'reviewed', 'ticket'));
