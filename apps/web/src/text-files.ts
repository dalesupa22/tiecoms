/**
 * Archivos de texto y código que se abren en el visor/editor (CodeSheet.tsx) en vez de solo descargarse
 * (pedido de Danny, 5-oct-2026: «abrir un editor o un visualizador de código»). Aquí no se importa CodeMirror:
 * esto se evalúa en cada burbuja y el editor se descarga solo al abrir un archivo.
 */
/** Hasta este tamaño se abre en el visor; más grande, solo descarga (el navegador se pondría lento). */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'ndjson', 'geojson',
  'xml', 'svg', 'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'vue', 'svelte', 'astro', 'py', 'pyi', 'ipynb', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'go', 'rs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'swift', 'm', 'mm', 'dart', 'lua', 'pl', 'pm', 'r', 'jl', 'ex',
  'exs', 'erl', 'hs', 'clj', 'elm', 'sql', 'graphql', 'gql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'editorconfig', 'gitignore', 'dockerignore',
  'dockerfile', 'makefile', 'mk', 'cmake', 'tf', 'tfvars', 'hcl', 'nix', 'diff', 'patch', 'tex', 'bib', 'srt', 'vtt',
  'http', 'rest', 'prisma', 'sol', 'zig', 'v', 'vhd', 'asm', 's', 'wat', 'liquid', 'hbs', 'mustache', 'ejs', 'pug',
]);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'jenkinsfile', 'readme', 'license', 'changelog', '.env', '.gitignore', '.npmrc', '.bashrc', '.zshrc']);
const TEXT_MIMES = /^(text\/|application\/(json|ld\+json|xml|javascript|ecmascript|typescript|x-(sh|shellscript|python|ruby|perl|php|yaml|toml|httpd-php|sql|tex|javascript|typescript)|yaml|toml|sql|graphql|x-ndjson|csv)\b)/i;

export function fileExt(name: string) {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? '';
  return base.includes('.') ? base.split('.').pop()! : '';
}

/** ¿Se abre en el visor de código? Por tipo o por extensión (muchos llegan como application/octet-stream). */
export function isTextFile(a: { contentType: string; name: string }) {
  const mime = a.contentType.split(';')[0]!.trim().toLowerCase();
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return false;
  if (mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf') return false;
  const base = a.name.toLowerCase().split(/[\\/]/).pop() ?? '';
  return TEXT_MIMES.test(mime) || TEXT_EXTENSIONS.has(fileExt(a.name)) || TEXT_NAMES.has(base);
}

/** Heurística de binario: bytes nulos o demasiados caracteres de control en el inicio. */
export function looksBinary(bytes: Uint8Array) {
  const n = Math.min(bytes.length, 8192);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return n > 0 && control / n > 0.1;
}
