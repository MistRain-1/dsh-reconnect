// Минимальный semver для проверки `engines.dsh` без внешних зависимостей.
// Семантика как у DSH: includePrerelease (0.2.2-rc.5 подпадает под >=0.2.2-rc.1).

export function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`bad version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // без prerelease старше любого prerelease
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

/** Поддерживает пересечение сравнений через пробел: ">=0.2.2-rc.1 <0.3.0-0". */
export function satisfies(version, range) {
  return range.trim().split(/\s+/).every((part) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    const op = match[1] || "=";
    const c = compare(version, match[2]);
    return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[op];
  });
}
