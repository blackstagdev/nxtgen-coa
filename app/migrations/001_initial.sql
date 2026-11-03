-- NxtGen Analysis COA platform: initial schema
-- gen_random_uuid() is built into PostgreSQL 13+; no extension required.

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin', 'reviewer', 'staff')),
  password_hash   text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,           -- sha256 of the opaque session token
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_type             text NOT NULL,
  definition_version    integer NOT NULL,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'unpublished', 'archived')),
  verification_key      text NOT NULL,
  report_number         text,                -- optional human identifier (e.g. Endotoxin report ID)
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- current (draft) structured form data
  internal_notes        text NOT NULL DEFAULT '',             -- staff-only, never public
  client_email          text,                -- staff-only; links report to a Shopify customer
  shopify_customer_id   text,                -- cached match from the app proxy (staff-only)
  is_test_fixture       boolean NOT NULL DEFAULT false,
  published_version_id  uuid,
  created_by            uuid REFERENCES users(id),
  updated_by            uuid REFERENCES users(id),
  published_by          uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  published_at          timestamptz,
  first_published_at    timestamptz,
  archived_at           timestamptz
);
CREATE UNIQUE INDEX reports_verification_key_key ON reports (verification_key);
CREATE UNIQUE INDEX reports_report_number_key ON reports (lower(report_number)) WHERE report_number IS NOT NULL;
CREATE INDEX reports_status_idx ON reports (status);
CREATE INDEX reports_client_email_idx ON reports (lower(client_email));
CREATE INDEX reports_customer_idx ON reports (shopify_customer_id);
CREATE INDEX reports_updated_idx ON reports (updated_at DESC);

CREATE TABLE report_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id          uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  version_no         integer NOT NULL,
  data               jsonb NOT NULL,          -- immutable snapshot of the data used to render
  data_hash          text NOT NULL,
  definition_version integer NOT NULL,
  renderer_version   text NOT NULL,
  status             text NOT NULL CHECK (status IN ('rendering', 'ready', 'failed')),
  error              text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version_no)
);

ALTER TABLE reports
  ADD CONSTRAINT reports_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES report_versions(id);

CREATE TABLE report_version_pages (
  version_id   uuid NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
  page_no      integer NOT NULL,
  private_key  text NOT NULL,
  public_key   text,
  width        integer NOT NULL,
  height       integer NOT NULL,
  bytes        integer NOT NULL,
  sha256       text NOT NULL,
  PRIMARY KEY (version_id, page_no)
);

CREATE TABLE report_uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  field_key    text NOT NULL,
  private_key  text NOT NULL,
  mime         text NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  bytes        integer NOT NULL,
  sha256       text NOT NULL,
  original_name text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_uploads_report_idx ON report_uploads (report_id);

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  report_id   uuid REFERENCES reports(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_report_idx ON audit_events (report_id, created_at DESC);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);

CREATE TABLE shopify_installations (
  shop               text PRIMARY KEY,
  access_token_enc   text NOT NULL,
  scopes             text NOT NULL,
  installed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_states (
  state       text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Simple fixed-window rate limiting shared across instances
CREATE TABLE rate_limits (
  bucket       text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL
);
