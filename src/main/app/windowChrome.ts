import type { BrowserWindow } from 'electron'
import type { WindowChromeState } from '../../shared/windowChrome.ts'

export function readWindowChromeState(win: Pick<BrowserWindow, 'isMaximized'>): WindowChromeState {
  return { maximized: win.isMaximized() }
}

export function installWindowChromePublisher(win: BrowserWindow): () => void {
  const publish = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('window:state-changed', readWindowChromeState(win))
  }
  const dispose = (): void => {
    win.off('maximize', publish)
    win.off('unmaximize', publish)
    win.off('closed', dispose)
  }
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  win.once('closed', dispose)
  return dispose
}
