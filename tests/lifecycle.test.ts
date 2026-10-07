import { expect, mock, test } from 'bun:test'

import { createDisposables } from '../src/disposables'
import { facade, lazyFacade } from '../src/facade'

test('disposers run once, remove stopped registrations and allow later registration', () => {
  const disposers = createDisposables()
  const first = mock(() => {})
  const second = mock(() => {})
  const stopFirst = disposers.add(first)
  stopFirst()
  stopFirst()
  disposers.add(second)
  disposers.dispose()
  disposers.dispose()
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  const later = mock(() => {})
  disposers.add(later)
  disposers.dispose()
  expect(later).toHaveBeenCalledTimes(1)
})

test('registrations added during cleanup are retained for the next disposal', () => {
  const disposers = createDisposables()
  const later = mock(() => {})
  disposers.add(() => {
    disposers.add(later)
  })
  disposers.dispose()
  expect(later).not.toHaveBeenCalled()
  disposers.dispose()
  expect(later).toHaveBeenCalledTimes(1)
})

test('facades preserve native receivers and cache bindings without modifying their source', () => {
  const symbol = Symbol('native')
  const native = {
    value: 7,
    [symbol]: 'symbol value',
    getValue() {
      return this.value
    },
  }
  const wrapped = facade(native, { extra: true })
  const getValue = wrapped.getValue
  expect(getValue()).toBe(7)
  expect(wrapped.getValue).toBe(getValue)
  const descriptor = Object.getOwnPropertyDescriptor(wrapped, 'getValue')!
  expect(descriptor.get?.()).toBe(getValue)
  const copied = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(wrapped)
  ) as typeof wrapped
  expect(copied.getValue()).toBe(7)
  expect(wrapped[symbol]).toBe('symbol value')
  expect(Reflect.ownKeys(wrapped)).toContain(symbol)
  expect('getValue' in wrapped).toBe(true)
  expect(Object.keys(wrapped)).toContain('extra')
  expect(Object.hasOwn(native, 'extra')).toBe(false)
  native.getValue = function () {
    return this.value * 2
  }
  expect(wrapped.getValue).not.toBe(getValue)
  expect(wrapped.getValue()).toBe(14)
  expect(descriptor.get?.()).toBe(wrapped.getValue)
  expect(copied.getValue()).toBe(14)
})

test('lazy facades initialize only once even when inspected before reading properties', () => {
  const initialize = mock(() => facade({ native: 1 }, { extra: 2 }))
  const wrapped = lazyFacade(initialize)
  expect(initialize).not.toHaveBeenCalled()
  expect(Object.keys(wrapped)).toEqual(['native', 'extra'])
  expect('native' in wrapped).toBe(true)
  expect(wrapped.native).toBe(1)
  expect(Object.getOwnPropertyDescriptor(wrapped, 'extra')?.value).toBe(2)
  expect(initialize).toHaveBeenCalledTimes(1)
})
