interface QuitApplication {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/** Give diagnostics a bounded opportunity to drain, then resume Electron's quit. */
export function registerDiagnosticQuit(
  app: QuitApplication,
  drain: () => Promise<void>,
  timeoutMs = 3000
): void {
  let draining = false
  let finished = false
  app.on('will-quit', (event) => {
    if (finished) return
    event.preventDefault()
    if (draining) return
    draining = true
    const resume = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      app.quit()
    }
    // Keep the deadline alive even when all windows and the writer are unreferenced.
    const timer = setTimeout(resume, timeoutMs)
    void Promise.resolve().then(drain).then(resume, resume)
  })
}
