import { expect, mock, test } from 'bun:test'

import { createOperations } from '../demo/src/operations'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup() {
  const first = { disabled: false }
  const second = { disabled: false }
  let supported = true
  const onStart = mock((_label: string) => {})
  const onSuccess = mock((_label: string, _value: unknown) => {})
  const onError = mock((_label: string, _error: unknown) => {})
  const operations = createOperations({
    onStart,
    onSuccess,
    onError,
    onSettled: updateControls,
  })
  function updateControls() {
    for (const button of [first, second])
      button.disabled = !supported || operations.isBusy(button)
  }
  return {
    first,
    second,
    operations,
    onStart,
    onSuccess,
    onError,
    updateControls,
    setSupported(value: boolean) {
      supported = value
    },
  }
}

test('invokes the task in the original synchronous turn and locks before invocation', async () => {
  const { first, operations, onSuccess } = setup()
  const waiting = deferred<string>()
  let invoked = false
  const running = operations.execute(
    'open',
    () => {
      invoked = true
      expect(first.disabled).toBe(true)
      expect(operations.isBusy(first)).toBe(true)
      return waiting.promise
    },
    first
  )
  expect(invoked).toBe(true)
  expect(onSuccess).not.toHaveBeenCalled()
  waiting.resolve('opened')
  await running
  expect(onSuccess).toHaveBeenCalledWith('open', 'opened')
  expect(first.disabled).toBe(false)
})

test('control refresh and another button finishing cannot unlock pending work', async () => {
  const { first, second, operations, updateControls } = setup()
  const waiting = deferred<string>()
  const running = operations.execute('save', () => waiting.promise, first)
  updateControls()
  expect(first.disabled).toBe(true)
  await operations.execute('read', () => 'value', second)
  expect(second.disabled).toBe(false)
  expect(first.disabled).toBe(true)
  expect(operations.isBusy(first)).toBe(true)
  waiting.resolve('saved')
  await running
  expect(first.disabled).toBe(false)
})

test('duplicate clicks and form submits are skipped even if disabled is changed externally', async () => {
  const { first, operations, onStart } = setup()
  const waiting = deferred<string>()
  const task = mock(() => waiting.promise)
  const running = operations.execute('save', task, first)
  await operations.execute('save', task, first)
  first.disabled = false
  await operations.execute('save', task, first)
  expect(task).toHaveBeenCalledTimes(1)
  expect(onStart).toHaveBeenCalledTimes(1)
  waiting.resolve('saved')
  await running
})

test('disabled capability or managed-storage buttons do not start operations', async () => {
  const { first, operations, onStart, setSupported, updateControls } = setup()
  setSupported(false)
  updateControls()
  const task = mock(() => 'unexpected')
  await operations.execute('save', task, first)
  expect(task).not.toHaveBeenCalled()
  expect(onStart).not.toHaveBeenCalled()
})

test('completion applies the current capability or selected storage area', async () => {
  const { first, operations, setSupported, updateControls } = setup()
  const waiting = deferred<string>()
  const running = operations.execute('save', () => waiting.promise, first)
  setSupported(false)
  updateControls()
  waiting.resolve('saved')
  await running
  expect(operations.isBusy(first)).toBe(false)
  expect(first.disabled).toBe(true)
  setSupported(true)
  updateControls()
  expect(first.disabled).toBe(false)
})

test('synchronous failures and rejected promises release busy state and report errors', async () => {
  for (const asynchronous of [false, true]) {
    const { first, operations, onSuccess, onError } = setup()
    const error = new Error('failed')
    await operations.execute(
      'operation',
      () => {
        if (asynchronous) return Promise.reject(error)
        throw error
      },
      first
    )
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('operation', error)
    expect(operations.isBusy(first)).toBe(false)
    expect(first.disabled).toBe(false)
    await operations.execute('retry', () => 'ok', first)
    expect(onSuccess).toHaveBeenCalledWith('retry', 'ok')
  }
})

test('a failed operation does not unlock another pending operation', async () => {
  const { first, second, operations } = setup()
  const waiting = deferred<string>()
  const running = operations.execute('pending', () => waiting.promise, first)
  const failure = deferred<string>()
  const failing = operations.execute('fail', () => failure.promise, second)
  failure.reject(new Error('failed'))
  await failing
  expect(first.disabled).toBe(true)
  expect(second.disabled).toBe(false)
  waiting.resolve('done')
  await running
})
