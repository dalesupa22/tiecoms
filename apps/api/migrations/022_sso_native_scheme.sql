-- Chaggu: las apps nuevas (com.chaggu.app) vuelven del inicio de sesión a chaggu://;
-- las publicadas con el nombre anterior siguen en tiecoms:// (native_scheme NULL).
ALTER TABLE sso_flows ADD COLUMN IF NOT EXISTS native_scheme text;
