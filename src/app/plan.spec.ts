import { calendar, editLine, flatten, parse, SAMPLE, schedule, toData, toText } from './plan';

const days = (start: string, n: number, workdays: boolean) =>
  calendar(new Date(start + 'T00:00'), n, workdays).map((d) => d.getDate());

describe('calendar', () => {
  it('zählt Kalendertage durch', () => {
    expect(days('2026-11-27', 4, false)).toEqual([27, 28, 29, 30]); // Fr, Sa, So, Mo
  });
  it('überspringt im Werktage-Modus das Wochenende', () => {
    expect(days('2026-11-27', 3, true)).toEqual([27, 30, 1]); // Fr, Mo, Di
    expect(days('2026-11-28', 1, true)).toEqual([30]); // Start Samstag -> Montag
  });
});

const plan = (text: string) => {
  const rows = flatten(parse(text));
  schedule(rows);
  return (c: string) => rows.find((r) => r.code === c)!;
};

describe('plan', () => {
  it('parst Ebenen, Pakete und Felder', () => {
    const t = parse(SAMPLE);
    const pk = t[0].children[1].children[1].children;
    expect(t.length).toBe(1);
    expect(t[0].person).toBe('Toni Teilzeit');
    expect(t[0].pkg).toBe(false);
    expect(pk.length).toBe(4);
    expect(pk[0].pkg && pk[0].name).toBe('Paket A');
  });

  it('übersteht die JSON-Rundreise', () => {
    expect(toText(JSON.parse(JSON.stringify(parse(SAMPLE).map(toData))))).toBe(SAMPLE);
  });

  it('plant das Beispiel', () => {
    const at = plan(SAMPLE);
    expect(at('1.2.2').sched).toEqual({ s: 9, e: 16 });
    expect(at('1.2.3').sched!.s).toBe(16);
    expect(at('1.3.3').sched!.s).toBe(21);
    expect(at('1').sched!.e).toBe(21);
  });

  it('kennt EE, AA und AE', () => {
    const at = plan(
      'P\n\tA | 3d\n\tB | 2d | nach 1.1 EE\n\tC | 1d | nach 1.1 AA, 1.2\n\tD | 1d | nach 1.3 AE',
    );
    expect(at('1.2').sched).toEqual({ s: 1, e: 3 }); // B endet mit A
    expect(at('1.3').sched!.s).toBe(3);
    expect(at('1.4').sched!.s).toBe(2);
    expect(at('1.2').after[0]).toBe('1.1 EE');
  });

  it('beginnt nie vor Projektstart', () => {
    expect(plan('A | 1d\nB | 5d | nach 1 EE')('2').sched).toEqual({ s: 0, e: 5 });
  });

  it('findet den kritischen Pfad (auch parallele Ketten)', () => {
    const at = plan(SAMPLE);
    const leaves = [
      '1.1.1',
      '1.1.2',
      '1.2.1',
      '1.2.2.1',
      '1.2.2.2',
      '1.2.2.3',
      '1.2.2.4',
      '1.2.3',
      '1.3.2',
      '1.3.3',
    ];
    for (const c of leaves) expect(at(c).crit, c).toBe(true);
    expect(at('1.3.1').crit).toBeFalsy(); // Abnahme hat Puffer
  });

  it('meldet Fehler', () => {
    expect(() => plan('A | 1d | nach 9')).toThrow('gibt es nicht');
    expect(() => plan('A | 1d | nach 2\nB | 1d | nach 1')).toThrow('Zirkulär');
  });

  it('kennt "ab Tag" als festen Start', () => {
    const at = plan('A | 3d\nB | 2d | nach 1 | ab Tag 6\nC | 1d | nach 2');
    expect(at('2').sched).toEqual({ s: 5, e: 7 });
    expect(at('2').base).toBe(3); // ohne "ab Tag" ginge es ab Tag 4
    expect(at('2').early).toBe(false);
    expect(at('2').crit && at('3').crit).toBe(true);
    expect(at('1').crit).toBeFalsy(); // fester Termin: Pfad endet bei B
  });

  it('erlaubt "ab Tag" auch vor dem Vorgänger', () => {
    const at = plan('A | 3d\nB | 2d | nach 1 | ab 2\nC | 1d | nach 2');
    expect(at('2').sched).toEqual({ s: 1, e: 3 });
    expect(at('2').early).toBe(true);
    expect(at('3').sched!.s).toBe(3); // Nachfolger folgt dem verschobenen B
  });

  it('übernimmt "ab Tag" in JSON', () => {
    const text = 'A | 3d | ab Tag 4 | nach 2\nB | 1d';
    expect(toText(JSON.parse(JSON.stringify(parse(text).map(toData))))).toBe(text);
  });
});

describe('editLine', () => {
  const text = 'P\n\t> Paket A | Karl | 5d | nach 1.2\n\tB';
  it('ersetzt die Dauer', () => {
    expect(editLine(text, 1, 'dur', 7)).toBe('P\n\t> Paket A | Karl | 7d | nach 1.2\n\tB');
  });
  it('fügt "ab Tag" hinzu, ändert und entfernt es', () => {
    const a = editLine(text, 1, 'min', 3);
    expect(a.split('\n')[1]).toBe('\t> Paket A | Karl | 5d | nach 1.2 | ab Tag 4');
    expect(editLine(a, 1, 'min', 5).split('\n')[1]).toContain('| ab Tag 6');
    expect(editLine(a, 1, 'min', null)).toBe(text);
  });
  it('trifft die richtige Zeile', () => {
    expect(parse(text)[0].children[1].line).toBe(2);
    expect(editLine(text, 2, 'dur', 2)).toBe('P\n\t> Paket A | Karl | 5d | nach 1.2\n\tB | 2d');
  });
});
