(() => {
  const demo = document.querySelector('[data-hero-demo]');
  if (!demo) return;

  const steps = [...demo.querySelectorAll('[data-hero-step]')];
  const playButton = demo.querySelector('[data-hero-play]');
  const playLabel = playButton?.querySelector('[data-hero-play-label]');
  const status = demo.querySelector('[data-hero-status]');
  const progress = demo.querySelector('[data-hero-progress]');
  const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const es = document.documentElement.lang !== 'en';
  const captions = es ? [
    'Un mensaje de WhatsApp abre la conversación.',
    'El aporte de Teams conserva su origen.',
    'Lo compartido desde Slack suma contexto.',
    'Humanos y agentes de IA continúan en Chaggu.',
  ] : [
    'A WhatsApp message starts the conversation.',
    'The Teams contribution keeps its source.',
    'What you share from Slack adds context.',
    'People and AI agents continue in Chaggu.',
  ];
  const duration = 5200;
  let reducedMotion = motionPreference?.matches ?? false;
  let wantsPlayback = !reducedMotion;
  let step = reducedMotion ? captions.length - 1 : 0;
  let inViewport = false;
  let pageSuspended = false;
  let timer = null;
  let deadline = 0;
  let remaining = duration;

  function stopTimer() {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
    remaining = Math.max(0, deadline - performance.now());
  }

  function showStep(next, manual = false) {
    step = next;
    demo.dataset.step = String(step);
    for (const button of steps) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.heroStep) === step));
      // These are ordinary buttons: every channel remains in the normal tab order.
      button.tabIndex = 0;
    }
    if (status) {
      status.setAttribute('aria-live', manual ? 'polite' : 'off');
      status.textContent = captions[step];
    }
    remaining = duration;
    // Restart only the CSS progress indicator, without a layout read or a frame loop.
    for (const animation of progress?.getAnimations?.() || []) {
      animation.currentTime = 0;
    }
  }

  function syncPlayback() {
    const active = wantsPlayback && !reducedMotion && inViewport && !document.hidden && !pageSuspended;
    demo.dataset.playing = String(active);
    if (playButton) {
      const label = wantsPlayback && !reducedMotion
        ? (es ? 'Pausar demo' : 'Pause demo')
        : (es ? 'Reproducir demo' : 'Play demo');
      playButton.hidden = reducedMotion;
      playButton.setAttribute('aria-label', label);
      if (playLabel) playLabel.textContent = label;
    }
    if (!active) {
      stopTimer();
    } else if (timer === null) {
      deadline = performance.now() + remaining;
      timer = window.setTimeout(() => {
        timer = null;
        if (!wantsPlayback || reducedMotion || !inViewport || document.hidden || pageSuspended) {
          remaining = Math.max(0, deadline - performance.now());
          syncPlayback();
          return;
        }
        showStep((step + 1) % captions.length);
        syncPlayback();
      }, remaining);
    }
  }

  for (const button of steps) {
    button.addEventListener('click', () => {
      const next = Number(button.dataset.heroStep);
      if (!Number.isInteger(next) || next < 0 || next >= captions.length) return;
      wantsPlayback = false;
      stopTimer();
      showStep(next, true);
      syncPlayback();
    });
  }
  playButton?.addEventListener('click', () => {
    if (reducedMotion) return;
    wantsPlayback = !wantsPlayback;
    if (status) status.setAttribute('aria-live', 'off');
    syncPlayback();
  });

  function updateMotionPreference() {
    reducedMotion = motionPreference.matches;
    if (reducedMotion) {
      wantsPlayback = false;
      stopTimer();
      showStep(captions.length - 1);
    }
    // When reduced motion is disabled, remain paused until the person presses Play.
    syncPlayback();
  }
  if (motionPreference?.addEventListener) motionPreference.addEventListener('change', updateMotionPreference);
  else motionPreference?.addListener?.(updateMotionPreference);

  function checkViewport() {
    const rect = demo.getBoundingClientRect();
    inViewport = rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth;
    syncPlayback();
  }
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      inViewport = entries[entries.length - 1]?.isIntersecting ?? false;
      syncPlayback();
    }, { threshold: 0 });
    observer.observe(demo);
  } else {
    window.addEventListener('scroll', checkViewport, { passive: true });
    window.addEventListener('resize', checkViewport, { passive: true });
    checkViewport();
  }
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('pagehide', () => { pageSuspended = true; syncPlayback(); });
  window.addEventListener('pageshow', () => { pageSuspended = false; checkViewport(); });

  showStep(step);
  syncPlayback();
})();
