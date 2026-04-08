export default function StatusBar({ dark = false }) {
  const cls = dark ? 'status-bar status-bar--dark' : 'status-bar status-bar--light'
  const color = dark ? 'white' : 'var(--charcoal)'

  return (
    <div className={cls}>
      <span className="status-time">9:41</span>
      <div className="status-icons">
        {/* Signal bars */}
        <svg width="17" height="12" viewBox="0 0 17 12" fill="none">
          <rect x="0"    y="7"   width="3" height="5" rx="1" fill={color}/>
          <rect x="4.5"  y="4.5" width="3" height="7.5" rx="1" fill={color}/>
          <rect x="9"    y="2"   width="3" height="10" rx="1" fill={color}/>
          <rect x="13.5" y="0"   width="3" height="12" rx="1" fill={color} opacity="0.3"/>
        </svg>
        {/* WiFi */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <path d="M8 9.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" fill={color}/>
          <path d="M4.5 7C5.7 5.8 6.8 5.2 8 5.2s2.3.6 3.5 1.8" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
          <path d="M2 4.5C3.8 2.7 5.8 1.8 8 1.8s4.2.9 6 2.7" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
        </svg>
        {/* Battery */}
        <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke={color}/>
          <rect x="2" y="2" width="15" height="8" rx="2" fill={color}/>
          <path d="M23 4v4a2 2 0 000-4z" fill={color} opacity="0.4"/>
        </svg>
      </div>
    </div>
  )
}
