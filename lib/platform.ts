export const slash = (path: string, platform = process.platform) =>
  platform === 'win32' ? path.replaceAll('\\', '/') : path

export function below(file: string, root: string, platform = process.platform) {
  const fold = (path: string) => (platform === 'win32' ? path.toLowerCase() : path)
  const base = slash(root, platform).replace(/\/+$/, '')
  const target = slash(file, platform)
  if (fold(target) === fold(base)) return ''
  return fold(target.slice(0, base.length + 1)) === fold(base + '/')
    ? target.slice(base.length + 1)
    : undefined
}

export const inside = (file: string, root: string, platform = process.platform) =>
  below(file, root, platform) !== undefined

export const samePath = (a: string, b: string, platform = process.platform) =>
  below(a, b, platform) === ''

export function notOnWindows(feature: string, platform = process.platform) {
  if (platform === 'win32') throw new Error(`${feature} is not available on Windows yet`)
}
