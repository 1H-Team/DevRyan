// Minimal type declarations for bun:test to satisfy tsc.
// Only the subset used by our test files is declared.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  interface Matchers<Result = void> {
    toEqual(expected: unknown): Result;
    toMatchObject(expected: unknown): Result;
    toBe(expected: unknown): Result;
    toBeTruthy(): Result;
    toBeFalsy(): Result;
    toBeNull(): Result;
    toBeUndefined(): Result;
    toBeDefined(): Result;
    toThrow(expected?: string | RegExp): Result;
    toContain(expected: unknown): Result;
    toBeGreaterThan(expected: number): Result;
    toBeLessThan(expected: number): Result;
    toHaveLength(expected: number): Result;
    toBeInstanceOf(expected: unknown): Result;
    toHaveBeenCalledTimes(expected: number): Result;
    toHaveBeenCalledWith(...args: unknown[]): Result;
    not: Matchers<Result>;
  }
  export function expect(value: unknown): Matchers & {
    rejects: Matchers<Promise<void>>;
    resolves: Matchers<Promise<void>>;
  };
  type Spy<Fn extends (...args: never[]) => unknown> = Fn & {
    mockImplementation(implementation: Fn): Spy<Fn>;
    mockImplementationOnce(implementation: Fn): Spy<Fn>;
    mockResolvedValue(value: Awaited<ReturnType<Fn>>): Spy<Fn>;
    mockRestore(): void;
  };
  export function spyOn<T extends object, K extends keyof T>(object: T, key: K):
    T[K] extends (...args: never[]) => unknown ? Spy<T[K]> : never;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function mock<T extends (...args: never[]) => unknown>(fn?: T): T;
  export namespace mock {
    function module(moduleName: string, factory: () => Record<string, unknown>): void;
  }
}
