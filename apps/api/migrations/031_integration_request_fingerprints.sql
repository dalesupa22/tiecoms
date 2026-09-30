-- Existing receipts stay replayable; new requests bind a key to one operation and canonical payload.
ALTER TABLE integration_requests ADD COLUMN request_hash bytea;
