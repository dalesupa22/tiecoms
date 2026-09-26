# Fixtures de pruebas (solo API local)

Nunca contra producción: cada script falla si la URL no es localhost.

```bash
API_URL=http://localhost:3050 FIXTURE_OUT=/tmp/fx.json node apps/ios/tools/fixtures/grupos-fixture.mjs
node apps/ios/tools/fixtures/seed-reactions.mjs /tmp/fx.json               # reacciones en el grupo general
node apps/ios/tools/fixtures/seed-image-messages.mjs /tmp/fx.json /tmp/images.json   # archivo, 3 fotos, foto mía, con texto, ajena
PORT=3059 node apps/ios/tools/fixtures/limit-proxy.mjs &                     # 413 con el límite viejo de nginx (128 KB)

cd apps/ios
TEST_RUNNER_TC_FIXTURE_GRUPOS=/tmp/fx.json TEST_RUNNER_TC_IMAGES=/tmp/images.json TEST_RUNNER_TC_SHOTS=/tmp/shots \
  xcodebuild test -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 16e' -only-testing:TieComsUITests/GroupsUITests
TEST_RUNNER_TC_FIXTURE_MEDIA=/tmp/fx.json TEST_RUNNER_TC_LIMITED_API=http://127.0.0.1:3059 \
  xcodebuild test -scheme TieComs -destination 'platform=iOS Simulator,name=iPhone 16e' -only-testing:TieComsTests
```

Las contraseñas son aleatorias y solo quedan en el JSON del fixture. Usa un fixture nuevo por corrida de UI: sembrar muchas
veces el mismo chat lo agranda y XCTest tarda demasiado en leer la pantalla.
