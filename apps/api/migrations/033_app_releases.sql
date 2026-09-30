-- «Actualización disponible» (docs/ACTUALIZAR.md): la última versión publicada por plataforma.
-- La app compara su build con latest_build y muestra un aviso fijo hasta que la persona actualice.
-- Si su build es menor que min_build, la app pide actualizar para seguir.
CREATE TABLE app_releases (
  platform text PRIMARY KEY CHECK (platform IN ('ios', 'android')),
  latest_version text NOT NULL,
  latest_build int NOT NULL CHECK (latest_build > 0),
  min_build int NOT NULL DEFAULT 0 CHECK (min_build >= 0),
  url text NOT NULL,
  notes_es text,
  notes_en text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Lo publicado hoy (1.6.6): iOS build 23 por TestFlight/App Store, Android versionCode 25 por Google Play.
INSERT INTO app_releases (platform, latest_version, latest_build, url) VALUES
  ('ios', '1.6.6', 23, 'https://apps.apple.com/app/id6816439007'),
  ('android', '1.6.6', 25, 'https://play.google.com/store/apps/details?id=com.chaggu.app')
ON CONFLICT (platform) DO NOTHING;
