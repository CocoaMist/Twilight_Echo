import { ref } from 'vue'

export type AppDialogRequest = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  input?: { label: string; value: string }
  informational?: boolean
}
type PendingDialog = AppDialogRequest & { id: number }
const dialog = ref<PendingDialog | null>(null)
const pending: Array<{
  request: PendingDialog
  resolve: (result: string | boolean | null) => void
}> = []
let currentResolve: ((result: string | boolean | null) => void) | null = null
let nextId = 1

function presentNext(): void {
  const next = pending.shift()
  currentResolve = next?.resolve ?? null
  dialog.value = next?.request ?? null
}
function requestDialog(request: AppDialogRequest): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    pending.push({ request: { ...request, id: nextId++ }, resolve })
    if (!dialog.value) presentNext()
  })
}
export async function confirmAction(request: string | AppDialogRequest): Promise<boolean> {
  return (
    (await requestDialog(
      typeof request === 'string'
        ? { title: '确认操作', message: request, confirmLabel: '继续', cancelLabel: '取消' }
        : request
    )) === true
  )
}
export async function promptAction(message: string, value = ''): Promise<string | null> {
  const result = await requestDialog({
    title: '编辑名称',
    message,
    confirmLabel: '保存',
    input: { label: '名称', value }
  })
  return typeof result === 'string' ? result : null
}
export async function informAction(message: string): Promise<void> {
  await requestDialog({ title: '操作结果', message, confirmLabel: '知道了', informational: true })
}
export function useAppDialog() {
  function resolveDialog(result: string | boolean | null): void {
    const resolve = currentResolve
    currentResolve = null
    dialog.value = null
    resolve?.(result)
    presentNext()
  }
  return { dialog, resolveDialog }
}
