#!/usr/bin/env node
/**
 * Genera Localizable.strings (es/en) de la app iOS a partir de los textos de la web
 * (apps/web/src/i18n.ts, fuente de verdad) + los propios de iOS (tools/ios-strings.json).
 * Si una clave existe en ambos, gana la web: así los textos son los mismos en todas las apps.
 *
 *   node apps/ios/tools/gen-strings.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const src = readFileSync(join(root, 'apps/web/src/i18n.ts'), 'utf8');

function objectLiteral(startToken) {
  const i = src.indexOf(startToken);
  if (i < 0) throw new Error(`No encontré ${startToken}`);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (ch === "'" || ch === '"' || ch === '`') { const q = ch; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (ch === '/' && src[k + 1] === '/') { while (src[k] !== '\n') k++; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return new Function(`return ${src.slice(j, k + 1)}`)();
}

const web = { es: objectLiteral('const es = {'), en: objectLiteral('const en: Record<Key, string> = {') };
const ios = JSON.parse(readFileSync(join(here, 'ios-strings.json'), 'utf8'));
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

for (const [i, lang] of ['es', 'en'].entries()) {
  const out = { ...Object.fromEntries(Object.entries(ios).map(([k, v]) => [k, v[i]])), ...web[lang] };
  const lines = Object.keys(out).sort().map((k) => `"${k}" = "${esc(out[k])}";`);
  const header = `/* Generado por apps/ios/tools/gen-strings.mjs desde apps/web/src/i18n.ts + ios-strings.json. No editar a mano. */\n\n`;
  writeFileSync(join(here, '..', 'TieComs/Resources', `${lang}.lproj/Localizable.strings`), header + lines.join('\n') + '\n');
  console.log(lang, lines.length, 'claves');
}
