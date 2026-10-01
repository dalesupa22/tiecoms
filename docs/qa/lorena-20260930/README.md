# Evidencia de QA

Estos archivos usan cuentas y contenido ficticios en una base PostgreSQL local aislada. No son capturas de la cuenta ni datos privados de Lorena.

- `today.png`, `notes.png`, `task-report.png`, `chat-preferences.png`, `drive.png`: validación visual de la web.
- `sample.docx`, `sample.xlsx`, `sample.pdf`, `sample.pptx`: documentos reales generados y descargados por el API empaquetado en Node 22 Alpine.
- `runtime.json`: tipo MIME, tamaño y privacidad de esos documentos.
- `report-example.pdf`, `report-design.png`: modelo común del reporte con datos ficticios, renderizado y revisado visualmente.

Resultados: 183 pruebas de web + 37 de API de estas mejoras + 1 adicional de respuesta de correo en vivo, todas aprobadas. La revisión de seguridad fue independiente y de solo lectura.
