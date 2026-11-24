// Reine Logik (ohne Angular): Text <-> Baum, Terminplanung, kritischer Pfad, JSON.

export type Rel = 'EA' | 'AA' | 'EE' | 'AE';

export interface PlanNode {
  name: string;
  pkg: boolean;
  person?: string;
  dur?: number;
  min?: number; // "ab Tag 5" -> 4 (fester Start, 0-basiert)
  after: string[]; // "1.1" oder "1.1 EE"
  children: PlanNode[];
  parent: PlanNode | null;
  line: number; // Zeile im Eingabetext, für editLine()
  // von flatten()/schedule() gesetzt
  code?: string;
  depth?: number;
  sched?: { s: number; e: number } | null;
  base?: number; // Start laut Abhängigkeiten (ohne "ab Tag")
  early?: boolean; // per "ab Tag" vor einem Vorgänger gelegt
  drivers?: { p: PlanNode; rel: Rel }[];
  crit?: boolean;
}

const DUR = /^(\d+)\s*(d|t|tage?)?$/i; // "5d", "5 Tage", "5"
const AB = /^ab\s+(?:tag\s+)?(\d+)$/i; // "ab Tag 5", "ab 5"

// Text -> Baum. Tiefe = Anzahl Tabs (4 Leerzeichen zählen auch als 1 Tab).
export function parse(text: string): PlanNode[] {
  const root = { children: [] as PlanNode[] } as PlanNode;
  const stack: { node: PlanNode; depth: number }[] = [{ node: root, depth: -1 }];
  for (const [lineNo, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[\t ]*/)![0];
    const depth =
      (indent.match(/\t/g) || []).length + Math.floor(indent.replace(/\t/g, '').length / 4);
    let line = raw.trim();
    const pkg = line.startsWith('>');
    if (pkg) line = line.slice(1).trim();
    const [name, ...fields] = line.split('|').map((s) => s.trim());
    const node: PlanNode = { name, pkg, after: [], children: [], parent: null, line: lineNo };
    for (const f of fields) {
      let m;
      if ((m = f.match(DUR))) node.dur = +m[1];
      else if ((m = f.match(AB))) node.min = Math.max(0, +m[1] - 1);
      else if ((m = f.match(/^nach\s+(.+)$/i))) {
        // "nach 1.1, 1.2 EE" -> ["1.1", "1.2 EE"]
        node.after = [];
        for (const tok of m[1].split(/[,;\s]+/).filter(Boolean)) {
          if (/^(EA|AA|EE|AE)$/i.test(tok) && node.after.length)
            node.after[node.after.length - 1] += ' ' + tok.toUpperCase();
          else node.after.push(tok);
        }
      } else if (f) node.person = f;
    }
    while (stack.at(-1)!.depth >= depth) stack.pop();
    node.parent = stack.at(-1)!.depth < 0 ? null : stack.at(-1)!.node;
    stack.at(-1)!.node.children.push(node);
    stack.push({ node, depth });
  }
  return root.children;
}

export function flatten(
  nodes: PlanNode[],
  prefix = '',
  depth = 0,
  rows: PlanNode[] = [],
): PlanNode[] {
  nodes.forEach((n, i) => {
    n.code = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    n.depth = depth;
    rows.push(n);
    flatten(n.children, n.code, depth + 1, rows);
  });
  return rows;
}

// Start/Ende in Tagen ab Projektstart (Ende exklusiv). Oberpunkte umfassen ihre Kinder; "nach" eines Oberpunkts gilt
// für alle Kinder (EE/AE dann mit der Dauer des jeweiligen Kinds).
// Beziehung: 1. Buchstabe = Zeitpunkt des Vorgängers, 2. = des Nachfolgers (E = Ende, A = Anfang). Standard EA.
// Ein "Tag" ist eine Spalte der Zeitachse – ob Kalender- oder Werktag, entscheidet calendar().
export function schedule(rows: PlanNode[]): void {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const busy = new Set<PlanNode>();
  // alle Einschränkungen von n und seinen Oberpunkten, als frühester Start bei Dauer d
  const limits = (n: PlanNode, d: number): { v: number; p: PlanNode; rel: Rel }[] => {
    const own = n.after.flatMap((tok) => {
      const [c, rel = 'EA'] = tok.split(' ') as [string, Rel?];
      const p = byCode.get(c);
      if (!p) throw new Error(`${n.code} ${n.name}: Vorgänger ${c} gibt es nicht`);
      const ps = calc(p);
      if (!ps) return [];
      const at = rel[0] === 'E' ? ps.e : ps.s;
      return [{ v: rel[1] === 'E' ? at - d : at, p, rel }];
    });
    return n.parent ? [...limits(n.parent, d), ...own] : own;
  };
  const calc = (n: PlanNode): PlanNode['sched'] => {
    if (n.sched !== undefined) return n.sched;
    if (busy.has(n)) throw new Error(`Zirkuläre Abhängigkeit bei ${n.code} ${n.name}`);
    busy.add(n);
    let r: PlanNode['sched'] = null;
    if (n.children.length) {
      const cs = n.children.map(calc).filter((c) => !!c);
      if (cs.length) r = { s: Math.min(...cs.map((c) => c.s)), e: Math.max(...cs.map((c) => c.e)) };
    } else if (n.dur != null) {
      const ls = limits(n, n.dur);
      n.base = Math.max(0, ...ls.map((l) => l.v)); // Start laut Abhängigkeiten, nie vor Projektstart
      // "ab Tag" legt den Start fest, auch vor einem Vorgänger (fester Termin: dort endet der kritische Pfad)
      const s = n.min ?? n.base;
      n.early = s < n.base;
      n.drivers =
        n.min == null && s > 0 ? ls.filter((l) => l.v === s).map(({ p, rel }) => ({ p, rel })) : [];
      r = { s, e: s + n.dur };
    }
    busy.delete(n);
    return (n.sched = r);
  };
  rows.forEach(calc);
  markCritical(rows);
}

// Kritischer Pfad: vom Projektende rückwärts den Einschränkungen folgen, die den Start tatsächlich festlegen
// (ohne Fristen entspricht das Pufferzeit 0). Markiert werden nur Arbeitspakete/Meilensteine.
function markCritical(rows: PlanNode[]): void {
  const done = rows.filter((r) => r.sched);
  if (!done.length) return;
  const end = Math.max(...done.map((r) => r.sched!.e));
  const leaves = (n: PlanNode): PlanNode[] =>
    n.children.length ? n.children.flatMap(leaves) : n.sched ? [n] : [];
  const mark = (n: PlanNode) => {
    if (n.crit) return;
    n.crit = true;
    for (const { p, rel } of n.drivers ?? [])
      for (const l of leaves(p))
        if (rel[0] === 'E' ? l.sched!.e === p.sched!.e : l.sched!.s === p.sched!.s) mark(l);
  };
  done.filter((r) => !r.children.length && r.sched!.e === end).forEach(mark);
}

// Datum jeder Spalte 0..n-1. Mit workdays nur Mo–Fr (Start am Wochenende -> nächster Montag).
// shortcut: Feiertage zählen als Werktage; bei Bedarf hier eine Feiertagsliste überspringen.
export function calendar(start: Date, n: number, workdays: boolean): Date[] {
  const out: Date[] = [];
  for (const d = new Date(start); out.length < n; d.setDate(d.getDate() + 1))
    if (!workdays || d.getDay() % 6) out.push(new Date(d));
  return out;
}

// Ändert in Zeile `line` die Dauer ("5d") oder den festen Start ("ab Tag N", value 0-basiert);
// null entfernt das Feld. Rest der Zeile (Einrückung, ">", andere Felder) bleibt unverändert.
export function editLine(
  text: string,
  line: number,
  key: 'dur' | 'min',
  value: number | null,
): string {
  const lines = text.split('\n');
  const [, head, rest] = lines[line].match(/^(\s*(?:>\s*)?)(.*)$/)!;
  const [name, ...fields] = rest.split('|').map((s) => s.trim());
  const i = fields.findIndex((f) => (key === 'dur' ? DUR : AB).test(f));
  const val = value == null ? null : key === 'dur' ? `${value}d` : `ab Tag ${value + 1}`;
  if (val == null) {
    if (i >= 0) fields.splice(i, 1);
  } else if (i >= 0) fields[i] = val;
  else fields.push(val);
  lines[line] = head + [name, ...fields].join(' | ');
  return lines.join('\n');
}

// ---------- JSON ----------
export interface PlanData {
  name: string;
  person?: string;
  paket?: boolean;
  dauer?: number;
  abTag?: number;
  nach?: string[];
  kinder?: PlanData[];
}

// Baum -> reine Daten (ohne parent/sched usw.), leere Felder weglassen
export const toData = (n: PlanNode): PlanData => ({
  name: n.name,
  ...(n.person && { person: n.person }),
  ...(n.pkg && { paket: true }),
  ...(n.dur != null && { dauer: n.dur }),
  ...(n.min != null && { abTag: n.min + 1 }),
  ...(n.after.length && { nach: n.after }),
  ...(n.children.length && { kinder: n.children.map(toData) }),
});

// Daten -> Eingabetext; prüft die Struktur, weil die Datei von überall kommen kann
export function toText(items: unknown, depth = 0): string {
  if (!Array.isArray(items)) throw new Error('"kinder" bzw. "plan" muss eine Liste sein');
  return items
    .map((it) => {
      if (!it || typeof it.name !== 'string' || !it.name.trim())
        throw new Error('Jeder Eintrag braucht einen "name"');
      if (it.dauer != null && !(Number.isInteger(it.dauer) && it.dauer >= 0))
        throw new Error(`"${it.name}": dauer muss eine ganze Zahl ≥ 0 sein`);
      if (it.abTag != null && !(Number.isInteger(it.abTag) && it.abTag >= 1))
        throw new Error(`"${it.name}": abTag muss eine ganze Zahl ≥ 1 sein`);
      const clean = (s: unknown) =>
        String(s)
          .replace(/\s*[|\n\t]\s*/g, ' ')
          .trim(); // | und Umbrüche würden die Zeile zerlegen
      const fields = [clean(it.name)];
      if (it.person) fields.push(clean(it.person));
      if (it.dauer != null) fields.push(it.dauer + 'd');
      if (it.abTag != null) fields.push(`ab Tag ${it.abTag}`);
      if (Array.isArray(it.nach) && it.nach.length)
        fields.push('nach ' + it.nach.map(clean).join(', '));
      const line = '\t'.repeat(depth) + (it.paket ? '> ' : '') + fields.join(' | ');
      return it.kinder?.length ? line + '\n' + toText(it.kinder, depth + 1) : line;
    })
    .join('\n');
}

export const SAMPLE = `Projektleitung | Toni Teilzeit
\tAnalyse
\t\t> Anforderungen aufnehmen | 3d
\t\t> Lastenheft | 2d | nach 1.1.1
\tTeilprojekt | Karl Klammer | nach 1.1
\t\tEntwurf | 4d
\t\tUmsetzung | nach 1.2.1
\t\t\t> Paket A | 5d
\t\t\t> Paket B | 3d
\t\t\t> Paket C | 4d | nach 1.2.2.2
\t\t\t> Paket D | 2d | nach 1.2.2.1
\t\tTest | 3d | nach 1.2.2
\tAbschluss | nach 1.2
\t\t> Abnahme | 1d
\t\t> Doku | 2d
\t\t> Projektende | 0d | nach 1.3.1, 1.3.2`;
