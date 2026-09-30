import { describe, expect, it } from 'vitest';
import { ggRanges } from '../src/chat17.ts';

describe('@gg se resalta con el degradado', () => {
  it('encuentra @gg como palabra', () => {
    expect(ggRanges('@gg qué tiene César mañana')).toEqual([{ start: 0, length: 3 }]);
    expect(ggRanges('Hola @GG, y tú @gg?')).toEqual([{ start: 5, length: 3 }, { start: 15, length: 3 }]);
  });
  it('no confunde correos, @ggg ni palabras', () => {
    expect(ggRanges('escribe a ana@gg.com')).toEqual([]);
    expect(ggRanges('@ggg y huggg')).toEqual([]);
  });
});
