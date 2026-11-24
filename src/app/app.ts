import { Component, computed, effect, ElementRef, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toPng } from 'html-to-image';
import { flatten, parse, PlanNode, SAMPLE, schedule, toData, toText } from './plan';

type Show = { sum: boolean; ap: boolean; ms: boolean; person: boolean; crit: boolean };
// Baum für die PSP-Ansicht: Pakete (">" oder unter einem Paket) untereinander, Rest nebeneinander
interface TreeItem {
  n: PlanNode;
  code: string;
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
  readonly width = signal(+(load('psp-editor-width') ?? 340) || 340);
  readonly dragging = signal(false);
  readonly showOpts: [keyof Show, string][] = [
    ['sum', 'Sammelbalken'],
    ['ap', 'Arbeitspakete'],
    ['ms', 'Meilensteine'],
    ['person', 'Verantwortliche'],
    ['crit', 'Kritischer Pfad (rot)'],
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
    const start = new Date((this.start() || today) + 'T00:00');
    const day = (i: number) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    };
    const days = Math.max(...all.filter((r) => r.sched).map((r) => r.sched!.e), 1); // Zeitachse immer fürs ganze Projekt
    const rows = all.filter((r) => show[r.children.length ? 'sum' : r.dur === 0 ? 'ms' : 'ap']);
    if (!rows.length)
      return { msg: 'Alle Zeilen sind ausgeblendet – mindestens einen Haken links setzen.' };
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '600 13px system-ui, sans-serif';
    const width = (t?: string) => (t ? ctx.measureText(t).width : 0);
    const IND = 14,
      DW = 24,
      RH = 26,
      HH = 40;
    const codeW = Math.max(...rows.map((r) => width(r.code))) + 16;
    const nameW = Math.max(...rows.map((r) => width(r.name) + r.depth! * IND)) + 16;
    const X0 = codeW + nameW,
      H = HH + rows.length * RH;
    const W =
      X0 + days * DW + (show.person ? Math.max(...rows.map((r) => width(r.person))) : 0) + 20;
    return {
      W,
      H,
      HH,
      DW,
      RH,
      codeW,
      IND,
      xEnd: X0 + days * DW,
      person: show.person,
      days: Array.from({ length: days }, (_, i) => {
        const d = day(i);
        return {
          x: X0 + i * DW,
          we: d.getDay() % 6 === 0,
          date: d.getDate(),
          month:
            i === 0 || d.getDate() === 1
              ? d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
              : '',
        };
      }),
      rows: rows.map((r, k) => {
        const y = HH + k * RH,
          sc = r.sched;
        const x1 = sc ? X0 + sc.s * DW : 0,
          x2 = sc ? X0 + sc.e * DW : 0,
          n = sc ? sc.e - sc.s : 0;
        return {
          r,
          y,
          x1,
          x2,
          kind: !sc ? null : !n ? 'ms' : r.children.length ? 'sum' : 'bar',
          crit: show.crit && !!r.crit,
          sumPath: `M${x1} ${y + 8}H${x2}V${y + 20}l-6 -6H${x1 + 6}l-6 6Z`,
          msPoints: `${x1},${y + 5} ${x1 + 8},${y + 13} ${x1},${y + 21} ${x1 - 8},${y + 13}`,
          tip: !sc
            ? ''
            : `${r.name}: ${n ? `${fmt(day(sc.s))} – ${fmt(day(sc.e - 1))} (${n} Tage)` : fmt(day(sc.s))}${r.crit ? ' – kritisch' : ''}`,
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
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        width: el.scrollWidth,
        height: el.scrollHeight,
      });
      this.download(url, this.view() === 'gantt' ? 'gantt.png' : 'projektstrukturplan.png');
    } catch (err) {
      alert('Bild konnte nicht erstellt werden: ' + err);
    }
  }

  exportJson() {
    const data = { projektstart: this.start(), plan: parse(this.text()).map(toData) };
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
