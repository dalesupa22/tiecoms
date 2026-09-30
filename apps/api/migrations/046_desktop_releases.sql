-- «Actualización disponible» también en escritorio (docs/ACTUALIZAR.md, pedido de Danny 30-sep-2026).
-- En mac/windows latest_build es la versión como número: 0.2.0 → 200 (mayor·10000 + menor·100 + parche).
ALTER TABLE app_releases DROP CONSTRAINT IF EXISTS app_releases_platform_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_platform_check CHECK (platform IN ('ios', 'android', 'mac', 'windows'));
INSERT INTO app_releases (platform, latest_version, latest_build, url) VALUES
  ('mac', '0.2.0', 200, 'https://www.chaggu.com/'),
  ('windows', '0.2.0', 200, 'https://www.chaggu.com/')
ON CONFLICT (platform) DO NOTHING;
