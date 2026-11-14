/** Keep fixture and measured-element assumptions as runtime test assertions. */
export function requireValue<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error("Expected the test fixture or measured element to exist");
  }
  return value;
}
