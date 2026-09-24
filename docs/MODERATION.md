# Reportes y bloqueos

Las apps permiten reportar mensajes/personas y bloquear contacto. El bloqueo impide nuevos directos, envíos directos en ambos sentidos y nuevos chats grupales iniciados con esa persona. Las apps ocultan sus mensajes en grupos compartidos. Se puede desbloquear desde Ajustes.

`POST /api/v1/reports` guarda el reporte antes de responder. Un trabajo con reintentos avisa a `admin@tiecoms.com` (configurable con `MODERATION_EMAIL`); el correo contiene únicamente la referencia, no el mensaje privado. El operador debe revisar y responder a los reportes, incluidos los trabajos de notificación fallidos. No hay moderación automática ni garantía de plazo de respuesta implementada.

La cola y las acciones requieren acceso SSH al servidor:

```bash
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node moderation.js list'
# Sustituir el UUID por uno de la cola y dejar un motivo concreto.
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node moderation.js resolve UUID remove-message "Motivo de la retirada"'
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node moderation.js resolve UUID suspend-user "Motivo de la suspensión"'
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node moderation.js resolve UUID dismiss "Motivo del cierre"'
```

Retirar un mensaje elimina el texto servido y publica la actualización. Suspender una cuenta impide nuevas llamadas y revoca sus sesiones. Cada decisión queda auditada. Los reportes (incluida la copia del contenido denunciado) y la auditoría se purgan a los 24 meses por el worker.

# Eliminación de cuenta

`DELETE /api/v1/account` confirma el correo y, si la cuenta tiene contraseña, la vuelve a pedir. Anonimiza el perfil, elimina las identidades SSO, preferencias, recordatorios, carpetas personales y suscripciones push, revoca sesiones, retira membresías y desconecta WhatsApp (el puente borra sus credenciales/chats privados). Los mensajes y archivos ya compartidos permanecen como registro del espacio; también pueden existir datos personales escritos voluntariamente dentro de ese contenido.

Fotos y archivos personales dejan de estar disponibles en TieComs inmediatamente. Los trabajos `account.delete_file` eliminan después sus objetos S3 con reintentos y borran su registro. El permiso `s3:DeleteObject` debe estar habilitado en los prefijos `tiecoms/avatars/*` y `tiecoms/drive/me/*` del bucket configurado. El worker NO trata permisos denegados como un borrado exitoso. Antes de publicar, comprobar esa autorización y la ausencia de trabajos fallidos. No se borran archivos de espacios compartidos por esta vía. Las copias locales, cachés y backups se rigen por sus políticas de retención.

## Permiso de almacenamiento pendiente al preparar esta release

El usuario del almacenamiento es `XerticomsAppReadWrite` de la cuenta AWS `954976327090`, bucket `xerticoms`. El perfil AWS local disponible pertenece a otra cuenta, por lo que no sirve para cambiar esta política. Un administrador de la cuenta correcta puede aplicar el JSON acotado de `infra/iam/account-deletion-s3-policy.json`:

```bash
aws sts get-caller-identity  # debe identificar la cuenta 954976327090
aws iam put-user-policy --user-name XerticomsAppReadWrite --policy-name TieComsDeletePersonalAccountObjects --policy-document file://infra/iam/account-deletion-s3-policy.json
```

Si otra política contiene un `Deny` explícito, el administrador debe acotarlo para permitir únicamente estos dos prefijos; un `Allow` no anula un `Deny`. No dar permisos sobre archivos de espacios compartidos ni sobre el bucket entero. Comprobar también la retención/versionado del bucket: borrar la versión actual no purga versiones históricas protegidas por una política de backup.

Después, probar con un objeto sintético, revisar la cola y reintentar los borrados fallidos:

```bash
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node deletion.js probe'
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node deletion.js status'
ssh ReimaginedClubServer 'docker exec tiecoms-api-1 node deletion.js retry-failed'
```

El último comando vuelve a poner en cola solo trabajos fallidos de borrado personal; el worker ejecuta y verifica el permiso real. El `probe` no toca cuentas ni archivos existentes. Si el permiso falla deja una ruta `avatars/deletion-probe-*.txt` identificable para su limpieza posterior.
