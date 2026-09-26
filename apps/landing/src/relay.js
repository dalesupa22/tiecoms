/*
 * «Un hilo, muchas manos»: recorrido de una conversación que pasa entre personas,
 * empresas o sedes, y bots. La sección se fija en pantalla y el scroll la narra:
 * cada tramo de desplazamiento es un paso y la cuerda se dibuja al ritmo del scroll.
 * El tablero señala el cuello de botella del recorrido y cuándo se resuelve.
 * Sin dependencias; los textos salen del idioma de la página (<html lang>).
 */
(() => {
  const section = document.querySelector('[data-relay-section]');
  if (!section) return;
  const L = document.documentElement.lang === 'en' ? 'en' : 'es';
  const tr = (v) => (v && typeof v === 'object' && 'es' in v ? v[L] : v);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const STATUS = {
    waiting: { es: 'En espera', en: 'Waiting', tone: 'idle' },
    unassigned: { es: 'Sin asignar', en: 'Unassigned', tone: 'idle' },
    running: { es: 'En revisión', en: 'Running checks', tone: 'run' },
    signed: { es: 'Firmado', en: 'Signed', tone: 'ok' },
    draft: { es: 'Borrador recibido', en: 'Draft received', tone: 'draft' },
    blocked: { es: 'Detenido', en: 'Blocked', tone: 'jam' },
    approvedBoth: { es: 'Aprobado por ambos', en: 'Approved by both', tone: 'ok' },
    approved: { es: 'Aprobado', en: 'Approved', tone: 'ok' },
    passed: { es: 'Validado', en: 'Passed', tone: 'ok' },
    progress: { es: 'En curso', en: 'In progress', tone: 'prog' },
    done: { es: 'Listo', en: 'Done', tone: 'ok' },
  };
  const OK = new Set(['signed', 'approvedBoth', 'approved', 'passed', 'done']);
  const T = {
    done: { es: 'listas', en: 'done' }, noOwner: { es: 'Sin responsable', en: 'No owner yet' }, goto: { es: 'Ir al paso', en: 'Go to step' },
    jam: { es: 'Cuello de botella detectado', en: 'Bottleneck detected' }, unjam: { es: 'Cuello de botella resuelto', en: 'Bottleneck cleared' },
  };

  // ---------- Escenarios (escenario de 1000 × 450) ----------
  const scenarios = {
    companies: {
      board: { es: 'Incorporación de proveedor', en: 'Vendor onboarding' },
      meta: { es: '3 empresas · 7 personas · 1 agente IA', en: '3 companies · 7 people · 1 AI agent' },
      groups: [
        { id: 'acme', x: 20, y: 20, w: 300, h: 410, tone: 'blue', mark: 'A', name: 'Acme', sub: { es: 'Retail · 2.400 empleados', en: 'Retail · 2,400 employees' }, tag: { es: 'Cliente', en: 'Client' } },
        { id: 'nova', x: 680, y: 20, w: 300, h: 410, tone: 'green', mark: 'N', name: 'Nova Logistics', sub: { es: 'Carga y fulfillment', en: 'Freight & fulfillment' }, tag: { es: 'Proveedor', en: 'Vendor' } },
        { id: 'lexa', x: 372, y: 238, w: 256, h: 192, tone: 'lilac', mark: 'L', name: 'Lexa Legal', sub: { es: 'Asesoría comercial', en: 'Commercial counsel' }, tag: { es: 'Firma legal', en: 'Law firm' } },
      ],
      nodes: {
        sara: { x: 122, y: 140, ini: 'SR', name: 'Sara', role: { es: 'Compras', en: 'Procurement' }, tone: 'blue' },
        tom: { x: 112, y: 330, ini: 'TB', name: 'Tom', role: { es: 'Operaciones', en: 'Operations' }, tone: 'blue' },
        nico: { x: 246, y: 330, ini: 'NC', name: 'Nico', role: { es: 'TI', en: 'IT' }, tone: 'navy', late: true },
        ai: { x: 500, y: 118, ini: '✦', name: 'Chaggu AI', role: { es: 'Agente', en: 'Agent' }, tone: 'bot' },
        leo: { x: 830, y: 140, ini: 'LP', name: 'Leo', role: { es: 'Cuenta', en: 'Account lead' }, tone: 'green' },
        kai: { x: 830, y: 330, ini: 'KA', name: 'Kai', role: { es: 'Implementación', en: 'Implementation' }, tone: 'green' },
        maria: { x: 500, y: 340, ini: 'MG', name: 'María', role: { es: 'Abogada', en: 'Lawyer' }, tone: 'lilac' },
      },
      tasks: [
        { id: 'nda', name: 'NDA' },
        { id: 'contract', name: { es: 'Contrato', en: 'Contract' } },
        { id: 'security', name: { es: 'Seguridad', en: 'Security' } },
        { id: 'access', name: { es: 'Accesos', en: 'Access' } },
      ],
      steps: [
        { to: ['sara', 'tom'], short: { es: 'Arranca', en: 'Kick-off' }, title: { es: 'Acme incorpora a un <em>nuevo proveedor</em>.', en: 'Acme is onboarding a <em>new vendor</em>.' },
          say: { who: 'tom', org: 'Acme', text: { es: 'Sara, arranco hoy la incorporación de Nova.', en: 'Sara, I’m starting Nova’s onboarding today.' } },
          tasks: { nda: ['waiting'], contract: ['waiting'], security: ['unassigned'], access: ['unassigned'] } },
        { to: ['ai'], short: { es: 'Planea', en: 'Plan' }, title: { es: 'La <em>IA</em> arma el plan.', en: '<em>AI</em> builds the plan.' },
          say: { who: 'ai', org: 'Chaggu', text: { es: 'Plan listo: NDA, contrato, seguridad y accesos. Reviso seguridad mientras tanto.', en: 'Plan ready: NDA, contract, security, access. I’ll run the security checks meanwhile.' } },
          tasks: { security: ['running', 'ai'] } },
        { to: ['leo'], short: { es: 'Conecta', en: 'Connect' }, title: { es: 'El proveedor <em>entra al hilo</em>.', en: 'The vendor <em>joins the thread</em>.' },
          say: { who: 'leo', org: 'Nova Logistics', text: { es: 'Hola, Acme. Firmamos el NDA hoy mismo.', en: 'Hi Acme. We’ll sign the NDA today.' } },
          tasks: { nda: ['signed', 'leo'] } },
        { to: ['maria'], short: { es: 'Revisa', en: 'Review' }, title: { es: 'Una <em>tercera empresa</em> se suma.', en: 'A <em>third company</em> steps in.' },
          say: { who: 'maria', org: 'Lexa Legal', text: { es: 'La cláusula 7 necesita un ajuste. Envío la redacción.', en: 'Clause 7 needs a change. Sending the redline.' } },
          tasks: { contract: ['blocked', 'maria'] },
          jam: { task: 'contract', text: { es: 'El contrato lleva 2 días esperando la cláusula 7 y frena todo lo demás.', en: 'The contract has waited 2 days on clause 7, holding up everything else.' } } },
        { to: ['leo'], short: { es: 'Responde', en: 'Answer' }, title: { es: 'El proveedor <em>responde</em>.', en: 'The vendor <em>answers</em>.' },
          say: { who: 'leo', org: 'Nova Logistics', text: { es: 'Aceptamos el ajuste de la cláusula 7.', en: 'We accept the clause 7 change.' } },
          tasks: { contract: ['approvedBoth', 'maria'], security: ['passed', 'ai'] },
          unjam: { es: 'Resuelto en el mismo hilo, sin reuniones ni cadenas de correo.', en: 'Solved in the same thread, no meetings or email chains.' } },
        { to: ['tom'], short: { es: 'Firma', en: 'Sign' }, title: { es: 'De vuelta a Acme para <em>firmar</em>.', en: 'Back to Acme to <em>sign</em>.' },
          say: { who: 'tom', org: 'Acme', text: { es: 'Firmado. Seguimos con los accesos.', en: 'Signed. Moving on to access.' } },
          tasks: { contract: ['signed', 'tom'] } },
        { to: ['nico'], short: { es: 'Continúa', en: 'Continue' }, title: { es: 'Y el hilo sigue con el <em>siguiente compañero</em>.', en: 'And the thread moves to the <em>next teammate</em>.' },
          say: { who: 'nico', org: 'Acme', text: { es: 'Accesos listos. Kickoff el lunes a las 9:00.', en: 'Access ready. Kickoff Monday at 9:00.' } },
          tasks: { access: ['progress', 'nico'] } },
      ],
    },
    branches: {
      frame: { es: 'Grupo Andino · una sola empresa', en: 'Grupo Andino · one company' },
      board: { es: 'Campaña regional Q4', en: 'Regional Q4 campaign' },
      meta: { es: '1 empresa · 3 sedes · 5 personas · 2 bots', en: '1 company · 3 branches · 5 people · 2 bots' },
      groups: [
        { id: 'bog', x: 20, y: 30, w: 300, h: 400, tone: 'blue', mark: 'BO', name: 'Bogotá', sub: { es: 'Marketing · Legal corporativo', en: 'Marketing · Corporate legal' }, tag: { es: 'Casa matriz', en: 'Headquarters' } },
        { id: 'mex', x: 680, y: 30, w: 300, h: 400, tone: 'green', mark: 'MX', name: { es: 'Ciudad de México', en: 'Mexico City' }, sub: { es: 'Comercial · Operaciones', en: 'Sales · Operations' }, tag: { es: 'Sucursal', en: 'Branch' } },
        { id: 'scl', x: 372, y: 238, w: 256, h: 192, tone: 'lilac', mark: 'CL', name: 'Santiago', sub: { es: 'Legal · Retail', en: 'Legal · Retail' }, tag: { es: 'Sucursal', en: 'Branch' } },
      ],
      nodes: {
        valentina: { x: 122, y: 146, ini: 'VR', name: 'Valentina', role: { es: 'Marketing regional', en: 'Regional marketing' }, tone: 'blue' },
        erp: { x: 250, y: 250, ini: '◇', name: 'ERP', role: { es: 'Bot de stock', en: 'Stock bot' }, tone: 'bot', square: true },
        andres: { x: 112, y: 340, ini: 'AM', name: 'Andrés', role: { es: 'Legal corporativo', en: 'Corporate legal' }, tone: 'blue' },
        ai: { x: 500, y: 118, ini: '✦', name: 'Chaggu AI', role: { es: 'Agente', en: 'Agent' }, tone: 'bot' },
        diego: { x: 830, y: 146, ini: 'DL', name: 'Diego', role: { es: 'Comercial', en: 'Sales' }, tone: 'green' },
        sofia: { x: 830, y: 340, ini: 'SP', name: 'Sofía', role: { es: 'Operaciones', en: 'Operations' }, tone: 'green' },
        francisca: { x: 500, y: 340, ini: 'FV', name: 'Francisca', role: { es: 'Legal', en: 'Legal' }, tone: 'lilac' },
      },
      tasks: [
        { id: 'plan', name: { es: 'Plan por país', en: 'Country plan' } },
        { id: 'prices', name: { es: 'Precios locales', en: 'Local pricing' } },
        { id: 'stock', name: { es: 'Stock', en: 'Stock' } },
        { id: 'legal', name: { es: 'Bases legales', en: 'Legal terms' } },
      ],
      steps: [
        { to: ['valentina'], short: { es: 'Lanza', en: 'Launch' }, title: { es: 'La casa matriz lanza una <em>campaña regional</em>.', en: 'Headquarters launches a <em>regional campaign</em>.' },
          say: { who: 'valentina', org: 'Bogotá', text: { es: 'Salimos con la campaña Q4 en Colombia, México y Chile el 1 de noviembre.', en: 'We launch the Q4 campaign in Colombia, Mexico and Chile on November 1.' } },
          tasks: { plan: ['waiting'], prices: ['unassigned'], stock: ['unassigned'], legal: ['unassigned'] } },
        { to: ['ai'], short: { es: 'Reparte', en: 'Split' }, title: { es: 'La <em>IA</em> reparte el trabajo por sede.', en: '<em>AI</em> splits the work by branch.' },
          say: { who: 'ai', org: 'Chaggu', text: { es: 'Plan por país listo: precios, stock y bases legales, con responsable en cada sede.', en: 'Country plan ready: pricing, stock and legal terms, with an owner in each branch.' } },
          tasks: { plan: ['done', 'ai'] } },
        { to: ['diego'], short: { es: 'Adapta', en: 'Adapt' }, title: { es: '<em>México</em> adapta los precios.', en: '<em>Mexico</em> adapts the pricing.' },
          say: { who: 'diego', org: 'Ciudad de México', text: { es: 'Precios en MXN listos, con impuestos locales incluidos.', en: 'MXN prices ready, local taxes included.' } },
          tasks: { prices: ['progress', 'diego'] } },
        { to: ['erp'], short: { es: 'Valida', en: 'Verify' }, title: { es: 'El <em>bot del ERP</em> valida el stock.', en: 'The <em>ERP bot</em> checks stock.' },
          say: { who: 'erp', org: 'Grupo Andino', text: { es: 'Stock suficiente en México y Chile. Bogotá necesita 2.000 unidades más.', en: 'Enough stock in Mexico and Chile. Bogotá needs 2,000 more units.' } },
          tasks: { stock: ['passed', 'erp'], prices: ['done', 'diego'] } },
        { to: ['francisca'], short: { es: 'Ajusta', en: 'Adjust' }, title: { es: '<em>Chile</em> pide un ajuste legal.', en: '<em>Chile</em> asks for a legal change.' },
          say: { who: 'francisca', org: 'Santiago', text: { es: 'En Chile la promoción necesita bases protocolizadas ante notario.', en: 'In Chile the promotion needs notarized terms.' } },
          tasks: { legal: ['blocked', 'francisca'] },
          jam: { task: 'legal', text: { es: 'Las bases de Chile detienen el lanzamiento en los tres países.', en: 'Chile’s legal terms are holding the launch in all three countries.' } } },
        { to: ['andres'], short: { es: 'Aprueba', en: 'Approve' }, title: { es: 'Legal corporativo <em>aprueba</em>.', en: 'Corporate legal <em>approves</em>.' },
          say: { who: 'andres', org: 'Bogotá', text: { es: 'Aprobado, con las bases de Chile. Queda en el registro de la campaña.', en: 'Approved, with the Chile terms. Logged in the campaign record.' } },
          tasks: { legal: ['approved', 'andres'] },
          unjam: { es: 'La casa matriz lo vio a tiempo y la fecha de salida se mantiene.', en: 'Headquarters caught it in time and the launch date holds.' } },
        { to: ['valentina'], short: { es: 'Sale', en: 'Go live' }, title: { es: 'Y las tres sedes salen <em>el mismo día</em>.', en: 'And all three branches go live <em>the same day</em>.' },
          say: { who: 'valentina', org: 'Bogotá', text: { es: 'Campaña activa en los tres países. Gracias, equipo.', en: 'Campaign live in all three countries. Thanks, team.' } },
          tasks: {} },
      ],
    },
  };

  // ---------- Referencias ----------
  const $ = (s) => section.querySelector(s);
  const wrap = $('[data-relay-wrap]');
  const stage = $('[data-relay-stage]');
  const stepEl = $('[data-relay-step]');
  const titleEl = $('[data-relay-title]');
  const msgEl = $('[data-relay-msg]');
  const railEl = $('[data-relay-rail]');
  const boardEl = $('[data-relay-board]');
  const tabs = [...section.querySelectorAll('[data-relay-tab]')];
  const svgNS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 450;

  let key = 'companies', sc, route = [], ends = [], lens = [], total = 0, ropes = [], knot = null, pathEl = null;
  let step = -1;

  function fit() {
    const s = Math.min(wrap.clientWidth / W, 1.15);
    stage.style.transform = `scale(${s})`;
    wrap.style.height = `${H * s}px`;
  }
  new ResizeObserver(fit).observe(wrap);

  function segs(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2, k = 0.2;
      const c1 = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
      const c2 = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
      out.push(`C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1]}`);
    }
    return out;
  }
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  function build() {
    sc = scenarios[key];
    stage.textContent = '';
    section.dataset.scenario = key;
    if (sc.frame) stage.appendChild(el('div', 'relay-frame', `<span>${tr(sc.frame)}</span>`));
    for (const g of sc.groups) {
      const card = el('div', `relay-group tone-${g.tone}`);
      Object.assign(card.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
      card.dataset.group = g.id;
      card.innerHTML = `<header><span class="relay-mark">${g.mark}</span><span class="relay-gname"><b>${tr(g.name)}</b><small>${tr(g.sub)}</small></span><span class="relay-tag">${tr(g.tag)}</span></header>`;
      stage.appendChild(card);
    }
    route = []; ends = [];
    for (const s of sc.steps) { route.push(...s.to); ends.push(route.length - 1); }
    const pts = route.map((id) => [sc.nodes[id].x, sc.nodes[id].y]);
    const sg = segs(pts);
    const d = `M${pts[0][0]} ${pts[0][1]} ${sg.join(' ')}`;
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'relay-rope');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<defs><linearGradient id="relayCore" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1000" y2="450"><stop offset="0" stop-color="#ff9d45"/><stop offset="1" stop-color="#f06200"/></linearGradient></defs>
      <path class="relay-rope-shadow" d="${d}"/><path class="relay-rope-outline" d="${d}"/><path class="relay-rope-core" d="${d}"/>
      <circle class="relay-knot" r="6.5"/>`;
    stage.appendChild(svg);
    ropes = [...svg.querySelectorAll('path')];
    knot = svg.querySelector('.relay-knot');
    pathEl = ropes[2];
    const probe = document.createElementNS(svgNS, 'path');
    svg.appendChild(probe);
    lens = pts.map((_, i) => { if (!i) return 0; probe.setAttribute('d', `M${pts[0][0]} ${pts[0][1]} ${sg.slice(0, i).join(' ')}`); return probe.getTotalLength(); });
    probe.remove();
    total = lens[lens.length - 1] + 1;
    ropes.forEach((p) => { p.style.strokeDasharray = `${total} ${total}`; p.style.strokeDashoffset = `${total}`; });

    for (const [id, n] of Object.entries(sc.nodes)) {
      const node = el('div', `relay-node tone-${n.tone}${n.square ? ' is-square' : ''}${n.late ? ' is-late' : ''}`);
      node.style.left = `${n.x}px`; node.style.top = `${n.y}px`;
      node.dataset.node = id;
      node.innerHTML = `<span class="relay-avatar">${n.ini}<i class="relay-typing" aria-hidden="true"><b></b><b></b><b></b></i></span><span class="relay-label"><b>${tr(n.name)}</b> · ${tr(n.role)}</span>`;
      stage.appendChild(node);
    }

    railEl.textContent = '';
    sc.steps.forEach((s, i) => {
      const b = el('button', 'relay-rail-item', `<span>${String(i + 1).padStart(2, '0')}</span>${tr(s.short)}`);
      b.type = 'button';
      b.setAttribute('aria-label', `${tr(T.goto)} ${i + 1}`);
      b.addEventListener('click', () => scrollToStep(i));
      railEl.appendChild(b);
    });
    step = -1;
    fit();
  }

  const groupOf = (id) => {
    const n = sc.nodes[id];
    return sc.groups.find((g) => n.x >= g.x && n.x <= g.x + g.w && n.y >= g.y && n.y <= g.y + g.h)?.id ?? 'bot';
  };
  function taskState(i) {
    const st = {};
    for (const t of sc.tasks) st[t.id] = ['unassigned'];
    for (let s = 0; s <= i; s++) Object.assign(st, sc.steps[s].tasks);
    // Al final de «Entre sedes» todo queda listo: la campaña sale completa.
    if (i === sc.steps.length - 1 && key === 'branches') for (const t of sc.tasks) if (!OK.has(st[t.id][0])) st[t.id] = ['done', st[t.id][1]];
    return st;
  }

  // Cambios discretos del paso: textos, nodos, tablero y cuello de botella.
  function setStep(i) {
    if (i === step) return;
    step = i;
    const s = sc.steps[i];
    const who = sc.nodes[s.say.who];
    stepEl.innerHTML = `<b>${String(i + 1).padStart(2, '0')}</b> / ${String(sc.steps.length).padStart(2, '0')}`;
    titleEl.innerHTML = tr(s.title);
    msgEl.className = `relay-msg${who.tone === 'bot' ? ' is-bot' : ''}`;
    msgEl.innerHTML = `<span class="relay-msg-avatar tone-${who.tone}${who.square ? ' is-square' : ''}">${who.ini}</span><span class="relay-msg-body"><small>${tr(who.name)} · ${s.say.org}</small>${tr(s.say.text)}</span>`;
    for (const x of [titleEl, msgEl]) { x.classList.remove('is-in'); void x.offsetWidth; x.classList.add('is-in'); }

    const reached = new Set(route.slice(0, ends[i] + 1));
    const touched = new Set([...reached].map(groupOf));
    stage.querySelectorAll('[data-node]').forEach((e) => {
      const id = e.dataset.node;
      e.classList.toggle('is-reached', reached.has(id));
      e.classList.toggle('is-current', id === s.say.who);
      e.classList.toggle('is-idle', !reached.has(id) && !touched.has(groupOf(id)));
      e.classList.toggle('is-jam', !!s.jam && id === s.say.who);
    });
    stage.querySelectorAll('[data-group]').forEach((g) => g.classList.toggle('is-idle', !touched.has(g.dataset.group)));
    railEl.querySelectorAll('.relay-rail-item').forEach((b, k) => { b.classList.toggle('is-active', k === i); b.classList.toggle('is-past', k < i); });

    const st = taskState(i);
    const done = sc.tasks.filter((t) => OK.has(st[t.id][0])).length;
    const alert = s.jam
      ? `<div class="relay-alert is-jam"><b>⏱ ${tr(T.jam)}</b>${tr(s.jam.text)}</div>`
      : s.unjam ? `<div class="relay-alert is-clear"><b>✓ ${tr(T.unjam)}</b>${tr(s.unjam)}</div>` : '';
    boardEl.innerHTML = `<div class="relay-board-head"><b>${tr(sc.board)}</b><span>${tr(sc.meta)}</span><span class="relay-progress"><i style="width:${(done / sc.tasks.length) * 100}%"></i></span><span class="relay-count">${done}/${sc.tasks.length} ${tr(T.done)}</span></div>
      ${alert}
      <div class="relay-tasks">${sc.tasks.map((t) => {
        const [code, owner] = st[t.id];
        const o = owner && sc.nodes[owner];
        const m = STATUS[code];
        const cls = s.jam?.task === t.id ? ' is-jam' : s.tasks[t.id] ? ' is-changed' : '';
        return `<div class="relay-task${cls}"><b>${tr(t.name)}</b><span class="relay-owner">${o ? `<i class="tone-${o.tone}${o.square ? ' is-square' : ''}">${o.ini}</i>${tr(o.name)}` : `<i class="is-empty"></i>${tr(T.noOwner)}`}</span><span class="relay-status tone-${m.tone}">${m[L]}</span></div>`;
      }).join('')}</div>`;
  }

  // Cambio continuo: la cuerda avanza con el scroll dentro de cada paso.
  function setProgress(p) {
    const n = sc.steps.length;
    const f = Math.min(n - 1e-6, Math.max(0, p * n));
    const i = Math.floor(f);
    const within = reduceMotion ? 1 : Math.min(1, (f - i) / 0.55); // dibuja en el primer 55 % del paso y luego espera
    const eased = 1 - Math.pow(1 - within, 3);
    const from = i === 0 ? 0 : lens[ends[i - 1]];
    const len = from + (lens[ends[i]] - from) * eased;
    ropes.forEach((r) => { r.style.strokeDashoffset = `${total - len}`; });
    const pt = pathEl.getPointAtLength(Math.max(0.01, len));
    knot.setAttribute('cx', pt.x); knot.setAttribute('cy', pt.y);
    knot.style.opacity = len > 1 && within < 1 ? '1' : '0';
    setStep(i);
  }

  function progressNow() {
    const r = section.getBoundingClientRect();
    const run = section.offsetHeight - window.innerHeight;
    return run > 0 ? Math.min(1, Math.max(0, -r.top / run)) : 0;
  }
  function scrollToStep(i) {
    const run = section.offsetHeight - window.innerHeight;
    const top = section.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + run * ((i + 0.7) / sc.steps.length), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  let ticking = false;
  const onScroll = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; setProgress(progressNow()); }); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  tabs.forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.relayTab === key) return;
    key = t.dataset.relayTab;
    tabs.forEach((x) => { const on = x === t; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); });
    build();
    setProgress(progressNow());
  }));

  build();
  setProgress(progressNow());
})();
