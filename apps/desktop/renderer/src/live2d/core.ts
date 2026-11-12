let loading: Promise<void> | undefined

export function loadCubismCore(): Promise<void> {
  if ('Live2DCubismCore' in window) return Promise.resolve()
  return loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'deskai://app/live2d/live2dcubismcore.min.js'
    script.onload = () => 'Live2DCubismCore' in window ? resolve() : reject(new Error('Cubism Core 未能初始化。'))
    script.onerror = () => reject(new Error('Cubism Core 未准备。'))
    document.head.appendChild(script)
  }).catch(error => { loading = undefined; throw error })
}
