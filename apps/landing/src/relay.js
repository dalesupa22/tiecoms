/*
 * «Un hilo, muchas manos»: recorrido animado de una conversación que pasa
 * entre personas, empresas o sedes, y bots. Dos escenarios con los mismos datos
 * de forma: entre empresas (proveedor + firma legal) y entre sedes de una empresa.
 * Sin dependencias; los textos salen del idioma de la página (<html lang>).
 */
(() => {
  const root = document.querySelector('[data-relay]');
  if (!root) return;
  const L = document.documentElement.lang === 'en' ? 'en' : 'es';
  const tr = (v) => (v && typeof v === 'object' && 'es' in v ? v[L] : v);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STEP_MS = 3600;

  const STATUS = {
    waiting: { es: 'EN ESPERA', en: 'WAITING', tone: 'idle' },
    unassigned: { es: 'SIN ASIGNAR', en: 'UNASSIGNED', tone: 'idle' },
    running: { es: 'EN REVISIÓN', en: 'RUNNING CHECKS', tone: 'run' },
    signed: { es: 'FIRMADO', en: 'SIGNED', tone: 'ok' },
    draft: { es: 'BORRADOR RECIBIDO', en: 'DRAFT RECEIVED', tone: 'draft' },
    approvedBoth: { es: 'APROBADO POR AMBOS', en: 'APPROVED BY BOTH', tone: 'ok' },
    approved: { es: 'APROBADO', en: 'APPROVED', tone: 'ok' },
    passed: { es: 'SUPERADO', en: 'PASSED', tone: 'ok' },
    progress: { es: 'EN CURSO', en: 'IN PROGRESS', tone: 'prog' },
    done: { es: 'LISTO', en: 'DONE', tone: 'ok' },
  };
  const OK = new Set(['signed', 'approvedBoth', 'approved', 'passed', 'done']);

  const T = {
    step: { es: 'PASO', en: 'STEP' }, done: { es: 'listas', en: 'done' }, noOwner: { es: 'Sin responsable', en: 'No owner yet' },
    play: { es: 'Reproducir', en: 'Play' }, pause: { es: 'Pausar', en: 'Pause' }, prev: { es: 'Paso anterior', en: 'Previous step' }, next: { es: 'Paso siguiente', en: 'Next step' },
    goto: { es: 'Ir al paso', en: 'Go to step' }, waitingYou: { es: 'Esperando…', en: 'Waiting for you…' },
  };

  // ---------- Escenarios (coordenadas en un escenario de 1000 × 540) ----------
  const scenarios = {
    companies: {
      board: { es: 'Incorporación de proveedor · Nova Logistics', en: 'Vendor onboarding · Nova Logistics' },
      meta: { es: '3 empresas · 7 personas · 1 agente IA', en: '3 companies · 7 people · 1 AI agent' },
      groups: [
        { id: 'acme', x: 24, y: 28, w: 300, h: 400, tone: 'blue', mark: 'A', name: 'Acme', sub: { es: 'Retail · 2.400 empleados', en: 'Retail · 2,400 employees' }, tag: { es: 'CLIENTE', en: 'CLIENT' } },
        { id: 'nova', x: 676, y: 28, w: 300, h: 400, tone: 'green', mark: 'N', name: 'Nova Logistics', sub: { es: 'Carga y fulfillment', en: 'Freight & fulfillment' }, tag: { es: 'PROVEEDOR', en: 'VENDOR' } },
        { id: 'lexa', x: 372, y: 250, w: 256, h: 200, tone: 'lilac', mark: 'L', name: 'Lexa Legal', sub: { es: 'Asesoría comercial', en: 'Commercial counsel' }, tag: { es: 'FIRMA LEGAL', en: 'LAW FIRM' } },
      ],
      nodes: {
        sara: { x: 118, y: 136, ini: 'SR', name: 'Sara', role: { es: 'Compras', en: 'Procurement' }, tone: 'blue' },
        tom: { x: 106, y: 336, ini: 'TB', name: 'Tom', role: { es: 'Operaciones', en: 'Operations' }, tone: 'blue' },
        nico: { x: 238, y: 350, ini: 'NC', name: 'Nico', role: { es: 'TI', en: 'IT' }, tone: 'navy', late: true },
        ai: { x: 500, y: 124, ini: '✦', name: 'TieComs AI', role: { es: 'Agente', en: 'Agent' }, tone: 'bot' },
        leo: { x: 830, y: 140, ini: 'LP', name: 'Leo', role: { es: 'Cuenta', en: 'Account lead' }, tone: 'green' },
        kai: { x: 830, y: 336, ini: 'KA', name: 'Kai', role: { es: 'Implementación', en: 'Implementation' }, tone: 'green' },
        maria: { x: 470, y: 368, ini: 'MG', name: 'María', role: { es: 'Abogada', en: 'Lawyer' }, tone: 'lilac' },
      },
      tasks: [
        { id: 'nda', name: 'NDA' },
        { id: 'contract', name: { es: 'Revisión de contrato', en: 'Contract review' } },
        { id: 'security', name: { es: 'Revisión de seguridad', en: 'Security review' } },
        { id: 'access', name: { es: 'Accesos y kickoff', en: 'Access & kickoff' } },
      ],
      steps: [
        { to: ['sara', 'tom'], title: { es: 'Acme incorpora a un <em>nuevo proveedor</em>.', en: 'Acme is onboarding a <em>new vendor</em>.' },
          say: { who: 'tom', org: 'Acme', text: { es: 'Sara, arranco el onboarding de Nova hoy.', en: 'Sara, I’m starting Nova’s onboarding today.' } },
          tasks: { nda: ['waiting'], contract: ['waiting'], security: ['unassigned'], access: ['unassigned'] } },
        { to: ['ai'], title: { es: 'La <em>IA</em> arma el plan de incorporación.', en: '<em>AI</em> builds the onboarding plan.' },
          say: { who: 'ai', org: 'TieComs', text: { es: 'Plan listo: NDA, contrato, seguridad y accesos.', en: 'Plan ready: NDA, contract, security, access.' } },
          tasks: { security: ['running', 'ai'] } },
        { to: ['leo'], title: { es: 'El proveedor <em>entra al hilo</em>.', en: 'The vendor <em>joins the thread</em>.' },
          say: { who: 'leo', org: 'Nova', text: { es: 'Hola Acme 👋 Firmamos el NDA hoy mismo.', en: 'Hi Acme 👋 We’ll sign the NDA today.' } },
          tasks: { nda: ['signed', 'leo'] } },
        { to: ['maria'], title: { es: 'Una abogada de una <em>tercera empresa</em> se suma.', en: 'A lawyer from a <em>third company</em> steps in.' },
          say: { who: 'maria', org: 'Lexa Legal', text: { es: 'La cláusula 7 necesita un ajuste. Envío redacción.', en: 'Clause 7 needs a tweak. Sending a redline.' } },
          tasks: { contract: ['draft', 'maria'] } },
        { to: ['leo'], title: { es: 'El proveedor <em>responde</em>.', en: 'The vendor <em>answers</em>.' },
          say: { who: 'leo', org: 'Nova', text: { es: 'Aceptamos el ajuste de la cláusula 7.', en: 'We accept the clause 7 change.' } },
          tasks: { contract: ['approvedBoth', 'maria'], security: ['passed', 'ai'] } },
        { to: ['tom'], title: { es: 'De vuelta a Acme para <em>firmar</em>.', en: 'Back to Acme to <em>sign</em>.' },
          say: { who: 'tom', org: 'Acme', text: { es: 'Firmado ✍️ Pasamos a accesos.', en: 'Signed ✍️ Moving on to access.' } },
          tasks: { contract: ['signed', 'tom'] } },
        { to: ['nico'], title: { es: '…y sigue con el <em>siguiente compañero</em>.', en: '…and on to the <em>next teammate</em>.' },
          say: { who: 'nico', org: 'Acme', text: { es: 'Accesos listos. Kickoff el lunes 9:00.', en: 'Access ready. Kickoff Mon 9:00.' } },
          tasks: { access: ['progress', 'nico'] } },
      ],
    },
    branches: {
      board: { es: 'Reposición para campaña · Sucursal Medellín', en: 'Campaign restock · Medellín branch' },
      meta: { es: '1 empresa · 3 sedes · 5 personas · 2 bots', en: '1 company · 3 branches · 5 people · 2 bots' },
      groups: [
        { id: 'hq', x: 24, y: 28, w: 300, h: 400, tone: 'blue', mark: 'AR', name: 'Bogotá', sub: { es: 'Andina Retail · Logística y finanzas', en: 'Andina Retail · Logistics & finance' }, tag: { es: 'SEDE PRINCIPAL', en: 'HQ' } },
        { id: 'med', x: 676, y: 28, w: 300, h: 400, tone: 'green', mark: 'MD', name: 'Medellín', sub: { es: 'Andina Retail · El Poblado', en: 'Andina Retail · El Poblado' }, tag: { es: 'SUCURSAL', en: 'BRANCH' } },
        { id: 'lima', x: 372, y: 250, w: 256, h: 200, tone: 'lilac', mark: 'LI', name: 'Lima', sub: 'Andina Retail · Miraflores', tag: { es: 'SUCURSAL', en: 'BRANCH' } },
      ],
      nodes: {
        juan: { x: 830, y: 336, ini: 'JP', name: 'Juan', role: { es: 'Visual merchandising', en: 'Visual merchandising' }, tone: 'green' },
        camila: { x: 830, y: 140, ini: 'CM', name: 'Camila', role: { es: 'Jefa de tienda', en: 'Store manager' }, tone: 'green' },
        inv: { x: 246, y: 150, ini: '◇', name: { es: 'Bot de inventario', en: 'Inventory bot' }, role: { es: 'Stock en vivo', en: 'Live stock' }, tone: 'bot', square: true },
        andres: { x: 106, y: 336, ini: 'AR', name: 'Andrés', role: { es: 'Logística', en: 'Logistics' }, tone: 'blue' },
        rosa: { x: 470, y: 368, ini: 'RQ', name: 'Rosa', role: { es: 'Jefa de tienda', en: 'Store manager' }, tone: 'lilac' },
        ai: { x: 500, y: 124, ini: '✦', name: 'TieComs AI', role: { es: 'Agente', en: 'Agent' }, tone: 'bot' },
        jorge: { x: 118, y: 136, ini: 'JL', name: 'Jorge', role: { es: 'Finanzas', en: 'Finance' }, tone: 'blue' },
      },
      tasks: [
        { id: 'stock', name: { es: 'Consulta de stock', en: 'Stock check' } },
        { id: 'transfer', name: { es: 'Traslado Bogotá → Medellín', en: 'Transfer Bogotá → Medellín' } },
        { id: 'lima', name: { es: 'Envío desde Lima', en: 'Shipment from Lima' } },
        { id: 'approval', name: { es: 'Aprobación de costo', en: 'Cost approval' } },
      ],
      steps: [
        { to: ['juan', 'camila'], title: { es: 'Una sucursal detecta un <em>faltante</em>.', en: 'A branch spots a <em>stock gap</em>.' },
          say: { who: 'camila', org: 'Medellín', text: { es: 'Quedan 12 chaquetas y la campaña empieza el sábado.', en: '12 jackets left and the campaign starts Saturday.' } },
          tasks: { stock: ['waiting'], transfer: ['unassigned'], lima: ['unassigned'], approval: ['unassigned'] } },
        { to: ['inv'], title: { es: 'El <em>bot de inventario</em> busca en todas las sedes.', en: 'The <em>inventory bot</em> checks every branch.' },
          say: { who: 'inv', org: 'Andina Retail', text: { es: 'CEDI Bogotá: 120 · Lima: 40 · Cali: 0.', en: 'Bogotá DC: 120 · Lima: 40 · Cali: 0.' } },
          tasks: { stock: ['done', 'inv'] } },
        { to: ['andres'], title: { es: 'La <em>sede principal</em> entra al hilo.', en: '<em>Headquarters</em> joins the thread.' },
          say: { who: 'andres', org: 'Bogotá', text: { es: 'Despacho 100 unidades mañana a las 6:00.', en: 'Shipping 100 units tomorrow at 6:00.' } },
          tasks: { transfer: ['progress', 'andres'] } },
        { to: ['rosa'], title: { es: '<em>Otra sucursal</em> ayuda.', en: '<em>Another branch</em> pitches in.' },
          say: { who: 'rosa', org: 'Lima', text: { es: 'Desde Lima enviamos 30 por traslado interno.', en: 'Lima sends 30 via internal transfer.' } },
          tasks: { lima: ['progress', 'rosa'] } },
        { to: ['ai'], title: { es: 'La <em>IA</em> consolida el plan y el costo.', en: '<em>AI</em> consolidates the plan and cost.' },
          say: { who: 'ai', org: 'TieComs', text: { es: '100 desde Bogotá + 30 desde Lima. Costo interno: USD 410.', en: '100 from Bogotá + 30 from Lima. Internal cost: USD 410.' } },
          tasks: { approval: ['running', 'ai'] } },
        { to: ['jorge'], title: { es: 'Finanzas <em>aprueba</em> en la sede principal.', en: 'Finance <em>approves</em> at headquarters.' },
          say: { who: 'jorge', org: 'Bogotá', text: { es: 'Aprobado. Cargo al centro de costo Medellín.', en: 'Approved. Charged to the Medellín cost center.' } },
          tasks: { approval: ['approved', 'jorge'], transfer: ['done', 'andres'], lima: ['done', 'rosa'] } },
        { to: ['camila'], title: { es: '…y la tienda abre con <em>stock completo</em>.', en: '…and the store opens <em>fully stocked</em>.' },
          say: { who: 'camila', org: 'Medellín', text: { es: '¡Recibido! La campaña arranca completa.', en: 'Received! The campaign starts fully stocked.' } },
          tasks: {} },
      ],
    },
  };

  // ---------- Montaje ----------
  const $ = (sel) => root.querySelector(sel);
  const wrap = $('[data-relay-wrap]');
  const stage = $('[data-relay-stage]');
  const stepEl = $('[data-relay-step]');
  const titleEl = $('[data-relay-title]');
  const quoteEl = $('[data-relay-quote]');
  const boardEl = $('[data-relay-board]');
  const dotsEl = $('[data-relay-dots]');
  const playBtn = $('[data-relay-play]');
  const tabs = [...root.closest('section').querySelectorAll('[data-relay-tab]')];
  const svgNS = 'http://www.w3.org/2000/svg';
  const uid = `relay${Math.random().toString(36).slice(2, 7)}`;

  let sc, key = 'companies', step = 0, timer = null, playing = !reduceMotion, visible = false;
  let route = [], stepEnds = [], lengths = [], total = 0, maskPath = null;

  function fit() {
    const s = wrap.clientWidth / 1000;
    stage.style.transform = `scale(${s})`;
    wrap.style.height = `${540 * s}px`;
  }
  new ResizeObserver(fit).observe(wrap);

  // Curva suave que pasa por todos los puntos (Catmull-Rom → Bézier), segmento a segmento.
  function segments(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
      const k = 0.22;
      const c1 = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
      const c2 = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
      out.push(`C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1]}`);
    }
    return out;
  }

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function build() {
    sc = scenarios[key];
    stage.textContent = '';
    for (const g of sc.groups) {
      const card = el('div', `relay-group tone-${g.tone}`);
      Object.assign(card.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
      card.innerHTML = `<header><span class="relay-mark">${g.mark}</span><span class="relay-gname"><b>${tr(g.name)}</b><small>${tr(g.sub)}</small></span><span class="relay-tag">${tr(g.tag)}</span></header>`;
      card.dataset.group = g.id;
      stage.appendChild(card);
    }
    // Recorrido completo del escenario: cada paso agrega uno o más puntos.
    route = []; stepEnds = [];
    for (const s of sc.steps) { route.push(...s.to); stepEnds.push(route.length); }
    const pts = route.map((id) => [sc.nodes[id].x, sc.nodes[id].y]);
    const segs = segments(pts);
    const d = `M${pts[0][0]} ${pts[0][1]} ${segs.join(' ')}`;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 540');
    svg.setAttribute('class', 'relay-rope');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<defs><mask id="${uid}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="540"><path d="${d}" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" data-mask/></mask></defs>
      <g mask="url(#${uid}-m)" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="${d}" stroke="#3b2414" stroke-width="9"/>
        <path d="${d}" stroke="#ff7919" stroke-width="6"/>
        <path d="${d}" stroke="#ffd2a8" stroke-width="1.6" stroke-dasharray="3 7"/>
      </g>`;
    stage.appendChild(svg);
    maskPath = svg.querySelector('[data-mask]');
    // Longitud acumulada en cada punto del recorrido (medida con la misma curva).
    const probe = document.createElementNS(svgNS, 'path');
    svg.appendChild(probe);
    lengths = pts.map((p, i) => { if (i === 0) return 0; probe.setAttribute('d', `M${pts[0][0]} ${pts[0][1]} ${segs.slice(0, i).join(' ')}`); return probe.getTotalLength(); });
    probe.remove();
    total = lengths[lengths.length - 1] + 2;
    maskPath.style.strokeDasharray = `${total} ${total}`;
    maskPath.style.strokeDashoffset = `${total}`;

    for (const [id, n] of Object.entries(sc.nodes)) {
      const node = el('div', `relay-node tone-${n.tone}${n.square ? ' is-square' : ''}${n.late ? ' is-late' : ''}`);
      node.style.left = `${n.x}px`; node.style.top = `${n.y}px`;
      node.dataset.node = id;
      node.innerHTML = `<span class="relay-avatar">${n.ini}</span><span class="relay-label"><b>${tr(n.name)}</b> · ${tr(n.role)}</span>`;
      stage.appendChild(node);
    }
    const bubble = el('div', 'relay-bubble'); bubble.dataset.bubble = '';
    stage.appendChild(bubble);

    dotsEl.textContent = '';
    sc.steps.forEach((_, i) => {
      const b = el('button', 'relay-dot'); b.type = 'button';
      b.setAttribute('aria-label', `${tr(T.goto)} ${i + 1}`);
      b.addEventListener('click', () => { go(i); restart(); });
      dotsEl.appendChild(b);
    });
    fit();
  }

  function taskState(i) {
    const state = {};
    for (const t of sc.tasks) state[t.id] = ['unassigned'];
    for (let s = 0; s <= i; s++) Object.assign(state, sc.steps[s].tasks);
    return state;
  }

  function render() {
    const s = sc.steps[step];
    const n = sc.steps.length;
    stepEl.textContent = `${tr(T.step)} ${step + 1} / ${n}`;
    titleEl.innerHTML = tr(s.title);
    const who = sc.nodes[s.say.who];
    quoteEl.innerHTML = `<b>${tr(who.name)} · ${s.say.org}</b> ${tr(s.say.text)}`;

    // Cuerda: se revela hasta el último punto de este paso.
    const upto = stepEnds[step] - 1;
    maskPath.style.strokeDashoffset = `${total - lengths[upto]}`;
    const reached = new Set(route.slice(0, upto + 1));
    const touched = new Set([...reached].map((id) => groupOf(id)));
    stage.querySelectorAll('[data-node]').forEach((e) => {
      const id = e.dataset.node;
      e.classList.toggle('is-reached', reached.has(id));
      e.classList.toggle('is-current', id === route[upto]);
      // Quien pertenece a una empresa o sede que aún no entra al hilo se ve apagado.
      e.classList.toggle('is-idle', !reached.has(id) && !touched.has(groupOf(id)));
    });
    stage.querySelectorAll('[data-group]').forEach((g) => g.classList.toggle('is-idle', !touched.has(g.dataset.group)));

    // Globo junto a quien habla, dentro del escenario.
    const b = stage.querySelector('[data-bubble]');
    b.className = `relay-bubble${who.tone === 'bot' ? ' is-bot' : ''}`;
    b.innerHTML = `<small>${tr(who.name)} · ${s.say.org}</small>${tr(s.say.text)}`;
    // Nodos centrales arriba (la IA): el globo va debajo para no tapar las tarjetas.
    const central = who.x > 360 && who.x < 640 && who.y < 200;
    const left = central ? who.x - 120 : who.x > 640 ? who.x - 250 : who.x + 40;
    const top = central ? who.y + 48 : who.y > 300 ? who.y - 108 : who.y - 86;
    Object.assign(b.style, { left: `${Math.max(8, Math.min(left, 752))}px`, top: `${Math.max(6, top)}px` });
    b.classList.remove('is-in'); void b.offsetWidth; b.classList.add('is-in');

    // Tablero de tareas.
    const st = taskState(step);
    const doneCount = sc.tasks.filter((t) => OK.has(st[t.id][0])).length;
    boardEl.innerHTML = `<div class="relay-board-head"><b>${tr(sc.board)}</b><span>${tr(sc.meta)}</span><span class="relay-progress"><i style="width:${(doneCount / sc.tasks.length) * 100}%"></i></span><span class="relay-count">${doneCount}/${sc.tasks.length} ${tr(T.done)}</span></div>
      <div class="relay-tasks">${sc.tasks.map((t) => {
        const [code, owner] = st[t.id];
        const o = owner && sc.nodes[owner];
        const meta = STATUS[code];
        const changed = sc.steps[step].tasks[t.id] ? ' is-changed' : '';
        return `<div class="relay-task${changed}"><b>${tr(t.name)}</b><span class="relay-owner">${o ? `<i class="tone-${o.tone}">${o.ini}</i>${tr(o.name)}` : `<i class="is-empty"></i>${tr(T.noOwner)}`}</span><span class="relay-status tone-${meta.tone}">${meta[L]}</span></div>`;
      }).join('')}</div>`;

    dotsEl.querySelectorAll('.relay-dot').forEach((d, i) => { d.classList.toggle('is-active', i === step); d.setAttribute('aria-current', i === step ? 'step' : 'false'); });
    playBtn.setAttribute('aria-label', tr(playing ? T.pause : T.play));
    playBtn.textContent = playing ? '❚❚' : '▶';
  }

  function groupOf(id) {
    const n = sc.nodes[id];
    const g = sc.groups.find((g) => n.x >= g.x && n.x <= g.x + g.w && n.y >= g.y && n.y <= g.y + g.h);
    return g?.id ?? 'bot';
  }

  function go(i) { step = (i + sc.steps.length) % sc.steps.length; render(); }

  function tick() {
    const last = step === sc.steps.length - 1;
    timer = setTimeout(() => { go(last ? 0 : step + 1); tick(); }, last ? STEP_MS + 2200 : STEP_MS);
  }
  function stop() { clearTimeout(timer); timer = null; }
  function restart() { stop(); if (playing && visible) tick(); }

  playBtn.addEventListener('click', () => { playing = !playing; render(); restart(); });
  $('[data-relay-prev]').addEventListener('click', () => { go(step - 1); restart(); });
  $('[data-relay-next]').addEventListener('click', () => { go(step + 1); restart(); });
  tabs.forEach((t) => t.addEventListener('click', () => {
    key = t.dataset.relayTab;
    tabs.forEach((x) => { const on = x === t; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); });
    build(); step = 0;
    requestAnimationFrame(() => { render(); restart(); });
  }));

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => es.forEach((e) => { visible = e.isIntersecting; restart(); }), { threshold: 0.25 }).observe(root);
  } else { visible = true; }

  build();
  // Sin animación: se muestra el recorrido completo desde el inicio.
  if (reduceMotion) { step = sc.steps.length - 1; }
  requestAnimationFrame(() => { render(); restart(); });
})();
