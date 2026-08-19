export const BACKGROUND_IMAGE_MAX_BYTES = 3 * 1024 * 1024
export const DEFAULT_UI_OPACITY = 0.92
export const MIN_UI_OPACITY = 0.35

const BACKGROUND_IMAGE_KEY = 'graycode.appearance.background-image.v1'
const UI_OPACITY_KEY = 'graycode.appearance.ui-opacity.v1'
const STYLE_ID = 'graycode-background-appearance'
const CHANGE_EVENT = 'graycode:appearance-change'
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

export interface BackgroundAppearance {
  backgroundImage: string | null
  uiOpacity: number
}

export interface AppearanceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type BackgroundFileIssue = 'unsupported-type' | 'too-large' | null

export function normalizeUiOpacity(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_UI_OPACITY
  return Math.min(1, Math.max(MIN_UI_OPACITY, Math.round(parsed * 100) / 100))
}

export function validateBackgroundFile(file: Pick<File, 'size' | 'type'>): BackgroundFileIssue {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) return 'unsupported-type'
  return file.size > BACKGROUND_IMAGE_MAX_BYTES ? 'too-large' : null
}

export function isBackgroundImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z\d+/=]+$/iu.test(value)
}

function browserStorage(): AppearanceStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function loadBackgroundAppearance(storage = browserStorage()): BackgroundAppearance {
  if (storage === undefined) return { backgroundImage: null, uiOpacity: DEFAULT_UI_OPACITY }
  try {
    const storedImage = storage.getItem(BACKGROUND_IMAGE_KEY)
    return {
      backgroundImage: isBackgroundImageDataUrl(storedImage) ? storedImage : null,
      uiOpacity: normalizeUiOpacity(storage.getItem(UI_OPACITY_KEY)),
    }
  } catch {
    return { backgroundImage: null, uiOpacity: DEFAULT_UI_OPACITY }
  }
}

function notifyAppearanceChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function setBackgroundImage(backgroundImage: string | null, storage = browserStorage()): void {
  if (storage === undefined) throw new Error('Browser storage is unavailable')
  if (backgroundImage !== null && !isBackgroundImageDataUrl(backgroundImage)) {
    throw new Error('Unsupported background image data')
  }
  if (backgroundImage === null) storage.removeItem(BACKGROUND_IMAGE_KEY)
  else storage.setItem(BACKGROUND_IMAGE_KEY, backgroundImage)
  applyBackgroundAppearance(loadBackgroundAppearance(storage))
  notifyAppearanceChanged()
}

export function setUiOpacity(uiOpacity: number, storage = browserStorage()): void {
  if (storage === undefined) throw new Error('Browser storage is unavailable')
  storage.setItem(UI_OPACITY_KEY, String(normalizeUiOpacity(uiOpacity)))
  applyBackgroundAppearance(loadBackgroundAppearance(storage))
  notifyAppearanceChanged()
}

export function readBackgroundFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'))
    reader.onload = () => {
      if (!isBackgroundImageDataUrl(reader.result)) {
        reject(new Error('Unsupported background image data'))
        return
      }
      resolve(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function ensureAppearanceStyle(): HTMLStyleElement | undefined {
  if (typeof document === 'undefined') return undefined
  const current = document.getElementById(STYLE_ID)
  if (current instanceof HTMLStyleElement) return current
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
html[data-graycode-background="on"] {
  background-color: #111;
  background-image: var(--graycode-background-image);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  background-attachment: fixed;
}
html[data-graycode-background="on"] body {
  background: transparent !important;
}
html[data-graycode-background="on"] body > * {
  opacity: var(--graycode-ui-opacity, 1);
}
`
  document.head.append(style)
  return style
}

export function applyBackgroundAppearance(appearance: BackgroundAppearance): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  ensureAppearanceStyle()
  if (appearance.backgroundImage === null) {
    delete root.dataset.graycodeBackground
    root.style.removeProperty('--graycode-background-image')
    root.style.removeProperty('--graycode-ui-opacity')
    return
  }
  root.dataset.graycodeBackground = 'on'
  root.style.setProperty('--graycode-background-image', `url("${appearance.backgroundImage}")`)
  root.style.setProperty('--graycode-ui-opacity', String(normalizeUiOpacity(appearance.uiOpacity)))
}

export function installBackgroundAppearance(storage = browserStorage()): () => void {
  applyBackgroundAppearance(loadBackgroundAppearance(storage))
  if (typeof window === 'undefined') return () => {}
  const refresh = (): void => applyBackgroundAppearance(loadBackgroundAppearance(storage))
  window.addEventListener('storage', refresh)
  window.addEventListener(CHANGE_EVENT, refresh)
  return () => {
    window.removeEventListener('storage', refresh)
    window.removeEventListener(CHANGE_EVENT, refresh)
  }
}
