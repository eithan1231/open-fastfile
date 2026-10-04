// A compile-time guard for state that is handed out to be read, not changed.

/**
 * `Readonly<T>` is one level deep, so `Readonly<MovementState>` still permits
 * `movement.feet.x = 1`. This freezes the whole shape instead, at no runtime
 * cost: a caller that needs a value it may keep takes a `snapshot`.
 */
export type DeepReadonly<T> = T extends (infer E)[] ? readonly DeepReadonly<E>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
