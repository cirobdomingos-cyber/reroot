import { useState, useEffect } from 'react'

function useCurrentTime() {
  const [time, setTime] = useState(() => {
    const now = new Date()
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  })

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setTime(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
    }
    // Sync to the next full minute, then run every 60s
    const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000
    const timeout = setTimeout(() => {
      tick()
      const interval = setInterval(tick, 60_000)
      return () => clearInterval(interval)
    }, msUntilNextMinute)
    return () => clearTimeout(timeout)
  }, [])

  return time
}

export default function StatusBar({ dark = false }) {
  const cls = dark ? 'status-bar status-bar--dark' : 'status-bar status-bar--light'
  const time = useCurrentTime()

  // Neon Boteco status bar: mono cyan time on the left, mono "SIG"
  // indicator on the right (replaces the signal/wifi/battery SVGs of the
  // light-mode chrome). This is desktop-preview only — the @media block
  // in globals.css hides it on real phones where the OS status bar
  // already shows the real values.
  return (
    <div className={cls}>
      <span className="status-time">{time}</span>
      <span className="neon-mono" style={{
        fontSize: 10, letterSpacing: '0.16em',
        color: 'var(--text3)',
      }}>
        SIG ▮▮▮ ▱
      </span>
    </div>
  )
}
