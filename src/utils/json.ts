export function canonicalStringify(obj: any): string | undefined {
  if (obj === undefined) return undefined;
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((o) => canonicalStringify(o) ?? 'null').join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => {
        const val = canonicalStringify(obj[k]);
        if (val === undefined) return null;
        return `"${k}":${val}`;
      })
      .filter((v) => v !== null)
      .join(',') +
    '}'
  );
}
