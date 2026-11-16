/** Keys are relative slash-separated paths of safe characters, with no empty, `.` or `..` segments. */
export function assertValidKey(key: string): void {
  const ok =
    key.length > 0 &&
    key.length <= 512 &&
    /^[A-Za-z0-9._\-/]+$/.test(key) &&
    key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
  if (!ok) throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
}
