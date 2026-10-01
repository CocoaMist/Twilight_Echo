import { onScopeDispose } from 'vue'
const guards = new Set<() => Promise<boolean>>()
let navigating = false
export function registerNavigationGuard(guard: () => Promise<boolean>): void {
  guards.add(guard)
  onScopeDispose(() => guards.delete(guard))
}
export async function navigateWithGuard(action: () => void): Promise<boolean> {
  if (navigating) return false
  navigating = true
  try {
    for (const guard of guards) if (!(await guard())) return false
    action()
    return true
  } finally {
    navigating = false
  }
}
