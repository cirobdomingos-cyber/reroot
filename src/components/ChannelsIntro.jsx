
// What a canal is, for someone landing on the tab.
//
// The word is doing a lot of work since the Sep 2026 rename: the same
// noun covers a feed auê curates and a private crew you invite friends
// into. Someone arriving cold has no way to know that from the list
// alone, and the two rows look similar by design.
//
// Shown only while the person follows no auê channel. Following one is
// the moment the concept landed, so the explainer disappears by being
// outgrown rather than by being dismissed — which needs no stored
// state, and can't get stuck hidden for someone who still hasn't got
// it. Someone with private channels of their own still sees it, on
// purpose: they know what a crew is, not that auê runs channels too.
// No sign-in prompt here on purpose: the channel list and the groups
// list below each render their own, and three asks stacked down one
// screen is how a landing page reads as a paywall.
export default function ChannelsIntro({ followedCount, loading }) {
  // Wait for the real number rather than flashing the explainer at
  // someone who already follows something.
  if (loading) return null
  if (followedCount > 0) return null

  return (
    <div style={{
      margin: '4px 16px 14px',
      padding: '16px 16px 14px',
      borderRadius: 16,
      border: '1px solid var(--line)',
      background: 'var(--bg2)',
    }}>
      <div className="neon-mono" style={{
        fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: 'var(--lime)', marginBottom: 8,
      }}>
        O que é um canal
      </div>

      <p style={{
        fontSize: 14, lineHeight: 1.55, color: 'var(--text)',
        margin: '0 0 14px',
      }}>
        Uma coleção de rolês que alguém mantém. Você segue, e o que entra
        aparece aqui — sem precisar caçar no meio de tudo.
      </p>

      {/* The two kinds, side by side. They share a word and differ in
          shape, so the difference has to be shown rather than named:
          followers vs. members, open vs. invite. */}
      <Kind
        badge="auê"
        badgeBg="var(--magenta)"
        title="Canais do auê"
        body="A gente separa por gênero e vibe — rock, samba, eletrônica. É só seguir, e dá pra parar quando quiser."
      />
      <Kind
        badge="🔒 privado"
        badgeBg="var(--cyan)"
        title="Canais privados"
        body="Pra tua turma combinar o que fazer. Só entra quem for convidado."
      />

    </div>
  )
}

function Kind({ badge, badgeBg, title, body }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
      <span style={{
        flexShrink: 0, marginTop: 2,
        minWidth: 26, height: 18, padding: '0 6px', borderRadius: 7,
        background: badgeBg,
        color: 'var(--bg)',
        fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {badge}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)',
        }}>
          {title}
        </span>
        <span style={{
          display: 'block', fontSize: 12.5, color: 'var(--text2)',
          lineHeight: 1.5, marginTop: 2,
        }}>
          {body}
        </span>
      </span>
    </div>
  )
}
