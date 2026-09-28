// Image naming rule for section shots: "{序号}-{段落}-{镜头}.png", e.g. "4-Pre-Chorus 1-1.png".
//   序号: global order of the shot over the whole song (1-based, in time order)
//   段落: the section label — a name that occurs more than once gets its occurrence number
//         ("Pre-Chorus 1", "Chorus 2"); names that already end in a number ("Verse 1") stay as they are
//   镜头: the shot's index inside its section (1-based)
// Generated images are saved under this name; uploaded/imported ones are renamed to it.

export function sectionLabels(names: string[]): string[] {
  const total = new Map<string, number>(), seen = new Map<string, number>();
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1);
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return total.get(n)! > 1 && !/\d$/.test(n) ? `${n} ${k}` : n;
  });
}

export const ruleName = (g: number, label: string, k: number, ext = 'png') => `${g}-${label}-${k}.${ext}`;

export interface Parsed { g: number; label: string; k: number; ext: string }
export function parseRule(file: string): Parsed | null {
  const m = /^(\d+)-(.+)-(\d+)\.(png|jpe?g|webp)$/i.exec(file.trim());
  return m ? { g: +m[1]!, label: m[2]!.trim(), k: +m[3]!, ext: m[4]!.toLowerCase().replace('jpeg', 'jpg') } : null;
}

/** Loose label comparison: case, spaces and hyphens ignored ("pre-chorus 1" == "PreChorus1"). */
export const sameLabel = (a: string, b: string) => a.toLowerCase().replace(/[\s_-]+/g, '') === b.toLowerCase().replace(/[\s_-]+/g, '');
