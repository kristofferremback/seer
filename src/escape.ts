// HTML escaping, kept in a leaf file with no imports of its own so modules that need
// nothing else from the page layer (the constrained markdown parser, for one) stay
// importable without the server's configuration and environment.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
