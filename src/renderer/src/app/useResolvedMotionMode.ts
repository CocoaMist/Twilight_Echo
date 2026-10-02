import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { resolveMotionMode, type MotionPreference } from '../../../shared/motion.ts'

export function useResolvedMotionMode(preference: Ref<MotionPreference>) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  const systemReduced = ref(query.matches)
  const update = (): void => {
    systemReduced.value = query.matches
  }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return computed(() => resolveMotionMode(preference.value, systemReduced.value))
}
