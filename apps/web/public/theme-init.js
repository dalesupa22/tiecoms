// Tema antes del primer pintado (sin destello blanco en modo oscuro). Archivo aparte y no inline:
// la CSP de producción (script-src 'self') y la de la app de escritorio bloquean scripts inline.
// La misma regla que src/theme.ts: «chaggu:theme» = light | dark; sin valor, sigue al sistema.
(function () {
  var p = null;
  try { p = localStorage.getItem('chaggu:theme'); } catch (e) { /* sin almacenamiento */ }
  var dark = p === 'dark' || (p !== 'light' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.backgroundColor = dark ? '#151413' : '#f4f1ea';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#151413' : '#f4f1ea');
})();
