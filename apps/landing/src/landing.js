(() => {
  const header = document.querySelector('[data-header]');
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const stage = document.querySelector('[data-stage]');
  const cards = [...document.querySelectorAll('[data-card]')];
  const railSteps = [...document.querySelectorAll('.rail-step')];
  const scenes = [...document.querySelectorAll('[data-story-beat]')];
  const phaseNumber = document.querySelector('[data-phase-number]');
  const phaseTitle = document.querySelector('[data-phase-title]');
  const phaseDescription = document.querySelector('[data-phase-description]');
  const stageLabel = document.querySelector('[data-stage-label]');
  const stageCounter = document.querySelector('[data-stage-counter]');
  const stageProgress = document.querySelector('[data-stage-progress]');
  const journeyStatus = document.querySelector('[data-journey-status]');
  const traveler = document.querySelector('[data-traveler]');
  const activePath = document.querySelector('[data-draw-path]');
  const tags = [...document.querySelectorAll('.route-tag')];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const phasesEs = [
    {title:'Todo empieza con una persona.', description:'Ana necesita una respuesta. La conversación reúne al cliente y a su equipo, con el mismo contexto.', label:'CLIENTE + EQUIPO', status:'El hilo nace donde sucede el trabajo.', point:[530,330], tag:0},
    {title:'El equipo abre un espacio propio.', description:'La pregunta llega al equipo correcto sin copiar, pegar ni perder el contexto original.', label:'EQUIPO INTERNO', status:'La pregunta encuentra a quien puede resolverla.', point:[780,495], tag:0},
    {title:'Otra empresa entra en acción.', description:'Nexo recibe solo lo necesario para avanzar. Dos empresas, un mismo objetivo y una frontera clara.', label:'ESTUDIO NORTE × NEXO', status:'El contexto cruza empresas con permiso.', point:[1180,495], tag:1},
    {title:'Un bot ayuda. Una persona decide.', description:'Ruta propone una respuesta con la información del hilo. Lucía la revisa y la aprueba.', label:'BOT + HUMANO', status:'La IA acelera. La decisión sigue siendo humana.', point:[1280,935], tag:2},
    {title:'La respuesta regresa a casa.', description:'Ana recibe el resultado sin perseguir a nadie. El recorrido queda visible para todo el equipo.', label:'RESULTADO COMPARTIDO', status:'La conversación vuelve con todo su recorrido.', point:[350,510], tag:3}
  ];

  const phasesEn = [
    {title:'It all starts with one person.', description:'Ana needs an answer. The conversation brings the client and their team together, with the same context.', label:'CLIENT + TEAM', status:'The thread is born where the work happens.', point:[530,330], tag:0},
    {title:'The team opens its own space.', description:'The question reaches the right team without copying, pasting or losing the original context.', label:'INTERNAL TEAM', status:'The question finds whoever can solve it.', point:[780,495], tag:0},
    {title:'Another company steps in.', description:'Nexo receives only what it needs to move forward. Two companies, one goal and a clear boundary.', label:'ESTUDIO NORTE × NEXO', status:'Context crosses companies with permission.', point:[1180,495], tag:1},
    {title:'A bot helps. A person decides.', description:'Ruta proposes an answer using the thread. Lucía reviews and approves it.', label:'BOT + HUMAN', status:'AI speeds things up. The decision stays human.', point:[1280,935], tag:2},
    {title:'The answer comes home.', description:'Ana gets the result without chasing anyone. The whole journey stays visible to the team.', label:'SHARED RESULT', status:'The conversation returns with its full journey.', point:[350,510], tag:3}
  ];
  // La misma animación sirve para /(es) y /en/: los textos salen del idioma de la página.
  const phases = document.documentElement.lang === 'en' ? phasesEn : phasesEs;

  function setPhase(index, scrollIntoView = false) {
    const phase = phases[index]; if (!phase || !stage) return;
    cards.forEach((card, i) => card.classList.toggle('is-current', i === Math.min(index, cards.length - 1)));
    railSteps.forEach((step, i) => { const current = i === index; step.classList.toggle('is-active', current); if (current) step.setAttribute('aria-current','step'); else step.removeAttribute('aria-current'); });
    phaseNumber.textContent = `0${index + 1} / 05`;
    phaseTitle.textContent = phase.title;
    phaseDescription.textContent = phase.description;
    stageLabel.textContent = phase.label;
    stageCounter.textContent = `0${index + 1}`;
    journeyStatus.textContent = phase.status;
    stageProgress.style.width = `${(index + 1) * 20}%`;
    if (traveler) { traveler.setAttribute('cx', phase.point[0]); traveler.setAttribute('cy', phase.point[1]); }
    if (activePath) activePath.style.strokeDashoffset = String(Math.max(0, .8 - index * .2));
    tags.forEach((tag, i) => tag.classList.toggle('is-visible', i === phase.tag));
    if (scrollIntoView) stage.scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth', block:'center'});
  }

  railSteps.forEach((step) => step.addEventListener('click', () => setPhase(Number(step.dataset.scene), true)));
  if (window.IntersectionObserver && scenes.length) {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting && entry.intersectionRatio > .35) setPhase(Number(entry.target.dataset.storyBeat)); }), {threshold:[.35,.7], rootMargin:'-20% 0px -35%'});
    scenes.forEach((scene) => observer.observe(scene));
  }
  window.addEventListener('scroll', () => header?.classList.toggle('is-scrolled', window.scrollY > 18), {passive:true});
  menuToggle?.addEventListener('click', () => { const open = header.classList.toggle('menu-open'); menuToggle.setAttribute('aria-expanded', String(open)); });
  document.querySelectorAll('.site-header a').forEach((link) => link.addEventListener('click', () => { header.classList.remove('menu-open'); menuToggle?.setAttribute('aria-expanded','false'); }));
  setPhase(0);
})();

// Recomienda una versión sin navegar ni descargar automáticamente; las demás siguen visibles.
(() => {
  const grid = document.querySelector('[data-downloads]');
  const recommendation = document.querySelector('[data-device-recommendation]');
  const top = document.querySelector('[data-download-top]');
  if (!grid && !top && !recommendation) return;
  const ua = navigator.userAgent;
  // iPadOS puede anunciarse como Macintosh; iOS y Android se resuelven antes del escritorio.
  const os = /iPhone|iPod/i.test(ua) ? 'iphone'
    : /iPad/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) >= 2) ? 'ipad'
    : /Android/i.test(ua) ? 'android'
    : /Windows/i.test(ua) ? 'windows'
    : /Macintosh|Mac OS X/i.test(ua) ? 'mac'
    : /Linux/i.test(ua) ? 'linux' : 'web';
  const es = document.documentElement.lang === 'es';
  const isIOS = os === 'iphone' || os === 'ipad';
  const mine = grid?.querySelector(`[data-os="${isIOS ? 'ios' : os === 'linux' ? 'web' : os}"]`);
  if (mine && grid) { mine.classList.add('is-mine'); grid.prepend(mine); }
  const iosBadge = grid?.querySelector('[data-ios-mine]');
  if (isIOS && iosBadge) iosBadge.textContent = `${es ? 'Tu' : 'Your'} ${os === 'ipad' ? 'iPad' : 'iPhone'}`;
  const webHref = 'https://app.chaggu.com/';
  const downloadHref = { android: 'https://play.google.com/store/apps/details?id=com.chaggu.app', mac: '/descargas/chaggu-mac.dmg', windows: '/descargas/chaggu-windows.exe' };
  const copy = es ? {
    android: ['Para tu Android', 'chaggu en tu Android.', 'Descarga la app oficial desde Google Play.', 'Descargar para Android'],
    mac: ['Para tu Mac', 'chaggu en tu Mac.', 'App de escritorio para Apple Silicon e Intel.', 'Descargar para Mac'],
    windows: ['Para tu PC', 'chaggu en tu Windows.', 'App de escritorio para Windows 10 y 11.', 'Descargar para Windows'],
    iphone: ['Para tu iPhone', 'chaggu para iPhone, muy pronto.', 'Mientras tanto, tus conversaciones y tareas siguen en la web.', 'Usar versión web'],
    ipad: ['Para tu iPad', 'chaggu para iPad, muy pronto.', 'Mientras tanto, tus conversaciones y tareas siguen en la web.', 'Usar versión web'],
    linux: ['Para tu equipo Linux', 'chaggu, también en tu navegador.', 'Abre tus conversaciones y tareas sin instalar nada.', 'Usar versión web'],
    web: ['Para tu navegador', 'chaggu, sin instalar nada.', 'Tus conversaciones y tareas, también en la web.', 'Usar versión web'],
  } : {
    android: ['For your Android', 'chaggu on your Android.', 'Get the official app from Google Play.', 'Download for Android'],
    mac: ['For your Mac', 'chaggu on your Mac.', 'Desktop app for Apple Silicon and Intel.', 'Download for Mac'],
    windows: ['For your PC', 'chaggu on your Windows PC.', 'Desktop app for Windows 10 and 11.', 'Download for Windows'],
    iphone: ['For your iPhone', 'chaggu for iPhone, coming soon.', 'Until then, your conversations and tasks are on the web.', 'Use the web app'],
    ipad: ['For your iPad', 'chaggu for iPad, coming soon.', 'Until then, your conversations and tasks are on the web.', 'Use the web app'],
    linux: ['For your Linux computer', 'chaggu, in your browser too.', 'Open your conversations and tasks with nothing to install.', 'Use the web app'],
    web: ['For your browser', 'chaggu, with nothing to install.', 'Your conversations and tasks are on the web too.', 'Use the web app'],
  };
  const [label, title, description, actionLabel] = copy[os];
  const recommendationAction = recommendation?.querySelector('[data-recommendation-action]');
  const recommendationDescription = recommendation?.querySelector('[data-recommendation-description]');
  if (recommendation) {
    recommendation.setAttribute('data-device', os);
    for (const [selector, value] of [
      ['[data-recommendation-label]', label], ['[data-recommendation-title]', title],
      ['[data-recommendation-description]', description], ['[data-recommendation-action-label]', actionLabel],
    ]) {
      const element = recommendation.querySelector(selector);
      if (element) element.textContent = value;
    }
    recommendationAction?.setAttribute('href', downloadHref[os] || webHref);
    const iconPath = isIOS ? 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM10 5h4M11 19h2'
      : os === 'android' ? 'm7 5-2-3m12 3 2-3M4 13a8 8 0 0 1 16 0v5H4ZM8 10h.01M16 10h.01'
      : os === 'mac' || os === 'windows' ? 'M3 4h18v13H3ZM12 17v4M8 21h8'
      : 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z';
    recommendation.querySelector('[data-recommendation-icon]')?.setAttribute('d', iconPath);
  }

  // iOS anuncia disponibilidad futura y dirige a las opciones; nunca ofrece una descarga de Mac.
  const topLabel = top?.querySelector('[data-download-label]');
  top?.setAttribute('href', downloadHref[os] || '#descargar');
  if (topLabel && isIOS) topLabel.textContent = `${os === 'ipad' ? 'iPad' : 'iPhone'} · ${es ? 'Próximamente' : 'Coming soon'}`;
  else if (topLabel && downloadHref[os]) topLabel.textContent = actionLabel;
  const topIcon = top?.querySelector('[data-download-icon]');
  if (topIcon && isIOS) topIcon.textContent = '◷';
  const mb = (n) => `${(n / 1048576).toFixed(1).replace('.', es ? ',' : '.')} MB`;
  fetch('/descargas/latest.json?schema=2', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((v) => {
    if (!v) return;
    let matchedDesktop = false;
    // Usa el nombre versionado del manifiesto para evitar descargas anteriores en caché.
    for (const platform of ['mac', 'windows']) {
      const file = v[platform]?.file;
      if (typeof file !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(file)) continue;
      const href = `/descargas/${file}`;
      grid?.querySelector(`[data-os="${platform}"] a.button`)?.setAttribute('href', href);
      if (os === platform) {
        matchedDesktop = true;
        top?.setAttribute('href', href);
        recommendationAction?.setAttribute('href', href);
        if (recommendationDescription && v.version) recommendationDescription.textContent = `${description} ${es ? 'Versión' : 'Version'} ${v.version}.`;
      }
    }
    if (topLabel && matchedDesktop && v.version) { const sm = document.createElement('small'); sm.textContent = ` v${v.version}`; topLabel.after(sm); }
    const mac = grid?.querySelector('[data-meta="mac"]');
    if (mac && v.mac) mac.textContent = `${es ? 'Versión' : 'Version'} ${v.version} · .dmg · ${mb(v.mac.size)}`;
    const win = grid?.querySelector('[data-meta="windows"]');
    if (win && v.windows) win.firstChild.textContent = `${es ? 'Versión' : 'Version'} ${v.version} · .exe · ${mb(v.windows.size)} · `;
  }).catch(() => {});
})();
