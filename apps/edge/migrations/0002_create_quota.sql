-- How many plans each visitor started each day (by a hash of their address, never the
-- address itself), so one visitor can't fill the store. Rows older than two days are pruned.
CREATE TABLE create_quota (
  client TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (client, day)
);
