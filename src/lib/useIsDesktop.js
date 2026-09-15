import { useEffect, useState } from 'react'

// PC layout breakpoint. Must match the `min-width: 1024px` media query in
// styles/globals.css: CSS handles the shell (sidebar, content width), this
// hook handles the few screens whose *structure* changes on a big screen
// (Home's two-column grid) — inline styles can't be reached by media queries.
export const DESKTOP_QUERY = '(min-width: 1024px)'

export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}
