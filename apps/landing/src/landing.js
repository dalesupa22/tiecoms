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
