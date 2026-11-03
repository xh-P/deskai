/** Capture/AEC choices. The WebRTC modes remain experimental until device tests pass. */
export const AEC_MODES = ['off', 'browser', 'browser-ns', 'webrtc', 'webrtc-ns'] as const

export type AecMode = typeof AEC_MODES[number]

/** Preserves the previously shipped Chromium echo cancellation + noise suppression path. */
export const DEFAULT_AEC_MODE: AecMode = 'browser-ns'

export function isAecMode(value: unknown): value is AecMode {
  return typeof value === 'string' && (AEC_MODES as readonly string[]).includes(value)
}

export function aecUsesWebRtc(mode: AecMode): boolean {
  return mode === 'webrtc' || mode === 'webrtc-ns'
}

/** The browser owns these capture switches; the WASM path owns its own NS switch. */
export function aecCaptureOptions(mode: AecMode): {
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: false
} {
  return {
    echoCancellation: mode === 'browser' || mode === 'browser-ns',
    noiseSuppression: mode === 'browser-ns',
    autoGainControl: false,
  }
}

/** This package exposes noise suppression, but no AEC strength control. */
export function aecWasmOptions(mode: AecMode): { noiseSuppression: boolean } {
  return { noiseSuppression: mode === 'webrtc-ns' }
}
