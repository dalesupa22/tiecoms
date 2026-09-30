-- Citas por enlace, tipo Calendly (docs/CITAS.md). Una página pública (cita.chaggu.com/<slug>) deja que cualquier
-- persona, sin cuenta, reserve un horario libre del equipo: el evento se crea en el calendario real de quien atiende.

CREATE TABLE booking_pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id         uuid REFERENCES organizations(id) ON DELETE SET NULL,
  title          text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  title_en       text CHECK (char_length(title_en) <= 120),
  description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  description_en text CHECK (char_length(description_en) <= 1000),
  -- collective: hay que coincidir con TODOS los anfitriones; round_robin: basta uno libre (se reparte entre el equipo).
  mode           text NOT NULL CHECK (mode IN ('collective','round_robin')),
  duration_min   int  NOT NULL CHECK (duration_min BETWEEN 10 AND 240),
  buffer_min     int  NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  step_min       int  NOT NULL DEFAULT 30 CHECK (step_min BETWEEN 5 AND 240),
  min_notice_min int  NOT NULL DEFAULT 240 CHECK (min_notice_min BETWEEN 0 AND 43200),
  horizon_days   int  NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 180),
  timezone       text NOT NULL DEFAULT 'America/Bogota',
  -- Horario de atención por día de la semana (0 = domingo): {"1":[["09:00","12:00"],["14:00","17:00"]], ...}
  hours          jsonb NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE booking_page_hosts (
  page_id  uuid NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position int  NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX booking_page_hosts_user ON booking_page_hosts(user_id);

CREATE TABLE bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       uuid NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
  guest_name    text NOT NULL CHECK (char_length(guest_name) BETWEEN 1 AND 120),
  guest_email   text NOT NULL CHECK (char_length(guest_email) BETWEEN 3 AND 254),
  guest_note    text NOT NULL DEFAULT '' CHECK (char_length(guest_note) <= 2000),
  guest_tz      text NOT NULL DEFAULT 'UTC',
  lang          text NOT NULL DEFAULT 'es' CHECK (lang IN ('es','en')),
  -- Quien atiende: en collective, todos; en round_robin, uno. El primero es el organizador del evento en su calendario.
  organizer_id  uuid NOT NULL REFERENCES users(id),
  host_ids      uuid[] NOT NULL,
  -- pending: reservado mientras se crea el evento (caduca a los 3 min); confirmed; cancelled; failed.
  status        text NOT NULL CHECK (status IN ('pending','confirmed','cancelled','failed')),
  provider      text CHECK (provider IN ('google','microsoft')),
  external_id   text,
  join_url      text,
  manage_hash   bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  cancelled_at  timestamptz,
  cancelled_by  text CHECK (cancelled_by IN ('guest','host'))
);
CREATE INDEX bookings_hosts ON bookings USING gin (host_ids);
CREATE INDEX bookings_page_time ON bookings(page_id, starts_at) WHERE status IN ('pending','confirmed');
CREATE INDEX bookings_email ON bookings(guest_email, created_at);
