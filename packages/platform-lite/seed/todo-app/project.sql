CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false
);

INSERT INTO todos (title) VALUES
  ('Buy groceries'),
  ('Walk the dog'),
  ('Read a book');
