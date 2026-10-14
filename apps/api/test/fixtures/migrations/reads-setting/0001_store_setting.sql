CREATE TABLE seen (value text);
INSERT INTO seen SELECT pg_catalog.current_setting('rff.fixture_value', true);
