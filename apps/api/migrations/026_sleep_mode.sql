-- Modo sueño: horario de descanso diario en la zona horaria de cada persona.
-- Dentro de la ventana no sale ningún push (igual que «No molestar»); los no leídos se cuentan igual.
-- Encendido por defecto de 22:00 a 07:00 (hora de Colombia) hasta que la persona lo cambie.
-- sleep_tz_auto: el cliente puede ajustar la zona al detectar otra (viajes), mientras la persona no la fije.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sleep_on boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sleep_start time NOT NULL DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS sleep_end time NOT NULL DEFAULT '07:00',
  ADD COLUMN IF NOT EXISTS sleep_tz text NOT NULL DEFAULT 'America/Bogota',
  ADD COLUMN IF NOT EXISTS sleep_tz_auto boolean NOT NULL DEFAULT true;

-- ¿Está dormida ahora? Ventanas que cruzan la medianoche (22:00 → 07:00) incluidas.
CREATE OR REPLACE FUNCTION tiecoms_sleeping(p_on boolean, p_start time, p_end time, p_tz text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_on AND p_start <> p_end AND (
    CASE WHEN p_start < p_end
      THEN (now() AT TIME ZONE p_tz)::time >= p_start AND (now() AT TIME ZONE p_tz)::time < p_end
      ELSE (now() AT TIME ZONE p_tz)::time >= p_start OR (now() AT TIME ZONE p_tz)::time < p_end
    END)
$$;
