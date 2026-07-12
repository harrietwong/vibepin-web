declare module "vitest" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;

  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeNull(): void;
    toContain(expected: string): void;
  };
}
