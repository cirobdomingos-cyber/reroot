/**
 * Aue — inline brand wordmark.
 *
 * Use anywhere "auê" appears as a brand mention inside a sentence (not as
 * a header — Onboarding/Home wordmarks already have their own large
 * treatment). Renders a single styled span so the brand pops out from the
 * surrounding text consistently.
 *
 * Examples:
 *   "Veja de onde vem o catálogo do <Aue />."
 *   "Adicionar como amigo no <Aue />?"
 */
export default function Aue() {
  return (
    <span style={{
      color: 'var(--magenta)',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      letterSpacing: '-0.04em',
      textShadow: '0 0 10px rgba(255, 43, 214, 0.6)',
    }}>
      auê
    </span>
  )
}
