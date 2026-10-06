/// <reference types="chrome" preserve="true" />

export type { WebExtContext } from './context'
export type { CreateWebExtOptions, WebExt } from './core'
export type {
  MainWorldBridgeOptions,
  MainWorldMessaging,
  MainWorldOptions,
  MessageChannel,
  MessageDefinition,
  MessageSchema,
  MessageSender,
  Messaging,
  SendOptions,
} from './messaging'
export type { PopoutOptions } from './popout'
export type {
  Side,
  SideCapabilities,
  SidePathTarget,
  SideTarget,
} from './side'
export type { StorageArea, StorageHelpers, WebExtStorage } from './storage'
export type { WebExtTabs } from './tabs'

export { createWebExt, webext } from './core'
export {
  MessageTimeoutError,
  RemoteError,
  UnsupportedOperationError,
} from './errors'
export { createMainWorldMessaging } from './messaging'
