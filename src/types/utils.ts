type Simplify<T> = {
  [K in keyof T]: T[K]
} & {}

export type DeepAssign<Base, Extra> = Base extends Function
  ? Base
  : Base extends object
    ? Extra extends object
      ? Simplify<
          Omit<Base, keyof Extra> & {
            [K in keyof Extra]: K extends keyof Base
              ? DeepAssign<Base[K], Extra[K]>
              : Extra[K]
          }
        >
      : Base
    : Base

export type DeepOverwrite<Base, Override> = Override extends Function
  ? Override
  : Base extends object
    ? Override extends object
      ? Simplify<
          Omit<Base, keyof Override> & {
            [K in keyof Override]: K extends keyof Base
              ? DeepOverwrite<Base[K], Override[K]>
              : Override[K]
          }
        >
      : Override
    : Override
