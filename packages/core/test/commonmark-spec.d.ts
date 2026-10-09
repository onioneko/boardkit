declare module "commonmark-spec" {
  /** One CommonMark spec example. */
  export interface Example {
    readonly markdown: string;
    readonly html: string;
    readonly section: string;
    readonly number: number;
  }
  /** Every example of the spec. */
  export const tests: readonly Example[];
  /** The spec's own source text. */
  export const text: string;
}
