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
export type {
  NamespacedStorageArea,
  StorageArea,
  StorageHelpers,
  WebExtStorage,
} from './storage'
export type {
  MainWorldStorage,
  MainWorldStorageArea,
  MainWorldStorageBridgeOptions,
  MainWorldStorageOptions,
  MainWorldStorageScope,
  StorageAreaName,
} from './storage/main-world'
export type { WebExtTabs } from './tabs'

export { createWebExt, webext } from './core'
export {
  MessageTimeoutError,
  RemoteError,
  UnsupportedOperationError,
} from './errors'
export { createMainWorldMessaging } from './messaging'
export { createMainWorldStorage } from './storage/main-world'
