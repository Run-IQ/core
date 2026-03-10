export function canonicalStringify(obj: unknown): string | undefined {
  if (obj === undefined) return undefined;
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (obj instanceof Date) {
    return JSON.stringify(obj.toISOString());
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((o: unknown) => canonicalStringify(o) ?? 'null').join(',') + ']';
  }

  // justification: validated above — obj is a non-null, non-array object
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    '{' +
    keys
      .map((k) => {
        const val = canonicalStringify(record[k]);
        if (val === undefined) return null;
        return `"${k}":${val}`;
      })
      .filter((v) => v !== null)
      .join(',') +
    '}'
  );
}
