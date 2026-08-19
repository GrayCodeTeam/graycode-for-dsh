import { useEffect, useState } from 'react'
import type { CSSProperties, ChangeEvent, ReactNode } from 'react'
import {
  BACKGROUND_IMAGE_MAX_BYTES,
  loadBackgroundAppearance,
  MIN_UI_OPACITY,
  readBackgroundFile,
  setBackgroundImage,
  setUiOpacity,
  validateBackgroundFile,
} from '../appearance/background.ts'
import type { GcTranslate } from './fields.tsx'
import { buttonStyle, sectionDescriptionStyle, sectionStyle, sectionTitleStyle, tokens } from './styles.ts'

const previewStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 5',
  margin: '10px 0',
  border: `1px solid ${tokens.border}`,
  borderRadius: '10px',
  backgroundColor: tokens.bgSubtle,
  backgroundPosition: 'center',
  backgroundRepeat: 'no-repeat',
  backgroundSize: 'cover',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '8px',
}

const rangeStyle: CSSProperties = { flex: '1 1 240px', minWidth: '160px' }
const errorStyle: CSSProperties = { margin: '8px 0 0', color: tokens.danger, fontSize: '12px' }
const noteStyle: CSSProperties = { color: tokens.fgMuted, fontSize: '12px' }

export function BackgroundAppearanceSection({ t }: { t: GcTranslate }): ReactNode {
  const [appearance, setAppearance] = useState(loadBackgroundAppearance)
  const [error, setError] = useState('')

  useEffect(() => {
    const refresh = (): void => setAppearance(loadBackgroundAppearance())
    window.addEventListener('graycode:appearance-change', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('graycode:appearance-change', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file === undefined) return
    const issue = validateBackgroundFile(file)
    if (issue !== null) {
      setError(t(`appearance.error.${issue}`))
      return
    }
    try {
      setBackgroundImage(await readBackgroundFile(file))
      setAppearance(loadBackgroundAppearance())
      setError('')
    } catch {
      setError(t('appearance.error.store'))
    }
  }

  const changeOpacity = (value: string): void => {
    try {
      setUiOpacity(Number(value))
      setAppearance(loadBackgroundAppearance())
      setError('')
    } catch {
      setError(t('appearance.error.store'))
    }
  }

  const clear = (): void => {
    try {
      setBackgroundImage(null)
      setAppearance(loadBackgroundAppearance())
      setError('')
    } catch {
      setError(t('appearance.error.store'))
    }
  }

  return (
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('pages.appearance.title')}</h3>
      <p style={sectionDescriptionStyle}>{t('pages.appearance.description')}</p>
      <div
        style={{
          ...previewStyle,
          ...(appearance.backgroundImage === null ? {} : { backgroundImage: `url("${appearance.backgroundImage}")` }),
        }}
        role="img"
        aria-label={t('appearance.preview')}
      />
      <div style={rowStyle}>
        <label style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center' }}>
          {t('appearance.upload')}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            style={{ display: 'none' }}
            onChange={event => void upload(event)}
          />
        </label>
        <button type="button" style={buttonStyle} disabled={appearance.backgroundImage === null} onClick={clear}>
          {t('appearance.clear')}
        </button>
        <span style={noteStyle}>{t('appearance.fileHint').replace('{size}', String(BACKGROUND_IMAGE_MAX_BYTES / 1024 / 1024))}</span>
      </div>
      <label>
        <span>{t('appearance.opacity')}: {Math.round(appearance.uiOpacity * 100)}%</span>
        <div style={rowStyle}>
          <input
            type="range"
            min={MIN_UI_OPACITY}
            max={1}
            step={0.01}
            value={appearance.uiOpacity}
            style={rangeStyle}
            onChange={event => changeOpacity(event.currentTarget.value)}
          />
          <button type="button" style={buttonStyle} onClick={() => changeOpacity('1')}>
            {t('appearance.opaque')}
          </button>
        </div>
        <span style={noteStyle}>{t('appearance.opacity.description')}</span>
      </label>
      {error.length > 0 && <p style={errorStyle}>{error}</p>}
    </section>
  )
}
