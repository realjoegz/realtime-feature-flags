CREATE TABLE tags (note_id integer NOT NULL REFERENCES notes (id), tag text NOT NULL);
INSERT INTO tags VALUES (1, 'from 0002');
