-- Runs without an error, but takes the row that the runner records it with, so the
-- runner's own INSERT into schema_migrations fails after this file has run.
CREATE TABLE tags (note_id integer NOT NULL, tag text NOT NULL);
INSERT INTO public.schema_migrations (version, name, checksum) VALUES (2, 'taken', 'taken');
