export function phoneSearchNumber(query: string): string | null {
  const value = query.trim();
  const compact = value.replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^[+\d\s().-]+$/.test(value) && /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}
