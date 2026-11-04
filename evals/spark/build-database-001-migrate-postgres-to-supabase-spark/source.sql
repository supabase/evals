CREATE TABLE teams (
  id         bigserial    PRIMARY KEY,
  name       text         NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id         bigserial    PRIMARY KEY,
  team_id    bigint       NOT NULL REFERENCES teams(id),
  email      text         NOT NULL UNIQUE,
  full_name  text         NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id          bigserial   PRIMARY KEY,
  team_id     bigint      NOT NULL REFERENCES teams(id),
  assigned_to bigint      REFERENCES members(id),
  title       text        NOT NULL,
  status      text        NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'in_progress', 'done')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_team_status_idx ON tasks(team_id, status);

INSERT INTO teams (name) VALUES
  ('Engineering'), ('Design'), ('Marketing'), ('Sales'), ('Support');

INSERT INTO members (team_id, email, full_name) VALUES
  (1, 'alice@example.com',  'Alice Chen'),
  (1, 'bob@example.com',    'Bob Smith'),
  (1, 'carol@example.com',  'Carol White'),
  (2, 'dave@example.com',   'Dave Jones'),
  (2, 'eve@example.com',    'Eve Martinez'),
  (3, 'frank@example.com',  'Frank Lee'),
  (3, 'grace@example.com',  'Grace Kim'),
  (4, 'henry@example.com',  'Henry Brown'),
  (4, 'iris@example.com',   'Iris Davis'),
  (5, 'jack@example.com',   'Jack Wilson');

INSERT INTO tasks (team_id, assigned_to, title, status) VALUES
  (1, 1,  'Set up CI pipeline',        'done'),
  (1, 2,  'Refactor auth module',       'open'),
  (1, 3,  'Fix memory leak',            'done'),
  (1, 1,  'Deploy to staging',          'in_progress'),
  (2, 4,  'Redesign dashboard',         'in_progress'),
  (2, 5,  'Prototype new onboarding',   'open'),
  (2, 4,  'Update brand guidelines',    'done'),
  (3, 6,  'Q3 campaign planning',       'done'),
  (3, 7,  'Social media calendar',      'open'),
  (4, 8,  'Prepare sales deck',         'in_progress'),
  (4, 9,  'CRM data cleanup',           'open'),
  (5, 10, 'Update help docs',           'open'),
  (5, 10, 'Respond to tickets',         'in_progress');
