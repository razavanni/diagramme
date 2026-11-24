import { Component, computed, effect, ElementRef, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toPng } from 'html-to-image';
import {
  calendar,
  editLine,
  flatten,
  parse,
  PlanNode,
  SAMPLE,
  schedule,
  toData,
  toText,
} from './plan';

type Show = { sum: boolean; ap: boolean; ms: boolean; person: boolean; crit: boolean };
// Baum für die PSP-Ansicht: Pakete (">" oder unter einem Paket) untereinander, Rest nebeneinander
interface TreeItem {
  n: PlanNode;
  code: string;
  level: number;
  vert: TreeItem[];
  horiz: TreeItem[];
}

const load = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString()
  .slice(0, 10);
const fmt = (d: Date) =>
  d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function tree(n: PlanNode, code: string, inVert: boolean): TreeItem {
  const kids = n.children.map((c, i) => ({
    v: inVert || c.pkg,
    it: tree(c, `${code}.${i + 1}`, inVert || c.pkg),
  }));
  return {
    n,
    code,
    level: code.split('.').length - 1,
    vert: kids.filter((k) => k.v).map((k) => k.it),
    horiz: kids.filter((k) => !k.v).map((k) => k.it),
  };
}

@Component({
  selector: 'app-root',
  imports: [NgTemplateOutlet],
  templateUrl: './app.html',
})
export class App {
  readonly text = signal(load('psp-input') ?? SAMPLE);
  readonly start = signal(load('psp-start') || today);
  readonly view = signal<'psp' | 'gantt'>(load('psp-view') === 'gantt' ? 'gantt' : 'psp');
  readonly show = signal<Show>({
    sum: true,
    ap: true,
    ms: true,
    person: true,
    crit: true,
    ...this.loadShow(),
  });
  // Dauern in Werktagen, Wochenenden verschwinden aus der Zeitachse
  readonly workdays = signal(load('psp-workdays') === 'true');
  readonly width = signal(+(load('psp-editor-width') ?? 340) || 340);
  readonly dragging = signal(false);
  readonly showOpts: [keyof Show, string][] = [
    ['sum', 'Sammelbalken'],
    ['ap', 'Arbeitspakete'],
    ['ms', 'Meilensteine'],
    ['person', 'Verantwortliche'],
    ['crit', 'Kritischer Pfad'],
  ];
  private readonly out = viewChild.required<ElementRef<HTMLElement>>('out');

  readonly tree = computed(() => parse(this.text()).map((n, i) => tree(n, `${i + 1}`, false)));

  readonly gantt = computed(() => {
    const all = flatten(parse(this.text()));
    try {
      schedule(all);
    } catch (err) {
      return { msg: '⚠ ' + (err as Error).message };
    }
    if (!all.some((r) => r.sched))
      return { msg: 'Noch keine Dauern eingetragen. Beispiel: > Paket A | Karl | 3d | nach 1.1' };
    const show = this.show();
    const days = Math.max(...all.filter((r) => r.sched).map((r) => r.sched!.e), 1); // Zeitachse immer fürs ganze Projekt
    // +1: Meilenstein am Projektende braucht ein Datum für Spalte "days"
    const cal = calendar(new Date((this.start() || today) + 'T00:00'), days + 1, this.workdays());
    const unit = this.workdays() ? 'Werktage' : 'Tage';
    const rows = all.filter((r) => show[r.children.length ? 'sum' : r.dur === 0 ? 'ms' : 'ap']);
    if (!rows.length)
      return { msg: 'Alle Zeilen sind ausgeblendet – mindestens einen Haken links setzen.' };
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '600 13px system-ui, sans-serif';
    const width = (t?: string) => (t ? ctx.measureText(t).width : 0);
    const IND = 14,
      DW = 26,
      RH = 30,
      HH = 54;
    const codeW = Math.max(...rows.map((r) => width(r.code))) + 20;
    const nameW = Math.max(...rows.map((r) => width(r.name) + r.depth! * IND)) + 24;
    const X0 = codeW + nameW,
      H = HH + rows.length * RH;
    const W =
      X0 + days * DW + (show.person ? Math.max(...rows.map((r) => width(r.person))) : 0) + 24;
    return {
      W,
      H,
      HH,
      DW,
      RH,
      X0,
      codeW,
      IND,
      xEnd: X0 + days * DW,
      person: show.person,
      anyEarly: rows.some((r) => r.early),
      days: cal.slice(0, days).map((d, i) => ({
        x: X0 + i * DW,
        we: d.getDay() % 6 === 0,
        date: d.getDate(),
        wd: d.toLocaleDateString('de-DE', { weekday: 'short' }).slice(0, 2),
        // neuer Monat/Woche: stärkere Linie (im Werktage-Modus fehlt evtl. der 1. des Monats)
        month:
          i === 0 || d.getMonth() !== cal[i - 1].getMonth()
            ? d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
            : '',
        week: i > 0 && d.getDay() === 1,
      })),
      rows: rows.map((r, k) => {
        const y = HH + k * RH,
          sc = r.sched;
        const x1 = sc ? X0 + sc.s * DW : 0,
          x2 = sc ? X0 + sc.e * DW : 0,
          n = sc ? sc.e - sc.s : 0,
          m = y + RH / 2;
        return {
          r,
          y,
          m,
          x1,
          x2,
          kind: !sc ? null : !n ? 'ms' : r.children.length ? 'sum' : 'bar',
          crit: show.crit && !!r.crit,
          early: !!r.early,
          sumPath: `M${x1} ${m - 5}H${x2}V${m + 6}l-5 -5H${x1 + 5}l-5 5Z`,
          msPoints: `${x1},${m - 8} ${x1 + 8},${m} ${x1},${m + 8} ${x1 - 8},${m}`,
          tip: !sc
            ? ''
            : `${r.name}: ${n ? `${fmt(cal[sc.s])} – ${fmt(cal[sc.e - 1])} (${n} ${unit})` : fmt(cal[sc.s])}${r.crit ? ' – kritisch' : ''}${r.early ? ' – ⚠ früher, als die Vorgänger erlauben' : ''}`,
        };
      }),
    };
  });

  constructor() {
    effect(() => {
      save('psp-input', this.text());
      save('psp-start', this.start());
      save('psp-view', this.view());
      save('psp-show', JSON.stringify(this.show()));
      save('psp-workdays', String(this.workdays()));
      save('psp-editor-width', String(this.width()));
    });
  }

  private loadShow(): Partial<Show> {
    try {
      return JSON.parse(load('psp-show') ?? '{}') || {};
    } catch {
      return {};
    }
  }

  toggle(k: keyof Show, on: boolean) {
    this.show.update((s) => ({ ...s, [k]: on }));
  }

  // Tab = eine Ebene tiefer, Shift+Tab = höher (auch für markierte Zeilen)
  onKey(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = e.target as HTMLTextAreaElement;
    const v = ta.value,
      s = ta.selectionStart,
      en = ta.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    if (e.shiftKey)
      ta.setRangeText(v.slice(lineStart, en).replace(/^\t/gm, ''), lineStart, en, 'select');
    else if (s === en) ta.setRangeText('\t', s, en, 'end');
    else ta.setRangeText(v.slice(lineStart, en).replace(/^/gm, '\t'), lineStart, en, 'select');
    this.text.set(ta.value);
  }

  // Gantt-Balken ziehen: "move" setzt "ab Tag N" – überallhin, auch vor Vorgänger (entfernt es, wenn der
  // Balken genau auf seinem Platz laut Abhängigkeiten landet),
  // "size" ändert die Dauer. Der Text wird bei jedem Spaltenwechsel neu geschrieben, dadurch rücken
  // abhängige Pakete und der kritische Pfad live mit.
  dragBar(e: PointerEvent, r: PlanNode, mode: 'move' | 'size', DW: number) {
    if (e.button !== 0 || !r.sched) return;
    e.preventDefault();
    const text0 = this.text(),
      x0 = e.clientX,
      { s } = r.sched,
      d = r.dur ?? 0,
      base = r.base ?? 0;
    document.documentElement.style.cursor = mode === 'size' ? 'ew-resize' : 'grabbing';
    const move = (ev: PointerEvent) => {
      const du = Math.round((ev.clientX - x0) / DW);
      if (!du) return this.text.set(text0); // nur Klick: Text nicht umformatieren
      this.text.set(
        mode === 'size'
          ? editLine(text0, r.line, 'dur', Math.max(1, d + du))
          : editLine(text0, r.line, 'min', Math.max(0, s + du) === base ? null : Math.max(0, s + du)),
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener(
      'pointerup',
      () => {
        window.removeEventListener('pointermove', move);
        document.documentElement.style.cursor = '';
      },
      { once: true },
    );
  }

  // Trennleiste: Eingabebereich per Ziehen breiter/schmaler machen (min/max-width begrenzt per CSS)
  startDrag(e: MouseEvent) {
    e.preventDefault(); // kein Text markieren beim Ziehen
    this.dragging.set(true);
    const move = (ev: MouseEvent) => this.width.set(Math.round(ev.clientX));
    window.addEventListener('mousemove', move);
    window.addEventListener(
      'mouseup',
      () => {
        window.removeEventListener('mousemove', move);
        this.dragging.set(false);
      },
      { once: true },
    );
  }

  // ganzen Baum (auch den weggescrollten Teil) als PNG herunterladen
  async saveImage() {
    const el = this.out().nativeElement.firstElementChild as HTMLElement;
    try {
      const url = await toPng(el, {
        pixelRatio: 2,
        backgroundColor: getComputedStyle(this.out().nativeElement).backgroundColor,
        width: el.scrollWidth,
        height: el.scrollHeight,
      });
      this.download(url, this.view() === 'gantt' ? 'gantt.png' : 'projektstrukturplan.png');
    } catch (err) {
      alert('Bild konnte nicht erstellt werden: ' + err);
    }
  }

  exportJson() {
    const data = {
      projektstart: this.start(),
      nurWerktage: this.workdays(),
      plan: parse(this.text()).map(toData),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    this.download(url, 'projekt.json');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async importJson(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = ''; // gleiche Datei nochmal wählbar
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const text = toText(data.plan);
      if (
        this.text().trim() &&
        !confirm('Die aktuelle Eingabe wird durch die importierte Datei ersetzt. Fortfahren?')
      )
        return;
      this.text.set(text);
      if (/^\d{4}-\d{2}-\d{2}$/.test(data.projektstart)) this.start.set(data.projektstart);
      if (typeof data.nurWerktage === 'boolean') this.workdays.set(data.nurWerktage);
    } catch (err) {
      alert('Import fehlgeschlagen: ' + (err as Error).message);
    }
  }

  private download(href: string, name: string) {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
  }
}
