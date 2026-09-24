/**
 * Organizador de chats de WhatsApp: sugiere una categoría por nombre y tipo.
 * Es una sugerencia; lo que la persona elige a mano no se vuelve a tocar.
 */
export const WA_CATEGORIES = ['trabajo', 'clientes', 'familia', 'amigos', 'comunidad', 'otros'] as const;
export type WaCategory = (typeof WA_CATEGORIES)[number];

// Raíces que abren palabra («famil» → familia, familiares) y palabras completas («=ops»).
const RULES: [WaCategory, string[]][] = [
  ['familia', ['famil', '=mamá', '=mama', '=papá', '=papa', '=mami', '=papi', 'papás', 'mamás', 'herman', 'primo', 'prima', 'tía', 'tío', 'tias', 'tíos', 'abuel', 'sobrin', 'cuñad', 'suegr', 'hijos', 'hijas', '=casa', 'hogar', 'family', '=mom', '=dad', 'cousin']],
  ['clientes', ['client', 'soporte', 'support', 'ventas', 'sales', 'comercial', 'pedido', 'cotizaci', 'facturaci', 'cartera', 'cobranza', 'postventa', 'servicio al cliente', 'proveedor', 'convenio', 'licitaci']],
  ['trabajo', ['equipo', '=team', 'proyect', 'project', 'oficina', 'office', 'trabajo', '=work', 'staff', '=dev', 'devops', '=ops', '=tech', 'producto', 'product', 'marketing', '=rrhh', 'talento', 'nómina', 'nomina', 'gerencia', 'directiv', 'junta', 'comité', 'comite', 'reunión', 'reunion', 'sprint', 'daily', 'standup', '=sas', 's.a.s', 'ltda', '=inc', '=corp', 'xertify', 'tiecoms', 'empresa', 'interno', 'operaci', 'logística', 'logistica', 'finanzas', 'contab']],
  ['comunidad', ['comunidad', 'community', 'conjunto', 'edificio', '=torre', 'vecin', 'copropiedad', 'administración', 'padres', 'acudiente', '=curso', '=grado', 'colegio', 'universidad', '=clase', '=promo', 'egresad', 'iglesia', 'parroquia', '=club', '=liga', 'asociaci', 'fundaci', 'voluntari']],
  ['amigos', ['amig', 'parche', 'friends', '=bro', '=bros', '=panas', 'parcero', '=combo', 'fútbol', 'futbol', 'partido', 'asado', '=viaje', 'paseo', 'fiesta', 'cumple', 'birthday', 'squad', '=gang', '🍻', '⚽', '🎉']],
];

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MATCHERS: [WaCategory, RegExp][] = RULES.map(([cat, words]) => [cat, new RegExp(
  words.map((w) => w.startsWith('=') ? `(?<![\\p{L}\\p{N}])${esc(w.slice(1))}(?![\\p{L}\\p{N}])` : /^\p{L}/u.test(w) ? `(?<![\\p{L}\\p{N}])${esc(w)}` : esc(w)).join('|'),
  'iu',
)]);

export function suggestCategory(name: string | null | undefined, opts: { isGroup: boolean; accountKind: 'personal' | 'business' }): WaCategory {
  const n = (name ?? '').normalize('NFC');
  for (const [cat, re] of MATCHERS) if (re.test(n)) return cat;
  // En una cuenta Business los chats uno a uno suelen ser clientes; en la personal, no se adivina.
  if (opts.accountKind === 'business') return opts.isGroup ? 'trabajo' : 'clientes';
  return 'otros';
}
