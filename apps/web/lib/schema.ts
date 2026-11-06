/**
 * Database schema. Idempotent: applied on first use by every server instance.
 * Revisions are append-only; "undo" and "restore" write a new revision, so
 * history is never rewritten.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  pin_hash        TEXT,
  failed_pins     INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_codes (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  code_hash       TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_codes_email_idx ON email_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS designs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  current_rev     INTEGER NOT NULL DEFAULT 1,
  archived        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS designs_owner_idx ON designs (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS revisions (
  design_id       TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL,
  -- The revision whose state this one was derived from; undo returns to it.
  parent          INTEGER,
  -- For undo/redo/restore: the original edit whose state this revision repeats.
  source          INTEGER,
  label           TEXT,
  request         TEXT NOT NULL,
  summary         TEXT NOT NULL,
  ops             JSONB NOT NULL DEFAULT '[]'::jsonb,
  model           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id, number)
);

CREATE TABLE IF NOT EXISTS shares (
  token           TEXT PRIMARY KEY,
  design_id       TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  revision        INTEGER,
  revoked         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_design_idx ON shares (design_id);

-- Agent runs ("Fix the issues"): work on a draft; nothing is saved to the design until Keep.
CREATE TABLE IF NOT EXISTS agent_runs (
  id              TEXT PRIMARY KEY,
  design_id       TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,           -- running | done | failed | kept | discarded
  outcome         TEXT,                    -- fixed | stuck | limit | stopped | nothing
  base_rev        INTEGER NOT NULL,
  model           JSONB NOT NULL,          -- the draft as it stands
  steps           JSONB NOT NULL DEFAULT '[]',
  before_score    JSONB,
  after_score     JSONB,
  remaining       JSONB,
  message         TEXT,
  mode            TEXT,                    -- claude | rules
  tokens          INTEGER NOT NULL DEFAULT 0,
  stop_requested  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_design_idx ON agent_runs (design_id, created_at DESC);
`;
