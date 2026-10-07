/// <reference types="chrome" preserve="true" />

export type { WebExtContext } from './context'
export type { CreateWebExtOptions, WebExt } from './core'
export type {
  MainWorldStorage,
  MainWorldStorageArea,
  MainWorldStorageBridgeOptions,
  MainWorldStorageOptions,
  MainWorldStorageScope,
  StorageAreaName,
} from './main-world-storage'
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
export type {
  NamespacedStorageArea,
  StorageArea,
  StorageHelpers,
  WebExtStorage,
} from './storage'
export type { WebExtTabs } from './tabs'

export { createWebExt, webext } from './core'
export {
  MessageTimeoutError,
  RemoteError,
  UnsupportedOperationError,
} from './errors'
export { createMainWorldStorage } from './main-world-storage'
export { createMainWorldMessaging } from './messaging'
