// kroman (Korean Revised Romanization) has no published TypeScript types.
// Only the one entry point we use — parse(hangul) → hyphenated romaja.
declare module "kroman" {
  export function parse(input: string): string;
  const _default: { parse: typeof parse };
  export default _default;
}
