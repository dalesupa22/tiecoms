# Lista de lectura («Para leer» + «Resúmeme todo»)

Para lo que te mandan a toda hora (p. ej. tu papá por WhatsApp): artículos, videos y tweets.

- **Entrada:** en WhatsApp, panel del chat › «📚 Enlaces a Ver después» (`wa_chats.reading_list`, migración 101). Los enlaces que llegan a ese chat (no los que tú envías) entran solos a `reading_items` (job `reading.scan` cada minuto; al encender trae los últimos 30 días). Sin repetir por URL. También desde una IA: `add_to_reading`.
- **Dónde se ve:** «Ver después» (`/ver-despues`) › «📚 Para leer de WhatsApp», junto a lo que guardaste en chaggu.
- **«✨ Resúmeme todo»** (`POST /api/v1/reading/digest`, MCP `summarize_reading`): hasta 15 por vez, de los más viejos a los más nuevos. Cada enlace se resume por su contenido:
  - artículos: el texto de la página;
  - X/Twitter: el texto completo del post (API pública de fxtwitter);
  - YouTube: subtítulos si YouTube los entrega (hoy casi nunca desde un servidor: piden un token) y si no, la **descripción completa** del video; el resumen lo aclara;
  - lo demás: título y descripción.
  Luego arma un resumen general por temas con «Lo más importante» y marca leídos los que pudo resumir (`mark_read=false` para no marcarlos). Resúmenes por URL en caché (`link_summaries`).
- **MCP** (permiso `reading`): `list_reading`, `summarize_reading`, `mark_reading`, `add_to_reading`, `set_whatsapp_reading`.
- **Privacidad:** todo es por persona; respeta los chats bloqueados de WhatsApp. Código: `apps/api/src/modules/reading.ts`; pruebas: `apps/api/test/lectura.test.ts`.
