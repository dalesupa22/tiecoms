# Agenda: un color por grupo (28-sep-2026)

La Agenda general muestra los eventos de todos los grupos donde estoy. Cada grupo tiene su color, el mismo en web,
iOS y Android. Una leyenda arriba lista los grupos que tienen eventos en lo que se ve; tocar uno lo oculta o lo muestra
(preferencia local del dispositivo) y «Mostrar todos» limpia los ocultos.

## Algoritmo (idéntico en los tres clientes)

```
h = 0 (uint32)
para cada carácter del conversationId (UTF-16):  h = (h * 31 + código) mod 2^32
índice = h mod 10
```

Referencia: `packages/client-core/src/group-colors.ts` (`groupColor`, `groupColorIndex`). Casos de prueba:

| conversationId | índice |
|---|---|
| `3a916cc9-0411-4068-be9d-f22075045494` | 1 |
| `e1c94905-862f-4e70-9653-5d0e195910e9` | 4 |

## Paleta (fondo / texto)

| # | fondo | texto | nombre |
|---|---|---|---|
| 0 | `#DCE8FB` | `#1E4E9C` | azul |
| 1 | `#D7F0E2` | `#17603D` | verde |
| 2 | `#E9DEFB` | `#5B32A8` | morado |
| 3 | `#D3EEF0` | `#0A5F67` | turquesa |
| 4 | `#FBDDEB` | `#962868` | rosado |
| 5 | `#FDE8CF` | `#8A4B0B` | naranja |
| 6 | `#E2E4F8` | `#3C4196` | índigo |
| 7 | `#F9DADA` | `#9B2525` | rojo |
| 8 | `#EEF3C9` | `#5B6412` | oliva |
| 9 | `#F6EDC4` | `#735600` | ámbar |

En la leyenda, el punto usa el color de texto. En modo oscuro se puede usar el color de texto como fondo del chip
con texto blanco.

## Eventos de día completo

Un evento es de «día completo» si, en la hora local de quien mira, empieza a las 00:00 y termina a las 23:59 (o a
las 00:00 del día siguiente), y dura al menos 23 h 59 min. En vez de «12:00 a. m.» se muestra **«Todo el día»**
(`All day`). En la vista de semana o día van en una franja arriba de las horas, no en la grilla. En listas van antes
que los eventos con hora de ese día.
