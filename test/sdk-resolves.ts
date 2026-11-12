/** True when the installed OpenClaw exports this specifier (module mocks need it to resolve). */
export function sdkSubpathResolves(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
