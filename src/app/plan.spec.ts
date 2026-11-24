import { flatten, parse, SAMPLE, schedule, toData, toText } from './plan';

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
});
