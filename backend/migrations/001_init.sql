-- 001_init : schéma initial
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Configuration ───────────────────────────────────────────────────────────
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_secrets (
  key         text PRIMARY KEY,
  ciphertext  bytea NOT NULL,
  iv          bytea NOT NULL,
  tag         bytea NOT NULL,
  key_version int   NOT NULL DEFAULT 1,
  hint        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE setup_state (
  id           int PRIMARY KEY CHECK (id = 1),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','draft','completed')),
  draft        jsonb NOT NULL DEFAULT '{}',
  completed_at timestamptz
);
INSERT INTO setup_state (id) VALUES (1);

CREATE TABLE payment_methods (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'mobile_money' CHECK (kind IN ('mobile_money','cash','other')),
  enabled       boolean NOT NULL DEFAULT false,
  mode          text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  online        boolean NOT NULL DEFAULT true,
  public_config jsonb NOT NULL DEFAULT '{}',
  sort_order    int NOT NULL DEFAULT 0
);
CREATE TABLE email_templates (
  code text NOT NULL, lang text NOT NULL,
  subject text NOT NULL, body_html text NOT NULL, body_text text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, lang)
);
CREATE TABLE translations_override (
  lang text NOT NULL, key text NOT NULL, value text NOT NULL,
  PRIMARY KEY (lang, key)
);
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL, mime text NOT NULL, size int NOT NULL, sha256 text NOT NULL,
  path text NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Comptes ─────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL, description text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '#94a3b8',
  is_builtin boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('customer','staff')),
  email citext, phone text,
  password_hash text,
  first_name text NOT NULL DEFAULT '', last_name text NOT NULL DEFAULT '',
  gender text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned','deleted')),
  role_id uuid REFERENCES roles(id),
  public_id text NOT NULL UNIQUE,
  totp_secret_enc text, totp_enabled boolean NOT NULL DEFAULT false, recovery_codes jsonb NOT NULL DEFAULT '[]',
  perm_version int NOT NULL DEFAULT 1,
  profile jsonb NOT NULL DEFAULT '{}',
  notes text,
  last_login_at timestamptz, last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'staff' OR role_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE email IS NOT NULL AND status <> 'deleted';
CREATE INDEX users_phone_idx ON users (phone) WHERE phone IS NOT NULL;
CREATE INDEX users_kind_idx ON users (kind, created_at DESC);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  user_agent text, ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz, replaced_by uuid
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('password_reset','email_verify','two_factor')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY, identifier text NOT NULL, ip text, success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_idx ON login_attempts (identifier, created_at DESC);

CREATE TABLE role_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id), from_role text, to_role text NOT NULL,
  changed_by uuid, reason text, created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Journal d'audit inaltérable ─────────────────────────────────────────────
CREATE SEQUENCE audit_log_seq;
CREATE TABLE audit_log (
  id bigint PRIMARY KEY,   -- attribué par le déclencheur de chaînage (voir plus bas)
  actor_id uuid, actor_public_id text, actor_name text,
  category text NOT NULL, action text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','danger')),
  target_type text, target_id text, target_name text,
  details text, diff jsonb,
  ip text,
  prev_hash text NOT NULL DEFAULT '', hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_cat_idx ON audit_log (category, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, id DESC);

CREATE FUNCTION audit_row_hash(prev text, r audit_log) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    coalesce(prev,'') || '|' || r.id::text || '|' || coalesce(r.actor_id::text,'') || '|' || r.category || '|' ||
    r.action || '|' || r.severity || '|' || coalesce(r.target_type,'') || '|' || coalesce(r.target_id,'') || '|' ||
    coalesce(r.details,'') || '|' || coalesce(r.diff::text,'') || '|' ||
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
$$;
CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(7426001);
  -- Le numéro est attribué APRÈS la prise du verrou : l'ordre des identifiants est ainsi exactement l'ordre de la chaîne,
  -- même quand plusieurs transactions écrivent en même temps.
  NEW.id := nextval('audit_log_seq');
  SELECT hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(prev, '');
  NEW.hash := audit_row_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain_trg BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log est en ajout seul' USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ── Transport ───────────────────────────────────────────────────────────────
CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name citext NOT NULL UNIQUE, region text, station_address text,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE seat_layouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE, name text NOT NULL,
  capacity int NOT NULL CHECK (capacity > 0),
  rows jsonb NOT NULL, is_builtin boolean NOT NULL DEFAULT false
);
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE, name text NOT NULL, type text NOT NULL DEFAULT '',
  layout_id uuid NOT NULL REFERENCES seat_layouts(id),
  plate_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  year_built int, amenities text[] NOT NULL DEFAULT '{}', maintenance_note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES users(id),
  first_name text NOT NULL, last_name text NOT NULL, phone text NOT NULL DEFAULT '', email text,
  license_number text NOT NULL UNIQUE, license_class text NOT NULL DEFAULT 'D', license_expiry date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','leave','suspended','resigned')),
  leave_until date, leave_reason text,
  default_vehicle_id uuid REFERENCES vehicles(id),
  hired_at date, birth_date date, address text, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_city_id uuid NOT NULL REFERENCES cities(id), to_city_id uuid NOT NULL REFERENCES cities(id),
  distance_km int NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
  duration_min int NOT NULL CHECK (duration_min > 0),
  base_price bigint NOT NULL CHECK (base_price >= 0),
  price_by_layout jsonb NOT NULL DEFAULT '{}', duration_by_layout jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  suspend_reason text, suspended_until date, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_city_id <> to_city_id)
);
CREATE UNIQUE INDEX routes_pair_uq ON routes (from_city_id, to_city_id) WHERE status <> 'deleted';
CREATE TABLE route_vehicles (
  route_id uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  PRIMARY KEY (route_id, vehicle_id)
);
CREATE TABLE trip_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES routes(id), vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  driver_id uuid REFERENCES drivers(id),
  departure_time time NOT NULL,
  recurrence text NOT NULL CHECK (recurrence IN ('once','daily','weekly','weekdays','weekends','custom')),
  days int[] NOT NULL DEFAULT '{}',
  start_date date NOT NULL, end_date date, specific_date date,
  price bigint CHECK (price IS NULL OR price >= 0),
  rank int, status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  cancel_reason text, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recurrence <> 'once' OR specific_date IS NOT NULL)
);
CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES trip_templates(id) ON DELETE SET NULL,
  route_id uuid NOT NULL REFERENCES routes(id), vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  driver_id uuid REFERENCES drivers(id), layout_id uuid NOT NULL REFERENCES seat_layouts(id),
  service_date date NOT NULL,
  departure_at timestamptz NOT NULL, arrival_at timestamptz NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  rank int,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','boarding','in_progress','completed','cancelled')),
  sales_open_at timestamptz, cancel_reason text, notes text,
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (arrival_at > departure_at),
  CONSTRAINT trips_template_date_uq UNIQUE (template_id, service_date),
  CONSTRAINT trips_vehicle_no_overlap EXCLUDE USING gist
    (vehicle_id WITH =, tstzrange(departure_at, arrival_at) WITH &&) WHERE (status <> 'cancelled')
);
CREATE INDEX trips_search_idx ON trips (route_id, service_date) WHERE status <> 'cancelled';
CREATE INDEX trips_date_idx ON trips (service_date, departure_at);
CREATE INDEX trips_driver_idx ON trips (driver_id, departure_at) WHERE driver_id IS NOT NULL;
CREATE INDEX trips_status_dep_idx ON trips (status, departure_at);

-- ── Réservations ────────────────────────────────────────────────────────────
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  trip_id uuid NOT NULL REFERENCES trips(id),
  customer_id uuid REFERENCES users(id),
  channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','counter')),
  sold_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','confirmed','cancelled','expired','completed','no_show')),
  cancel_reason text, needs_attention boolean NOT NULL DEFAULT false, attention_note text,
  subtotal bigint NOT NULL CHECK (subtotal >= 0), service_fee bigint NOT NULL DEFAULT 0 CHECK (service_fee >= 0),
  tax_amount bigint NOT NULL DEFAULT 0 CHECK (tax_amount >= 0), total bigint NOT NULL CHECK (total >= 0),
  currency text NOT NULL,
  contact_name text NOT NULL, contact_phone text NOT NULL, contact_email text,
  lang text NOT NULL DEFAULT 'fr',
  access_token_hash text NOT NULL,
  idempotency_key text UNIQUE,
  expires_at timestamptz,
  confirmed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_customer_idx ON bookings (customer_id, created_at DESC);
CREATE INDEX bookings_trip_idx ON bookings (trip_id);
CREATE INDEX bookings_expiry_idx ON bookings (expires_at) WHERE status = 'pending_payment';
CREATE INDEX bookings_created_idx ON bookings (created_at DESC);
CREATE INDEX bookings_phone_idx ON bookings (contact_phone);

CREATE TABLE seat_holds (
  token uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user uuid, channel text NOT NULL DEFAULT 'web',
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  extensions int NOT NULL DEFAULT 0
);
CREATE INDEX seat_holds_exp_idx ON seat_holds (expires_at);

CREATE TABLE trip_seats (
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seat_no text NOT NULL,
  status text NOT NULL CHECK (status IN ('held','booked')),
  hold_token uuid, hold_expires_at timestamptz,
  booking_id uuid REFERENCES bookings(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, seat_no),
  CHECK (status <> 'held' OR (hold_token IS NOT NULL AND hold_expires_at IS NOT NULL)),
  CHECK (status <> 'booked' OR booking_id IS NOT NULL)
);
CREATE INDEX trip_seats_expiry_idx ON trip_seats (hold_expires_at) WHERE status = 'held';
CREATE INDEX trip_seats_booking_idx ON trip_seats (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX trip_seats_token_idx ON trip_seats (hold_token) WHERE hold_token IS NOT NULL;

CREATE TABLE booking_passengers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  seat_no text NOT NULL,
  first_name text NOT NULL, last_name text NOT NULL, phone text NOT NULL DEFAULT '', gender text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'adult' CHECK (category IN ('adult','child')),
  price bigint NOT NULL CHECK (price >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','boarded','no_show')),
  ticket_number text UNIQUE, boarded_at timestamptz, boarded_by uuid
);
CREATE INDEX booking_passengers_booking_idx ON booking_passengers (booking_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  method text NOT NULL, mode text NOT NULL DEFAULT 'test',
  provider_ref text,
  amount bigint NOT NULL CHECK (amount > 0), currency text NOT NULL,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated','pending','succeeded','failed','expired','refund_pending','refunded','partially_refunded')),
  refunded_amount bigint NOT NULL DEFAULT 0,
  payer_phone text, failure_reason text, client_action jsonb,
  idempotency_key text UNIQUE,
  raw_last_status jsonb,
  next_check_at timestamptz, attempts int NOT NULL DEFAULT 0,
  received_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz
);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (method, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE INDEX payments_recon_idx ON payments (next_check_at) WHERE status IN ('initiated','pending');
CREATE INDEX payments_succeeded_idx ON payments (succeeded_at) WHERE succeeded_at IS NOT NULL;

CREATE TABLE payment_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL, event_key text NOT NULL UNIQUE,
  payment_id uuid REFERENCES payments(id),
  payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, result text
);
CREATE TABLE payment_simulations (
  provider_ref text PRIMARY KEY, method text NOT NULL, amount bigint NOT NULL,
  scenario text NOT NULL, final_status text NOT NULL, ready_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id), booking_id uuid NOT NULL REFERENCES bookings(id),
  amount bigint NOT NULL CHECK (amount > 0), reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed','manual')),
  provider_ref text, requested_by uuid, attempts int NOT NULL DEFAULT 0, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX refunds_status_idx ON refunds (status, created_at);
CREATE TABLE idempotency_keys (
  scope text NOT NULL, key text NOT NULL,
  request_hash text NOT NULL, status_code int, response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

-- ── Communication ───────────────────────────────────────────────────────────
CREATE TABLE notifications_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  recipient text NOT NULL, template text NOT NULL, lang text NOT NULL DEFAULT 'fr',
  vars jsonb NOT NULL DEFAULT '{}', subject text, body text,
  attach_booking_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','simulated','failed')),
  attempts int NOT NULL DEFAULT 0, last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX outbox_pending_idx ON notifications_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX outbox_created_idx ON notifications_outbox (created_at DESC);

CREATE TABLE ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL, description text NOT NULL DEFAULT '',
  image_url text, image_position text, image_size text, link_url text, link_label text,
  bg_color text NOT NULL DEFAULT '#1d4ed8', text_color text NOT NULL DEFAULT '#ffffff',
  position text NOT NULL DEFAULT 'banner_top', pages text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  start_date date NOT NULL, end_date date NOT NULL, priority int NOT NULL DEFAULT 5,
  display_type text NOT NULL DEFAULT 'banner', notif_duration int NOT NULL DEFAULT 8, notif_position text,
  carousel_interval int NOT NULL DEFAULT 6,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ad_stats_daily (
  ad_id uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE, day date NOT NULL,
  views int NOT NULL DEFAULT 0, clicks int NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_id, day)
);
CREATE TABLE jobs_log (
  id bigserial PRIMARY KEY, job text NOT NULL, ok boolean NOT NULL, info text,
  started_at timestamptz NOT NULL, duration_ms int NOT NULL
);
CREATE INDEX jobs_log_idx ON jobs_log (job, id DESC);
